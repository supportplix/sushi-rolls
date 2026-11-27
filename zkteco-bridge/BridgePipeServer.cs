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
        public string EnrollmentCommandId;
        public string EnrollmentDeviceUserId;
        public string EnrollmentStatus;
        public string EnrollmentMessage;
        public string EnrollmentUpdatedAt;
        // Live device counters from ReadInfo(); keep the UI honest about what is
        // actually registered on the terminal instead of trusting SDK acknowledgements.
        public int? Users;
        public int? Fingerprints;
        public int? Records;

        public BridgeStatus Copy()
        {
            return (BridgeStatus)MemberwiseClone();
        }

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
                { "message", Message },
                { "enrollmentCommandId", EnrollmentCommandId },
                { "enrollmentDeviceUserId", EnrollmentDeviceUserId },
                { "enrollmentStatus", EnrollmentStatus },
                { "enrollmentMessage", EnrollmentMessage },
                { "enrollmentUpdatedAt", EnrollmentUpdatedAt },
                { "users", Users },
                { "fingerprints", Fingerprints },
                { "records", Records }
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
        private NamedPipeServerStream client;
        private readonly object writeLock = new object();
        private Task worker;
        private BridgeStatus status = new BridgeStatus();
        private bool disposed;

        // Returns a command id. The enrollment itself runs on a worker task so the pipe
        // stays responsive and can stream progress for every step.
        public Func<string, string, int, string> EnrollHandler;
        public Func<string, string, int, string> WatchHandler;
        // Single-shot completion probe for a running watch enrollment. The watch
        // itself never polls the terminal while the employee is in the device menu.
        public Func<string, EnrollmentCheck> CheckHandler;

        public sealed class EnrollmentCheck
        {
            public readonly bool Ok;
            public readonly string Status;
            public readonly string Error;
            public readonly int? Count;
            public readonly int? Baseline;

            public EnrollmentCheck(bool ok, string status, string error, int? count, int? baseline)
            {
                Ok = ok;
                Status = status ?? "";
                Error = error ?? "";
                Count = count;
                Baseline = baseline;
            }
        }

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

        public BridgeStatus GetStatus()
        {
            lock (sync) return status.Copy();
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
                    await HandleClient(current).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { return; }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                finally
                {
                    try { current.Dispose(); } catch (ObjectDisposedException) { }
                }
                // Recreate the listening end after every connection cycle, including
                // abrupt client disconnects. The single pipe instance must be released
                // before a new one can bind the same name, so always dispose first.
                lock (sync)
                {
                    if (!disposed) server = CreateServer();
                }
            }
        }

        private async Task HandleClient(NamedPipeServerStream pipe)
        {
            lock (sync) client = pipe;
            try
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
                            Write(pipe, json.Serialize(response));
                        }
                        newline = buffer.ToString().IndexOf('\n');
                    }
                }
            }
            finally
            {
                lock (sync)
                {
                    if (client == pipe) client = null;
                }
            }
        }

        private void Write(NamedPipeServerStream pipe, string text)
        {
            var data = Encoding.UTF8.GetBytes(text + "\n");
            lock (writeLock)
            {
                pipe.Write(data, 0, data.Length);
                pipe.Flush();
            }
        }

        // Pushes the current status to the connected app without waiting for a request.
        public void NotifyStatus()
        {
            NamedPipeServerStream target;
            string text;
            lock (sync)
            {
                target = client;
                if (target == null) return;
                text = json.Serialize(new Dictionary<string, object>
                {
                    { "type", "status" },
                    { "status", status.ToJson() }
                });
            }
            try
            {
                var data = Encoding.UTF8.GetBytes(text + "\n");
                lock (writeLock)
                {
                    if (!target.IsConnected) return;
                    target.Write(data, 0, data.Length);
                    target.Flush();
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
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
            if (type == "enroll" || type == "watch_enrollment")
            {
                var deviceUserId = request.ContainsKey("deviceUserId") ? Convert.ToString(request["deviceUserId"]) ?? "" : "";
                var name = request.ContainsKey("name") ? Convert.ToString(request["name"]) ?? "" : "";
                var timeoutSeconds = 60;
                if (request.ContainsKey("timeoutSeconds"))
                    Int32.TryParse(Convert.ToString(request["timeoutSeconds"]), out timeoutSeconds);
                if (timeoutSeconds < 5) timeoutSeconds = 5;
                if (timeoutSeconds > 300) timeoutSeconds = 300;
                var handler = type == "watch_enrollment" ? WatchHandler : EnrollHandler;
                if (handler == null)
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "ENROLL_NOT_READY" } };
                try
                {
                    var commandId = handler(deviceUserId, name, timeoutSeconds);
                    return new Dictionary<string, object>
                    {
                        { "id", id },
                        { "ok", true },
                        { "commandId", commandId ?? "" }
                    };
                }
                catch (Exception ex)
                {
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", SafeError(ex) } };
                }
            }
            if (type == "check_enrollment")
            {
                var commandId = request.ContainsKey("commandId") ? Convert.ToString(request["commandId"]) ?? "" : "";
                if (CheckHandler == null)
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "ENROLL_NOT_READY" } };
                try
                {
                    var check = CheckHandler(commandId);
                    if (!check.Ok)
                        return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", check.Error } };
                    var response = new Dictionary<string, object> { { "id", id }, { "ok", true }, { "status", check.Status } };
                    if (check.Count.HasValue) response["count"] = check.Count.Value;
                    if (check.Baseline.HasValue) response["baseline"] = check.Baseline.Value;
                    return response;
                }
                catch (Exception ex)
                {
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", SafeError(ex) } };
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

        private static string SafeError(Exception error)
        {
            return error == null || String.IsNullOrWhiteSpace(error.Message) ? "enrollment failed" : error.Message;
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
