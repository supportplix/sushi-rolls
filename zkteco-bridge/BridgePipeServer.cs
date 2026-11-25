using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace SushiRolls.ZkTeco
{
    internal sealed class BridgeStatus
    {
        public string State = "idle";
        public string DeviceName;
        public string SerialNumber;
        public string Firmware;
        public string Transport;
        public int? ComPort;
        public string LastSeenAt;
        public string LastSyncAt;
        public int PendingOutbox;
        public string Message;

        public Dictionary<string, object> ToJson()
        {
            return new Dictionary<string, object>
            {
                { "state", State },
                { "deviceName", DeviceName },
                { "serialNumber", SerialNumber },
                { "firmware", Firmware },
                { "transport", Transport },
                { "comPort", ComPort },
                { "lastSeenAt", LastSeenAt },
                { "lastSyncAt", LastSyncAt },
                { "pendingOutbox", PendingOutbox },
                { "message", Message }
            };
        }
    }

    internal sealed class BridgePipeServer : IDisposable
    {
        private const string PipeName = "SushiRolls.ZkTeco";
        private readonly object sync = new object();
        private readonly CancellationTokenSource stop = new CancellationTokenSource();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
        private NamedPipeServerStream server;
        private Task worker;
        private BridgeStatus status = new BridgeStatus();
        private bool disposed;

        private static NamedPipeServerStream CreateServer()
        {
            var security = new PipeSecurity();
            var interactiveUser = WindowsIdentity.GetCurrent().User;
            var configuredSid = BridgeConfig.Load().InteractiveUserSid;
            if (!String.IsNullOrWhiteSpace(configuredSid))
            {
                try { interactiveUser = new SecurityIdentifier(configuredSid); }
                catch (ArgumentException) { }
            }
            security.AddAccessRule(new PipeAccessRule(interactiveUser,
                PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                PipeAccessRights.FullControl, AccessControlType.Allow));
            return new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous, 4096, 4096, security, HandleInheritability.None);
        }

        public void Start()
        {
            if (worker != null) throw new InvalidOperationException("pipe server is already running");
            server = CreateServer();
            worker = Task.Factory.StartNew(() => AcceptLoop(), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();
        }

        public void UpdateStatus(BridgeStatus next)
        {
            if (next == null) throw new ArgumentNullException("next");
            lock (sync) status = next;
        }

        private async Task AcceptLoop()
        {
            while (!stop.IsCancellationRequested)
            {
                NamedPipeServerStream current;
                lock (sync)
                {
                    if (disposed || server == null) return;
                    current = server;
                }
                try
                {
                    await current.WaitForConnectionAsync(stop.Token).ConfigureAwait(false);
                    using (current)
                    {
                        await HandleClient(current).ConfigureAwait(false);
                    }
                    lock (sync)
                    {
                        if (!disposed) server = CreateServer();
                    }
                }
                catch (OperationCanceledException) { return; }
                catch (IOException) { }
                catch (ObjectDisposedException) { return; }
            }
        }

        private async Task HandleClient(NamedPipeServerStream pipe)
        {
            var buffer = new StringBuilder();
            var bytes = new byte[4096];
            while (!stop.IsCancellationRequested)
            {
                var read = await pipe.ReadAsync(bytes, 0, bytes.Length, stop.Token).ConfigureAwait(false);
                if (read == 0) return;
                buffer.Append(Encoding.UTF8.GetString(bytes, 0, read));
                var newline = buffer.ToString().IndexOf('\n');
                while (newline >= 0)
                {
                    var line = buffer.ToString(0, newline).Trim();
                    buffer.Remove(0, newline + 1);
                    if (line.Length > 0)
                    {
                        var response = HandleRequest(line);
                        var data = Encoding.UTF8.GetBytes(json.Serialize(response) + "\n");
                        await pipe.WriteAsync(data, 0, data.Length, stop.Token).ConfigureAwait(false);
                        await pipe.FlushAsync(stop.Token).ConfigureAwait(false);
                    }
                    newline = buffer.ToString().IndexOf('\n');
                }
            }
        }

        private Dictionary<string, object> HandleRequest(string line)
        {
            var request = json.Deserialize<Dictionary<string, object>>(line);
            var id = request != null && request.ContainsKey("id") ? request["id"] : null;
            var type = request != null && request.ContainsKey("type") ? Convert.ToString(request["type"]) : "";
            if (type == "configure")
            {
                try
                {
                    BridgeConfig.Save(
                        Convert.ToString(request["supabaseUrl"]) ?? "",
                        Convert.ToString(request["deviceToken"]) ?? "",
                        Convert.ToString(request["timezone"]) ?? "Africa/Cairo");
                    return new Dictionary<string, object> { { "id", id }, { "ok", true } };
                }
                catch (Exception)
                {
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "INVALID_CONFIG" } };
                }
            }
            if (type == "get_status" || type == "get_health")
            {
                BridgeStatus snapshot;
                lock (sync) snapshot = status;
                return new Dictionary<string, object>
                {
                    { "id", id },
                    { "ok", true },
                    { "status", snapshot.ToJson() }
                };
            }
            return new Dictionary<string, object>
            {
                { "id", id },
                { "ok", false },
                { "error", "UNKNOWN_REQUEST" }
            };
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (disposed) return;
                disposed = true;
                if (server != null)
                {
                    try { server.Dispose(); } catch (ObjectDisposedException) { }
                    server = null;
                }
            }
            stop.Cancel();
            if (worker != null)
            {
                try { worker.GetAwaiter().GetResult(); }
                catch (OperationCanceledException) { }
                catch (ObjectDisposedException) { }
                catch (IOException) { }
            }
            stop.Dispose();
        }
    }
}
