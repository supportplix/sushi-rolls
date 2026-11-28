using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
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
        private readonly BridgeAuth auth = new BridgeAuth();
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
            // Challenges are bound to a single connection so a nonce issued to
            // one client cannot be redeemed by a later client with the same PID.
            var connectionId = Guid.NewGuid().ToString("N");
            lock (sync) client = pipe;
            try
            {
                var buffer = new StringBuilder();
                var bytes = new byte[4096];
                // A UTF-8 sequence can straddle two pipe reads (employee names are
                // often non-ASCII); a fresh GetString per chunk would silently
                // replace the split bytes with U+FFFD and corrupt the name.
                var decoder = Encoding.UTF8.GetDecoder();
                var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
                while (!stop.IsCancellationRequested)
                {
                    var read = await pipe.ReadAsync(bytes, 0, bytes.Length, stop.Token).ConfigureAwait(false);
                    if (read == 0) return;
                    buffer.Append(chars, 0, decoder.GetChars(bytes, 0, read, chars, 0, false));
                    if (buffer.Length > 1024 * 1024)
                    {
                        // Bound the pending frame: an unterminated line from a local
                        // client must not grow the bridge's memory without limit.
                        Write(pipe, json.Serialize(new Dictionary<string, object>
                        {
                            { "id", null },
                            { "ok", false },
                            { "error", "FRAME_TOO_LARGE" }
                        }));
                        return;
                    }
                    var newline = buffer.ToString().IndexOf('\n');
                    while (newline >= 0)
                    {
                        var line = buffer.ToString(0, newline).Trim();
                        buffer.Remove(0, newline + 1);
                        if (line.Length > 0)
                        {
                            Dictionary<string, object> response;
                            try
                            {
                                response = HandleRequest(pipe, connectionId, line);
                            }
                            catch (Exception ex)
                            {
                                // A malformed frame (bad JSON, oversized payload, missing
                                // keys) must reply with an error instead of tearing the
                                // connection down — the app treats a dead pipe as a dead
                                // device and stops trusting the bridge.
                                var fallbackId = ExtractRequestId(line);
                                response = new Dictionary<string, object>
                                {
                                    { "id", fallbackId },
                                    { "ok", false },
                                    { "error", SafeError(ex) }
                                };
                            }
                            Write(pipe, json.Serialize(response));
                        }
                        newline = buffer.ToString().IndexOf('\n');
                    }
                }
            }
            finally
            {
                auth.DiscardConnection(connectionId);
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

        private Dictionary<string, object> HandleRequest(NamedPipeServerStream pipe, string connectionId, string line)
        {
            var request = json.Deserialize<Dictionary<string, object>>(line);
            var id = request != null && request.ContainsKey("id") ? request["id"] : null;
            var type = request != null && request.ContainsKey("type") ? Convert.ToString(request["type"]) : "";
            // Anyone with the interactive user's SID can open this pipe, so a
            // privileged command must prove it comes from the app's own process.
            // The challenge is issued only after the client PID's image path is
            // checked against the installed app executable; no secret is sent.
            if (type == "auth_challenge")
            {
                int clientPid;
                string imagePath;
                if (request == null || !IsAllowedClient(pipe, request, out clientPid, out imagePath))
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "UNAUTHORIZED" } };
                var clientNonce = request.ContainsKey("clientNonce") ? Convert.ToString(request["clientNonce"]) : "";
                try
                {
                    var serverNonce = BridgeAuth.RandomNonce();
                    var key = BridgeAuth.DeriveKey(clientNonce, serverNonce);
                    var challenge = auth.Issue(key, clientPid, connectionId);
                    Array.Clear(key, 0, key.Length);
                    return new Dictionary<string, object>
                    {
                        { "id", id },
                        { "ok", true },
                        { "challenge", challenge },
                        { "serverNonce", serverNonce }
                    };
                }
                catch (Exception)
                {
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "UNAUTHORIZED" } };
                }
            }
            if (type == "configure")
            {
                if (!HasValidProof(pipe, request, connectionId))
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "UNAUTHORIZED" } };
                try
                {
                    BridgeConfig.Save(
                        request.ContainsKey("supabaseUrl") ? Convert.ToString(request["supabaseUrl"]) ?? "" : "",
                        request.ContainsKey("deviceToken") ? Convert.ToString(request["deviceToken"]) ?? "" : "",
                        request.ContainsKey("timezone") ? Convert.ToString(request["timezone"]) ?? "" : "Africa/Cairo");
                    return new Dictionary<string, object> { { "id", id }, { "ok", true } };
                }
                catch (Exception)
                {
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "INVALID_CONFIG" } };
                }
            }
            if (type == "enroll" || type == "watch_enrollment")
            {
                if (!HasValidProof(pipe, request, connectionId))
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "UNAUTHORIZED" } };
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
                if (!HasValidProof(pipe, request, connectionId))
                    return new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "UNAUTHORIZED" } };
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

        private const uint ProcessQueryLimitedInformation = 0x1000;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetNamedPipeClientProcessId(IntPtr pipeHandle, out uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(IntPtr processHandle, int flags, StringBuilder imageName, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        /// <summary>
        /// Resolves the OS process on the other end of the pipe. A secret shared
        /// with a same-user process would be readable by that process, so the
        /// bridge authenticates the caller by its executable identity instead.
        /// </summary>
        private static bool TryGetClientIdentity(NamedPipeServerStream pipe, out int processId, out string imagePath)
        {
            processId = 0;
            imagePath = "";
            try
            {
                uint pid;
                if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid) || pid == 0) return false;
                var handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
                if (handle == IntPtr.Zero) return false;
                try
                {
                    var builder = new StringBuilder(32768);
                    var size = builder.Capacity;
                    if (!QueryFullProcessImageName(handle, 0, builder, ref size)) return false;
                    imagePath = builder.ToString();
                    if (String.IsNullOrWhiteSpace(imagePath)) return false;
                    processId = (int)pid;
                    return true;
                }
                finally
                {
                    CloseHandle(handle);
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Only the app's own executable may obtain a challenge. Candidate paths
        /// are derived from this bridge's own location, covering both the dev
        /// tree and the packaged resources/zkteco layout.
        /// </summary>
        private static bool IsAllowedImagePath(string imagePath)
        {
            var actual = NormalizePath(imagePath);
            if (actual == null) return false;
            string bridgeLocation;
            try { bridgeLocation = typeof(BridgePipeServer).Assembly.Location; }
            catch (Exception) { return false; }
            if (String.IsNullOrWhiteSpace(bridgeLocation)) return false;
            var bridgeDir = Path.GetDirectoryName(Path.GetFullPath(bridgeLocation));
            if (String.IsNullOrEmpty(bridgeDir)) return false;
            var cursor = new DirectoryInfo(bridgeDir);
            for (var depth = 0; depth < 8 && cursor != null; depth++)
            {
                if (String.Equals(NormalizePath(Path.Combine(cursor.FullName, "SUSHI ROLLS.exe")), actual, StringComparison.OrdinalIgnoreCase)) return true;
                if (String.Equals(NormalizePath(Path.Combine(cursor.FullName, "node_modules", "electron", "dist", "electron.exe")), actual, StringComparison.OrdinalIgnoreCase)) return true;
                if (depth <= 2 && String.Equals(NormalizePath(Path.Combine(cursor.FullName, "electron.exe")), actual, StringComparison.OrdinalIgnoreCase)) return true;
                cursor = cursor.Parent;
            }
            return false;
        }

        private static string NormalizePath(string path)
        {
            if (String.IsNullOrWhiteSpace(path)) return null;
            try
            {
                return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            }
            catch (Exception) { return null; }
        }

        private bool IsAllowedClient(NamedPipeServerStream pipe, Dictionary<string, object> request, out int processId, out string imagePath)
        {
            if (!TryGetClientIdentity(pipe, out processId, out imagePath)) return false;
            if (!IsAllowedImagePath(imagePath)) return false;
            var claimed = request.ContainsKey("processPath") ? Convert.ToString(request["processPath"]) : "";
            var actualPath = NormalizePath(imagePath);
            return actualPath != null && String.Equals(NormalizePath(claimed), actualPath, StringComparison.OrdinalIgnoreCase);
        }

        private bool HasValidProof(NamedPipeServerStream pipe, Dictionary<string, object> request, string connectionId)
        {
            if (request == null || pipe == null) return false;
            var challenge = request.ContainsKey("challenge") ? Convert.ToString(request["challenge"]) : "";
            var proof = request.ContainsKey("proof") ? Convert.ToString(request["proof"]) : "";
            int processId;
            string imagePath;
            if (!TryGetClientIdentity(pipe, out processId, out imagePath)) return false;
            if (!IsAllowedImagePath(imagePath)) return false;
            return auth.Verify(challenge, proof, processId, connectionId);
        }

        private static string SafeError(Exception error)
        {
            return error == null || String.IsNullOrWhiteSpace(error.Message) ? "enrollment failed" : error.Message;
        }

        /// <summary>
        /// Best-effort request-id recovery for frames that failed before
        /// HandleRequest could parse them, so the app can still correlate the
        /// error reply with its pending request.
        /// </summary>
        private object ExtractRequestId(string line)
        {
            try
            {
                var request = json.Deserialize<Dictionary<string, object>>(line);
                if (request != null && request.ContainsKey("id")) return request["id"];
            }
            catch (Exception) { }
            return null;
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
