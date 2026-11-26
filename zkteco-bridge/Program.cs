using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SushiRolls.ZkTeco
{
    internal static class Program
    {
        private const string SelfTestMarker = "SELF-TEST PASS";
        private static readonly CancellationTokenSource Stop = new CancellationTokenSource();
        private static int exitCode;
        private static AttendancePoller activePoller;
        private static readonly object PollerLock = new object();
        private static bool attendancePaused;
        private static readonly object ConsoleLock = new object();

        // The LX15 accepts one SDK handle and locks up when a second multi-call
        // operation interrupts an in-progress registration. Enrollment therefore
        // owns the device exclusively: the attendance poller and the command
        // queue stay suspended from BeginEnrollment until EndEnrollment.
        private static bool enrollmentActive;
        private static readonly Dictionary<string, DateTime> recentlyWrittenUsers = new Dictionary<string, DateTime>();
        private static readonly TimeSpan RecentlyWrittenTtl = TimeSpan.FromSeconds(120);
        private static readonly object EnrollmentLock = new object();

        private static int Main(string[] args)
        {
            Console.CancelKeyPress += OnCancelKeyPress;
            AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
            try
            {
                if (args.Length == 0) throw new ArgumentException("a mode is required: --self-test, --probe, --enroll-test, --attendance-test, --delete-user, or --pipe");
                var mode = args[0];
                switch (mode)
                {
                    case "--self-test":
                        RequireOnly(args, new[] { "--self-test" });
                        RunSelfTest();
                        break;
                    case "--probe":
                        RunProbe(args);
                        break;
                    case "--enroll-test":
                        RunEnrollmentTest(args);
                        break;
                    case "--attendance-test":
                        RunAttendanceTest(args);
                        break;
                    case "--delete-user":
                        RunDeleteUserTest(args);
                        break;
                    case "--pipe":
                        RequireOnly(args, new[] { "--pipe" });
                        RunPipe();
                        break;
                    case "--agent":
                        RequireOnly(args, new[] { "--agent" });
                        RunPipe();
                        break;
                    case "--service":
                        RequireOnly(args, new[] { "--service" });
                        ZkTecoWindowsService.Run();
                        break;
                    default:
                        throw new ArgumentException("unknown mode: " + mode);
                }
                return exitCode;
            }
            catch (ArgumentException ex)
            {
                lock (ConsoleLock) Console.Error.WriteLine("ERROR: " + ex.Message);
                return 2;
            }
            catch (Exception ex)
            {
                lock (ConsoleLock) Console.Error.WriteLine("ERROR: " + SafeError(ex));
                return 1;
            }
            finally
            {
                Stop.Dispose();
            }
        }

        private static void RunSelfTest()
        {
            Run("fake-device-contracts", TestFakeContracts);
            Run("event-hash", TestEventHash);
            Run("outbox-json-schema", TestOutboxJson);
            Run("outbox-dedupe-flush-recovery", TestOutbox);
            Run("enrollment-worker", TestEnrollmentWorker);
            Run("attendance-poller", TestAttendancePoller);
            Run("supabase-tls", TestSupabaseTls);
            if (exitCode == 0)
            {
                lock (ConsoleLock) Console.WriteLine(SelfTestMarker);
            }
        }

        private static void TestOutboxJson()
        {
            var sample = Sample("1001", 0);
            var entry = new OutboxEntry
            {
                EventId = Guid.NewGuid().ToString("N"),
                PayloadHash = EventHash.For(sample, "LX15-A"),
                Payload = sample,
                CreatedAt = new DateTime(2026, 11, 24, 10, 0, 0, DateTimeKind.Utc),
                Synced = false
            };
            var json = "[" + entry.ToJson() + "]";
            if (Environment.GetCommandLineArgs().Length > 1 && Environment.GetCommandLineArgs()[1] == "--show-outbox-json")
            {
                Console.WriteLine(json);
                return;
            }
            var parsed = OutboxJson.ReadArray(json);
            Require(parsed.Count == 1 && parsed[0].EventId == entry.EventId && EventHash.For(parsed[0].Payload, "LX15-A") == entry.PayloadHash,
                "outbox round-trip changed its entry");
        }

        private static void TestFakeContracts()
        {
            using (var fake = new FakeDevice())
            {
                Require(fake.Connect(7), "fake connect failed");
                var info = fake.ReadInfo();
                Require(info.Serial == "FAKE-LX15" && info.Users == 0, "fake identity is not deterministic");
                Require(fake.EnsureUser("1001", "Test Employee"), "fake user creation failed");
                Require(fake.StartEnrollment("1001"), "fake enrollment start failed");
                Require(fake.PollEnrollment("1001").Status == "awaiting_scan", "fake must await a scan");
                var enrolled = fake.PollEnrollment("1001");
                Require(enrolled.Status == "enrolled" && enrolled.TemplateLength == 512, "fake enrollment must complete after two polls");
                Require(!fake.EnrollmentActive, "fake enrollment was not cleared");

                var punch = Sample("1001", 0);
                fake.QueueAttendance(punch);
                var first = fake.ReadNewAttendance();
                Require(first.Count == 1 && first[0].DeviceUserId == "1001", "fake attendance event was not returned");
                Require(fake.ReadNewAttendance().Count == 0, "fake attendance replayed a consumed event");
                fake.QueueAttendance(punch);
                Require(fake.ReadNewAttendance().Count == 1, "fake attendance did not return the queued event");
                fake.Disconnect();
                Require(!fake.Connected && fake.DisconnectCalls == 1, "fake disconnect failed");
            }
        }

        private static void TestEventHash()
        {
            var first = Sample("1001", 0);
            var same = Sample("1001", 0);
            var other = Sample("1001", 1);
            var hash1 = EventHash.For(first, "LX15-A");
            var hash2 = EventHash.For(same, "LX15-A");
            Require(hash1 == hash2 && hash1.Length == 64, "event hash is not stable");
            Require(EventHash.For(other, "LX15-A") != hash1, "work code must affect the event hash");
            Require(EventHash.For(first, "LX15-B") != hash1, "device serial must affect the event hash");
            Require(EventHash.For(Sample("a|7", 0), "LX15") == EventHash.For(Sample("a|7", 0), "LX15"), "hash fields are ambiguous");
            Require(EventHash.For(Sample("a|7", 0), "LX15") != EventHash.For(Sample("a", 7), "LX15"), "hash fields collided");
            try
            {
                EventHash.For(new AttendanceEvent("1001", 0, 0, 2026, 2, 30, 0, 0, 0, 0), "LX15");
                throw new Exception("invalid calendar timestamp was accepted");
            }
            catch (ArgumentException) { }
        }

        private static void TestOutbox()
        {
            var directory = Path.Combine(Path.GetTempPath(), "SushiRolls.ZkTeco.SelfTest", Guid.NewGuid().ToString("N"));
            var path = Path.Combine(directory, "events.json");
            Require(Path.GetFileName(path) == "events.json", "outbox test path is invalid");
            Require(File.Exists(path) == false, "outbox test path unexpectedly exists");
            try
            {
                Directory.CreateDirectory(directory);
                File.WriteAllText(Path.Combine(directory, "events.json.stale.tmp"), "stale", new UTF8Encoding(false));
                File.WriteAllText(path, "[]", new UTF8Encoding(false));
                var sample = Sample("1001", 0);
                OutboxEntry added;
                using (var outbox = new Outbox(path))
                {
                    Require(!File.Exists(Path.Combine(directory, "events.json.stale.tmp")), "stale temporary file was not removed");
                    added = outbox.Append(sample, "LX15-A");
                    Require(outbox.FilePath == Path.GetFullPath(path), "outbox path mismatch: " + outbox.FilePath);
                    var rawJson = File.ReadAllText(outbox.FilePath);
                    Require(rawJson.Length > 2, "outbox write was empty: " + rawJson);
                    var persisted = OutboxJson.ReadArray(rawJson);
                    Require(persisted.Count == 1, "append count=" + persisted.Count + " json=" + rawJson);
                    Require(EventHash.For(persisted[0].Payload, "LX15-A") == EventHash.For(sample, "LX15-A"),
                        "append hash mismatch expected=" + EventHash.For(sample, "LX15-A") + " actual=" + EventHash.For(persisted[0].Payload, "LX15-A"));
                    if (File.Exists(Path.Combine(directory, "failed-outbox.json"))) File.Delete(Path.Combine(directory, "failed-outbox.json"));
                    Require(outbox.ReadPending().Count == 1 && outbox.ReadAll().Count == 1, "outbox dedupe failed");
                    Require(outbox.Append(sample, "LX15-A").EventId == added.EventId, "duplicate append created another entry");
                    Require(!File.Exists(path + "." + Guid.NewGuid().ToString("N") + ".tmp"), "unexpected temporary file");
                    outbox.Flush();
                    Require(outbox.MarkSynced(added.EventId), "mark-synced failed");
                    Require(outbox.ReadPending().Count == 0, "synced event remained pending");
                }

                using (var reopened = new Outbox(path))
                {
                    Require(reopened.ReadPending().Count == 0, "new process saw a synced pending event");
                    Require(reopened.ReadAll().Count == 1 && reopened.ReadAll()[0].Synced, "synced state was not durable");
                    var newEntry = reopened.Append(sample, "LX15-B");
                    Require(newEntry.EventId != added.EventId, "device identity was not included in outbox dedupe");
                    reopened.Compact();
                    Require(reopened.ReadAll().Count == 1 && reopened.ReadAll()[0].EventId == newEntry.EventId, "outbox compaction removed the pending event");
                }

                using (var reopened = new Outbox(path))
                {
                    Require(reopened.ReadAll().Count == 1 && reopened.ReadPending().Count == 1, "pending event did not survive a process restart");
                    var duplicate = reopened.Append(Sample("1001", 0), "LX15-B");
                    Require(duplicate.EventId == reopened.ReadPending()[0].EventId, "dedupe failed after restart");
                    Require(reopened.MarkSynced(duplicate.EventId), "post-restart mark-synced failed");
                }

                using (var empty = new Outbox(path))
                {
                    empty.Compact();
                    Require(empty.ReadAll().Count == 0 && empty.ReadPending().Count == 0, "empty outbox did not compact");
                }

                var firstEntry = new OutboxEntry
                {
                    EventId = Guid.NewGuid().ToString("N"), PayloadHash = EventHash.For(sample, "LX15-A"), Payload = sample,
                    CreatedAt = new DateTime(2026, 11, 24, 10, 0, 0, DateTimeKind.Utc), Synced = false
                };
                File.WriteAllText(path, "[" + firstEntry.ToJson() + "]", new UTF8Encoding(false));
                using (var recovered = new Outbox(path))
                {
                    Require(recovered.ReadPending().Count == 1, "crash recovery could not read the last atomic write");
                    Require(!recovered.MarkSynced(Guid.NewGuid().ToString("N")), "unknown event was marked synced");
                    Require(recovered.ReadPending().Count == 1, "unknown event changed pending state");
                }

                var validJson = File.ReadAllText(path);
                var corruptedPath = Path.Combine(directory, "corrupt.json");
                File.WriteAllText(corruptedPath, validJson.Substring(0, validJson.Length - 1), new UTF8Encoding(false));
                try
                {
                    using (var corrupt = new Outbox(corruptedPath)) corrupt.ReadPending();
                    throw new Exception("corrupt outbox was accepted");
                }
                catch (InvalidDataException) { }
            }
            finally
            {
                TryDeleteDirectory(directory);
            }
        }

        private static void TestEnrollmentWorker()
        {
            using (var fake = new FakeDevice())
            {
                fake.Connect(7);
                using (var worker = new EnrollmentWorker(fake, TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(1)))
                {
                    var steps = new List<string>();
                    worker.Progress = delegate(EnrollmentProgress progress) { steps.Add(progress.Status); };
                    var create = Command("create_user", "1001", "Test Employee");
                    var created = worker.ExecuteAsync(create, Stop.Token).GetAwaiter().GetResult();
                    Require(created.Status == "completed" && created.Error == "", "create_user command failed: " + created.ToJson());
                    var update = worker.ExecuteAsync(Command("update_user", "1001", "Test Employee"), Stop.Token).GetAwaiter().GetResult();
                    Require(update.Status == "completed", "update_user command failed: " + update.ToJson());
                    fake.ConfigureSuccessEnrollment();
                    var command = Command("start_enrollment", "1001", "Test Employee");
                    var enrolled = worker.ExecuteAsync(command, Stop.Token).GetAwaiter().GetResult();
                    Require(enrolled.Status == "completed", "enrollment command did not complete: " + enrolled.ToJson());
                    Require(fake.CancelEnrollmentCalls > 0 && !fake.EnrollmentActive, "successful enrollment did not cancel the device operation");
                    fake.ConfigureTimeout(2);
                    var timedOut = worker.ExecuteAsync(command, Stop.Token).GetAwaiter().GetResult();
                    Require(timedOut.Status == "timed_out", "enrollment timeout was not reported: " + timedOut.ToJson());
                    Require(!fake.EnrollmentActive, "timed-out enrollment remained active");

                    fake.ConfigureSuccessEnrollment();
                    var direct = worker.ExecuteEnrollmentAsync("1001", TimeSpan.FromSeconds(1), Stop.Token).GetAwaiter().GetResult();
                    Require(direct.Status == "enrolled" && direct.TemplateLength == 512, "direct enrollment success failed");
                    Require(steps.Contains("awaiting_scan") && steps.Contains("enrolled"), "enrollment progress was not reported for each step");

                    var cancellable = new FakeDevice();
                    cancellable.Connect(7);
                    cancellable.EnsureUser("1001", "Test Employee");
                    cancellable.ConfigureTimeout(1000);
                    using (var cancelWorker = new EnrollmentWorker(cancellable, TimeSpan.FromMinutes(1), TimeSpan.FromMilliseconds(25)))
                    using (var cancellation = new CancellationTokenSource())
                    {
                        var running = cancelWorker.ExecuteEnrollmentAsync("1001", cancellation.Token);
                        cancellation.Cancel();
                        var cancelled = running.GetAwaiter().GetResult();
                        Require(cancelled.Status == "cancelled" && !cancellable.EnrollmentActive, "cancellation did not clear enrollment");
                    }

                    var disabled = worker.ExecuteAsync(Command("disable_user", "1001", "Test Employee"), Stop.Token).GetAwaiter().GetResult();
                    Require(disabled.Status == "completed", "disable_user command failed");
                    var deleted = worker.ExecuteAsync(Command("delete_user", "1001", "Test Employee"), Stop.Token).GetAwaiter().GetResult();
                    Require(deleted.Status == "completed", "delete_user command failed");
                }

                fake.ConfigureFailures(true, false);
                using (var worker = new EnrollmentWorker(fake))
                {
                    var failed = worker.ExecuteAsync(Command("create_user", "1001", "Test Employee"), Stop.Token).GetAwaiter().GetResult();
                    Require(failed.Status == "failed", "device create failure was not reported");
                }
            }

            try
            {
                new DeviceCommand(Guid.NewGuid().ToString(), "unknown", "1001", "Test Employee", 0, "key").Validate();
                throw new Exception("invalid command type was accepted");
            }
            catch (ArgumentException) { }
        }

        private static void TestAttendancePoller()
        {
            var directory = Path.Combine(Path.GetTempPath(), "SushiRolls.ZkTeco.PollerTest", Guid.NewGuid().ToString("N"));
            var path = Path.Combine(directory, "outbox.json");
            try
            {
                using (var fake = new FakeDevice())
                using (var outbox = new Outbox(path))
                {
                    fake.Connect(7);
                    var output = new List<string>();
                    using (var poller = new AttendancePoller(fake, outbox, "LX15-A", TimeSpan.FromMilliseconds(5), delegate (OutboxEntry entry) { output.Add(entry.PayloadHash); }))
                    {
                        Require(poller.PollOnce() == 0 && outbox.ReadPending().Count == 0, "empty attendance poll changed the outbox");
                        fake.QueueAttendance(Sample("1001", 0));
                        Require(poller.PollOnce() == 1, "attendance was not persisted");
                        Require(poller.PollOnce() == 0, "attendance replay was not consumed");
                        Require(outbox.ReadPending().Count == 1 && output.Count == 1, "attendance output or dedupe failed");

                        fake.QueueAttendance(Sample("1001", 1));
                        using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(150)))
                        {
                            var running = poller.RunAsync(cancellation.Token);
                            Require(WaitUntil(() => outbox.ReadPending().Count == 2, TimeSpan.FromSeconds(2)), "background poller did not collect attendance");
                            poller.Cancel();
                            try { running.GetAwaiter().GetResult(); }
                            catch (OperationCanceledException) { }
                        }
                        Require(!poller.IsRunning && poller.CancelRequested, "attendance poller did not stop cleanly");
                        Require(outbox.ReadPending().Count == 2 && output.Count == 2, "background poller lost or duplicated attendance");
                    }
                }
            }
            finally
            {
                TryDeleteDirectory(directory);
            }
        }

        private static void TestProcessSelfTest()
        {
            var assembly = Assembly.GetExecutingAssembly().Location;
            Require(File.Exists(assembly), "bridge assembly path is missing");
            var executablePath = Path.Combine(Path.GetDirectoryName(assembly), "ZkTecoBridge.exe");
            Require(File.Exists(executablePath), "bridge executable is missing");
            Require(!String.Equals(assembly, executablePath, StringComparison.OrdinalIgnoreCase) || Environment.GetCommandLineArgs().Length > 1,
                "process self-test must run in a child process");
            var start = new ProcessStartInfo(executablePath, "--self-test --process-child")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            if (Environment.GetCommandLineArgs().Length == 2 && Environment.GetCommandLineArgs()[1] == "--process-child")
            {
                start = new ProcessStartInfo("cmd.exe", "/c \"\"" + executablePath + "\" --self-test --process-child\"")
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
            }
            using (var process = Process.Start(start))
            {
                var stdout = process.StandardOutput.ReadToEnd();
                var stderr = process.StandardError.ReadToEnd();
                process.WaitForExit();
                Require(process.ExitCode == 0 && stdout.Contains(SelfTestMarker) && stderr.Length == 0,
                    "child self-test failed: " + stdout + " " + stderr);
            }
        }

        private static void RunProbe(string[] args)
        {
            if (args.Length == 2 && args[1] == "--usb")
            {
                lock (ConsoleLock) Console.WriteLine(DeviceJson.ToJson(ZkTecoUsbProbe.Probe()));
                return;
            }
            var options = ParseOptions(args, new[] { "--com" });
            var com = RequiredPort(options);
            using (var device = new ZkTecoComDevice(com))
            {
                if (!device.Connect(com))
                {
                    lock (ConsoleLock) Console.Error.WriteLine("ERROR: Connect_Com failed for COM" + com + "; SDK error " + device.LastError);
                    exitCode = 1;
                    return;
                }
                try
                {
                    var info = device.ReadInfo();
                    lock (ConsoleLock) Console.WriteLine(DeviceJson.ToJson(info));
                }
                finally
                {
                    device.Disconnect();
                }
            }
        }

        private static void RunEnrollmentTest(string[] args)
        {
            var useUsb = args.Contains("--usb");
            var filtered = args.Where((arg) => arg != "--usb").ToArray();
            var options = ParseOptions(filtered, new[] { "--com", "--user-id", "--name", "--timeout" });
            var com = useUsb ? 0 : RequiredPort(options);
            var userId = Required(options, "--user-id");
            var name = Required(options, "--name");
            var timeout = TimeSpan.FromSeconds(60);
            if (options.ContainsKey("--timeout"))
            {
                int seconds;
                if (!Int32.TryParse(options["--timeout"], out seconds) || seconds < 1 || seconds > 3600)
                    throw new ArgumentException("--timeout must be between 1 and 3600 seconds");
                timeout = TimeSpan.FromSeconds(seconds);
            }

            IZkTecoDevice device = useUsb ? (IZkTecoDevice)new ZkTecoUsbDevice() : new ZkTecoComDevice(com);
            using (device)
            using (var worker = new EnrollmentWorker(device, timeout, EnrollmentWorker.PollInterval))
            {
                if (!device.Connect(com))
                {
                    lock (ConsoleLock) Console.Error.WriteLine("ERROR: device connection failed" + (useUsb ? " over USB" : " for COM" + com));
                    exitCode = 1;
                    return;
                }
                try
                {
                    var create = new DeviceCommand(Guid.NewGuid().ToString(), "create_user", userId, name, 0, "enroll-test-" + Guid.NewGuid().ToString("N"));
                    var createResult = worker.ExecuteAsync(create, Stop.Token).GetAwaiter().GetResult();
                    if (createResult.Status != "completed") throw new InvalidOperationException("create user failed: " + createResult.Error + "; SDK error " + device.LastError);
                    var result = worker.ExecuteEnrollmentAsync(userId, timeout, Stop.Token).GetAwaiter().GetResult();
                    lock (ConsoleLock) Console.WriteLine(EnrollmentJson.ToJson(result));
                    // The device fingerprint counter is the enrollment signal; the
                    // template length is a diagnostic that stays zero on this firmware.
                    if (result.Status != "enrolled") exitCode = 1;
                }
                finally
                {
                    device.Disconnect();
                }
            }
        }

        private static void RunDeleteUserTest(string[] args)
        {
            var useUsb = args.Contains("--usb");
            var filtered = args.Where((arg) => arg != "--usb").ToArray();
            var options = ParseOptions(filtered, new[] { "--com", "--user-id" });
            var com = useUsb ? 0 : RequiredPort(options);
            var userId = Required(options, "--user-id");
            IZkTecoDevice device = useUsb ? (IZkTecoDevice)new ZkTecoUsbDevice() : new ZkTecoComDevice(com);
            using (device)
            {
                if (!device.Connect(com)) throw new InvalidOperationException("device connection failed");
                try
                {
                    device.DeleteUser(userId);
                    lock (ConsoleLock) Console.WriteLine("{\"device_user_id\":" + Json.Escape(userId) + ",\"deleted\":true}");
                }
                finally
                {
                    device.Disconnect();
                }
            }
        }

        private static void RunAttendanceTest(string[] args)
        {
            var useUsb = args.Contains("--usb");
            var filtered = args.Where((arg) => arg != "--usb").ToArray();
            var options = ParseOptions(filtered, new[] { "--com", "--duration" });
            var com = useUsb ? 0 : RequiredPort(options);
            var duration = TimeSpan.FromSeconds(120);
            if (options.ContainsKey("--duration"))
            {
                int seconds;
                if (!Int32.TryParse(options["--duration"], out seconds) || seconds < 1 || seconds > 86400)
                    throw new ArgumentException("--duration must be between 1 and 86400 seconds");
                duration = TimeSpan.FromSeconds(seconds);
            }

            IZkTecoDevice device = useUsb ? (IZkTecoDevice)new ZkTecoUsbDevice() : new ZkTecoComDevice(com);
            using (device)
            using (var outbox = new Outbox())
            {
                if (!device.Connect(com))
                {
                    lock (ConsoleLock) Console.Error.WriteLine("ERROR: device connection failed" + (useUsb ? " over USB" : " for COM" + com));
                    exitCode = 1;
                    return;
                }
                try
                {
                    var info = device.ReadInfo();
                    using (var poller = new AttendancePoller(device, outbox, info.Serial, AttendancePoller.PollInterval, PrintAttendance))
                    {
                        using (var deadline = new CancellationTokenSource(duration))
                        using (var linked = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, Stop.Token))
                        {
                            poller.PollOnce();
                            var running = poller.RunAsync(linked.Token);
                            try { running.GetAwaiter().GetResult(); }
                            catch (OperationCanceledException) { }
                        }
                    }
                }
                finally
                {
                    outbox.Flush();
                    device.Disconnect();
                }
            }
        }

        private static void TestSupabaseTls()
        {
            var original = ServicePointManager.SecurityProtocol;
            try
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls;
                using (var sync = new SupabaseSync())
                {
                    Require((ServicePointManager.SecurityProtocol & SecurityProtocolType.Tls12) != 0,
                        "Supabase client did not enable TLS 1.2");
                }
            }
            finally
            {
                ServicePointManager.SecurityProtocol = original;
            }
        }

        private static void Debug(string message)
        {
            // Diagnostics are intentionally disabled in release builds.
        }

        private static void SetEnrollment(BridgePipeServer server, string commandId, string deviceUserId, string status, string message)
        {
            try
            {
                var next = server.GetStatus();
                next.EnrollmentCommandId = String.IsNullOrWhiteSpace(commandId) ? next.EnrollmentCommandId : commandId;
                next.EnrollmentDeviceUserId = deviceUserId ?? "";
                next.EnrollmentStatus = status ?? "";
                next.EnrollmentMessage = message ?? "";
                next.EnrollmentUpdatedAt = DateTime.UtcNow.ToString("o");
                server.UpdateStatus(next);
                server.NotifyStatus();
            }
            catch (Exception) { }
        }

        // Re-reads the terminal counters once, best-effort, so the UI reflects the
        // real device state (not an SDK acknowledgement) right after enrollment.
        private static void RefreshCounts(BridgePipeServer server, ZkTecoUsbDevice device)
        {
            try
            {
                var info = device.ReadInfo();
                var next = server.GetStatus();
                next.Users = info.Users;
                next.Fingerprints = info.Fingerprints;
                next.Records = info.Records;
                server.UpdateStatus(next);
                server.NotifyStatus();
            }
            catch (Exception) { }
        }

        private static void PauseAttendancePolling()
        {
            AttendancePoller poller;
            lock (PollerLock)
            {
                attendancePaused = true;
                poller = activePoller;
                activePoller = null;
            }
            if (poller != null)
            {
                try { poller.Dispose(); } catch (Exception) { }
            }
        }

        private static void ResumeAttendancePolling()
        {
            // The main pipe loop recreates the poller on its next pass. It must not
            // hold a reference to a disposed poller, otherwise attendance stays off.
            lock (PollerLock) attendancePaused = false;
        }

        private static void StopAttendancePolling()
        {
            AttendancePoller poller;
            lock (PollerLock)
            {
                poller = activePoller;
                activePoller = null;
            }
            if (poller != null)
            {
                try { poller.Dispose(); } catch (Exception) { }
            }
        }

        // Claims the device for a single enrollment. Returns false when another
        // registration is already running so the pipe can answer ENROLLMENT_BUSY
        // instead of racing two sessions on the same terminal.
        private static bool BeginEnrollment()
        {
            lock (EnrollmentLock)
            {
                if (enrollmentActive) return false;
                enrollmentActive = true;
                return true;
            }
        }

        private static void EndEnrollment()
        {
            lock (EnrollmentLock) enrollmentActive = false;
        }

        private static bool IsEnrollmentActive()
        {
            lock (EnrollmentLock) return enrollmentActive;
        }

        // Records the terminal users this bridge process created itself. The
        // command queue skips their create_user replay instead of re-running
        // DisableDevice + SetUserInfo + RefreshData, which reboots the LX15.
        private static void RememberWrittenUser(string deviceUserId)
        {
            lock (EnrollmentLock) recentlyWrittenUsers[deviceUserId ?? ""] = DateTime.UtcNow;
        }

        private static bool WasUserWrittenRecently(string deviceUserId)
        {
            lock (EnrollmentLock)
            {
                DateTime writtenAt;
                if (String.IsNullOrEmpty(deviceUserId) || !recentlyWrittenUsers.TryGetValue(deviceUserId, out writtenAt)) return false;
                if (DateTime.UtcNow - writtenAt > RecentlyWrittenTtl)
                {
                    recentlyWrittenUsers.Remove(deviceUserId);
                    return false;
                }
                return true;
            }
        }

        private static void EnsureAttendancePoller(ZkTecoUsbDevice device, Outbox outbox, string serial)
        {
            lock (PollerLock)
            {
                if (attendancePaused || activePoller != null || Stop.IsCancellationRequested) return;
                var noPoll = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "SUSHI ROLLS", "zkteco", "nopoll.flag");
                if (File.Exists(noPoll)) return;
                var poller = new AttendancePoller(device, outbox, serial, AttendancePoller.PollInterval, delegate { });
                activePoller = poller;
                poller.RunAsync(Stop.Token);
            }
        }

        private static string EnqueueDirectEnrollment(BridgePipeServer server, ZkTecoUsbDevice device, string deviceUserId, string name, int timeoutSeconds)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("deviceUserId is required");
            if (String.IsNullOrWhiteSpace(name)) throw new ArgumentException("name is required");
            if (!BeginEnrollment()) throw new InvalidOperationException("ENROLLMENT_BUSY");
            var commandId = Guid.NewGuid().ToString("N");
            try
            {
                Task.Factory.StartNew(delegate
                {
                    RunDirectEnrollment(server, device, commandId, deviceUserId, name, timeoutSeconds);
                }, TaskCreationOptions.LongRunning);
            }
            catch (Exception)
            {
                EndEnrollment();
                throw;
            }
            return commandId;
        }

        private static void RunDirectEnrollment(BridgePipeServer server, ZkTecoUsbDevice device, string commandId, string deviceUserId, string name, int timeoutSeconds)
        {
            // The SDK allows a single handle per LX15, so enrollment must share the
            // attendance handle. PollEnrollment uses the non-blocking fingerprint counter.
            try
            {
                PauseAttendancePolling();
                SetEnrollment(server, commandId, deviceUserId, "starting", "creating device user");
                if (!device.EnsureUser(deviceUserId, name))
                {
                    SetEnrollment(server, commandId, deviceUserId, "failed", "device user creation failed; SDK error " + device.LastError);
                    return;
                }
                RememberWrittenUser(deviceUserId);
                using (var worker = new EnrollmentWorker(device, TimeSpan.FromSeconds(timeoutSeconds), EnrollmentWorker.PollInterval))
                {
                    worker.Progress = delegate(EnrollmentProgress progress)
                    {
                        SetEnrollment(server, commandId, progress.DeviceUserId, progress.Status, progress.Message);
                    };
                    var result = worker.ExecuteEnrollmentAsync(deviceUserId, Stop.Token).GetAwaiter().GetResult();
                    SetEnrollment(server, commandId, deviceUserId, result.Status, result.Error);
                    if (result.Status == "enrolled") RefreshCounts(server, device);
                }
            }
            catch (Exception ex)
            {
                SetEnrollment(server, commandId, deviceUserId, "failed", SafeError(ex));
            }
            finally
            {
                EndEnrollment();
                ResumeAttendancePolling();
            }
        }

        private static string EnqueueWatchEnrollment(BridgePipeServer server, ZkTecoUsbDevice device, string deviceUserId, string name, int timeoutSeconds)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("deviceUserId is required");
            if (String.IsNullOrWhiteSpace(name)) throw new ArgumentException("name is required");
            if (!BeginEnrollment()) throw new InvalidOperationException("ENROLLMENT_BUSY");
            var commandId = Guid.NewGuid().ToString("N");
            try
            {
                Task.Factory.StartNew(delegate
                {
                    RunWatchEnrollment(server, device, commandId, deviceUserId, name, timeoutSeconds);
                }, TaskCreationOptions.LongRunning);
            }
            catch (Exception)
            {
                EndEnrollment();
                throw;
            }
            return commandId;
        }

        private static void RunWatchEnrollment(BridgePipeServer server, ZkTecoUsbDevice device, string commandId, string deviceUserId, string name, int timeoutSeconds)
        {
            // The LX15 firmware refuses remote StartEnrollEx. Create the named user on
            // the terminal and watch its fingerprint counter while the employee
            // registers the finger from the device keypad. ReadInfo() performs five
            // SDK calls; calling it every 750 ms kept the terminal on "Working", so
            // use the single non-blocking status call instead.
            try
            {
                PauseAttendancePolling();
                SetEnrollment(server, commandId, deviceUserId, "starting", "creating device user");
                if (!device.EnsureUser(deviceUserId, name))
                {
                    SetEnrollment(server, commandId, deviceUserId, "failed", "device user creation failed; SDK error " + device.LastError);
                    return;
                }
                RememberWrittenUser(deviceUserId);
                var baseline = device.ReadFingerprintCount();
                SetEnrollment(server, commandId, deviceUserId, "awaiting_scan", "register the fingerprint from the device menu");
                var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
                while (DateTime.UtcNow < deadline)
                {
                    if (Stop.Token.IsCancellationRequested)
                    {
                        SetEnrollment(server, commandId, deviceUserId, "cancelled", "stopped");
                        return;
                    }
                    Stop.Token.WaitHandle.WaitOne(2000);
                    if (device.ReadFingerprintCount() > baseline)
                    {
                        SetEnrollment(server, commandId, deviceUserId, "enrolled", "fingerprint registered on the device");
                        RefreshCounts(server, device);
                        return;
                    }
                }
                SetEnrollment(server, commandId, deviceUserId, "timed_out", "no fingerprint was registered before timeout");
            }
            catch (Exception ex)
            {
                SetEnrollment(server, commandId, deviceUserId, "failed", SafeError(ex));
            }
            finally
            {
                EndEnrollment();
                ResumeAttendancePolling();
            }
        }

        private static void PublishStatus(BridgePipeServer server, string state, DeviceInfo info, string lastSyncAt, Outbox outbox, string message)
        {
            var next = server.GetStatus();
            next.State = state;
            next.DeviceName = "Attendance Device";
            next.SerialNumber = info == null ? null : info.Serial;
            next.Firmware = info == null ? null : info.Firmware;
            next.Transport = "usb-std";
            next.ComPort = null;
            next.LastSeenAt = state == "connected" ? DateTime.UtcNow.ToString("o") : null;
            next.LastSyncAt = lastSyncAt;
            if (info != null)
            {
                next.Users = info.Users;
                next.Fingerprints = info.Fingerprints;
                next.Records = info.Records;
            }
            next.PendingOutbox = outbox.ReadPending().Count;
            next.Message = message;
            server.UpdateStatus(next);
            server.NotifyStatus();
        }

        internal static void RunPipe()
        {
            var deviceMutex = new Mutex(false, @"Global\SushiRolls.ZkTeco.Device");
            if (!deviceMutex.WaitOne(0))
            {
                lock (ConsoleLock) Console.Error.WriteLine("BUSY");
                exitCode = 2;
                deviceMutex.Dispose();
                return;
            }
            try
            {
            using (var outbox = new Outbox())
            using (var device = new ZkTecoUsbDevice())
            using (var sync = new SupabaseSync())
            using (var server = new BridgePipeServer())
            {
                string lastSyncAt = null;
                DeviceInfo info = null;
                var infoReadAt = DateTime.MinValue;
                server.EnrollHandler = delegate(string deviceUserId, string name, int timeoutSeconds)
                {
                    return EnqueueDirectEnrollment(server, device, deviceUserId, name, timeoutSeconds);
                };
                server.WatchHandler = delegate(string deviceUserId, string name, int timeoutSeconds)
                {
                    return EnqueueWatchEnrollment(server, device, deviceUserId, name, timeoutSeconds);
                };
                server.Start();
                while (!Stop.IsCancellationRequested)
                {
                    try
                    {
                        if (!device.Connect(0)) throw new InvalidOperationException("Z_Connect_USB_STD could not open the LX15");
                        // Identity changes only on reconnect. ReadInfo() performs five
                        // SDK calls and calling it every loop keeps the LCD busy, so
                        // cache it and use the one-call status heartbeat in between.
                        if (info == null || DateTime.UtcNow - infoReadAt > TimeSpan.FromMinutes(5))
                        {
                            info = device.ReadInfo();
                            infoReadAt = DateTime.UtcNow;
                        }
                        else if (!device.IsAlive())
                        {
                            throw new InvalidOperationException("LX15 stopped responding");
                        }
                        EnsureAttendancePoller(device, outbox, info.Serial);

                        string syncMessage = null;
                        var config = BridgeConfig.Load();
                        if (config.IsConfigured)
                        {
                            try
                            {
                                sync.HeartbeatAsync(config, Stop.Token).GetAwaiter().GetResult();
                                sync.PushPendingAsync(outbox, config, Stop.Token).GetAwaiter().GetResult();
                                // Enrollment owns the terminal while a finger is being
                                // registered; pulling commands here used to race a second
                                // EnsureUser/ReadInfo sequence that rebooted the LX15 and
                                // wiped the fresh fingerprint.
                                var commands = IsEnrollmentActive()
                                    ? new List<DeviceCommand>()
                                    : sync.PullCommandsAsync(config, Stop.Token).GetAwaiter().GetResult(); Debug("PULL count=" + commands.Count);
                                using (var worker = new EnrollmentWorker(device))
                                {
                                    worker.Progress = delegate(EnrollmentProgress progress)
                                    {
                                        SetEnrollment(server, null, progress.DeviceUserId, progress.Status, progress.Message);
                                    };
                                    foreach (var command in commands)
                                    {
                                        // The enrollment flow just created this terminal user;
                                        // re-running the create command would DisableDevice +
                                        // SetUserInfo + RefreshData right after the registration.
                                        if (command.Type == "create_user" && WasUserWrittenRecently(command.DeviceUserId))
                                        {
                                            Debug("SKIP create_user replay " + command.Id);
                                            sync.CompleteAsync(config, command, Stop.Token).GetAwaiter().GetResult();
                                            continue;
                                        }
                                        SetEnrollment(server, command.Id, command.DeviceUserId, "starting", command.Type);
                                        var result = worker.ExecuteAsync(command, Stop.Token).GetAwaiter().GetResult();
                                        Debug("CMD " + command.Id + " " + command.Type + " result=" + result.Status + " error=" + result.Error);
                                        if (result.Status == "completed")
                                        {
                                            sync.CompleteAsync(config, command, Stop.Token).GetAwaiter().GetResult();
                                            Debug("FINISH completed " + command.Id);
                                        }
                                        else
                                        {
                                            sync.FailAsync(config, command, result.Error, Stop.Token).GetAwaiter().GetResult();
                                            Debug("FINISH failed " + command.Id + " " + result.Error);
                                        }
                                    }
                                }
                                lastSyncAt = DateTime.UtcNow.ToString("o");
                            }
                            catch (Exception syncError)
                            {
                                syncMessage = "sync delayed: " + SafeError(syncError);
                                 Debug("SYNC_ERROR " + syncMessage);
                            }
                        }

                        PublishStatus(server, "connected", info, lastSyncAt, outbox, syncMessage);
                    }
                    catch (Exception ex)
                    {
                        info = null;
                        infoReadAt = DateTime.MinValue;
                        StopAttendancePolling();
                        // Closing the SDK handle while enrollment holds the terminal
                        // corrupts the registration session; the enrollment worker
                        // fails on its own and the next pass performs the reconnect.
                        if (!IsEnrollmentActive()) device.Disconnect();
                        PublishStatus(server, ex is DllNotFoundException ? "driver-missing" : "device-missing", null, lastSyncAt, outbox, SafeError(ex));
                    }
                    Stop.Token.WaitHandle.WaitOne(5000);
                }
                StopAttendancePolling();
            }
            }
            finally
            {
                deviceMutex.ReleaseMutex();
                deviceMutex.Dispose();
            }
        }

        private static void PrintAttendance(OutboxEntry entry)
        {
            lock (ConsoleLock) Console.WriteLine(AttendanceJson.ToJson(entry));
        }

        private static void Run(string name, Action test)
        {
            try
            {
                test();
                lock (ConsoleLock) Console.WriteLine("PASS " + name);
            }
            catch (Exception ex)
            {
                exitCode = 1;
                lock (ConsoleLock)
                {
                    Console.Error.WriteLine("FAIL " + name + ": " + SafeError(ex));
                    Console.Error.WriteLine(ex.ToString());
                }
            }
        }

        internal static void RequestStop()
        {
            Stop.Cancel();
        }

        internal static bool IsStopping
        {
            get { return Stop.IsCancellationRequested; }
        }

        private static void OnCancelKeyPress(object sender, ConsoleCancelEventArgs e)
        {
            e.Cancel = true;
            Stop.Cancel();
        }

        private static void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            lock (ConsoleLock) Console.Error.WriteLine("FATAL: " + SafeError(e.ExceptionObject as Exception));
            exitCode = 1;
        }

        private static Dictionary<string, string> ParseOptions(string[] args, string[] allowedValues)
        {
            var options = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var i = 1; i < args.Length; i++)
            {
                var key = args[i];
                if (Array.IndexOf(allowedValues, key) < 0) throw new ArgumentException("unknown option: " + key);
                if (options.ContainsKey(key)) throw new ArgumentException("duplicate option: " + key);
                if (i + 1 >= args.Length || args[i + 1].StartsWith("--", StringComparison.Ordinal))
                    throw new ArgumentException("missing value for " + key);
                options.Add(key, args[++i]);
            }
            return options;
        }

        private static void RequireOnly(string[] args, string[] expected)
        {
                if (args.Length != 1 && !(args.Length == 2 && (args[1] == "--process-child" || args[1] == "--show-outbox-json"))) throw new ArgumentException("--self-test does not accept options");
        }

        private static int RequiredPort(IReadOnlyDictionary<string, string> options)
        {
            var text = Required(options, "--com");
            int value;
            if (!Int32.TryParse(text, out value) || value < 1 || value > 256)
                throw new ArgumentException("--com must be an integer between 1 and 256");
            return value;
        }

        private static string Required(IReadOnlyDictionary<string, string> options, string key)
        {
            string value;
            if (!options.TryGetValue(key, out value) || String.IsNullOrWhiteSpace(value))
                throw new ArgumentException(key + " is required");
            return value;
        }

        private static DeviceCommand Command(string type, string userId, string name)
        {
            return new DeviceCommand(Guid.NewGuid().ToString(), type, userId, name, 0, Guid.NewGuid().ToString("N"));
        }

        private static AttendanceEvent Sample(string userId, int workCode)
        {
            return new AttendanceEvent(userId, 1, 0, 2026, 11, 24, 9, 8, 7, workCode);
        }

        private static bool WaitUntil(Func<bool> condition, TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                if (condition()) return true;
                Thread.Sleep(10);
            }
            return condition();
        }

        private static void Require(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
        }

        private static void TryDeleteDirectory(string directory)
        {
            try { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private static string SafeError(Exception error)
        {
            return error == null || String.IsNullOrWhiteSpace(error.Message) ? "operation failed" : error.Message;
        }
    }

    internal static class DeviceJson
    {
        public static string ToJson(DeviceInfo info)
        {
            return Json.Object(new[]
            {
                CommandResult.Pair("serial", Json.Escape(info.Serial)),
                CommandResult.Pair("firmware", Json.Escape(info.Firmware)),
                CommandResult.Pair("algorithm", Json.Escape(info.Algorithm)),
                CommandResult.Pair("users", Json.Number(info.Users)),
                CommandResult.Pair("fingerprints", Json.Number(info.Fingerprints)),
                CommandResult.Pair("records", Json.Number(info.Records))
            });
        }
    }

    internal static class EnrollmentJson
    {
        public static string ToJson(EnrollmentResult result)
        {
            return Json.Object(new[]
            {
                CommandResult.Pair("device_user_id", Json.Escape(result.DeviceUserId)),
                CommandResult.Pair("status", Json.Escape(result.Status)),
                CommandResult.Pair("template_length", Json.Number(result.TemplateLength)),
                CommandResult.Pair("error", Json.Escape(result.Error))
            });
        }
    }

    internal static class AttendanceJson
    {
        public static string ToJson(OutboxEntry entry)
        {
            var item = entry.Payload;
            var timestamp = item.Year.ToString("D4") + "-" + item.Month.ToString("D2") + "-" + item.Day.ToString("D2") +
                "T" + item.Hour.ToString("D2") + ":" + item.Minute.ToString("D2") + ":" + item.Second.ToString("D2");
            return Json.Object(new[]
            {
                CommandResult.Pair("event_id", Json.Escape(entry.EventId)),
                CommandResult.Pair("payload_hash", Json.Escape(entry.PayloadHash)),
                CommandResult.Pair("device_user_id", Json.Escape(item.DeviceUserId)),
                CommandResult.Pair("device_timestamp", Json.Escape(timestamp)),
                CommandResult.Pair("verify_mode", Json.Number(item.VerifyMode)),
                CommandResult.Pair("raw_state", Json.Number(item.RawState)),
                CommandResult.Pair("work_code", Json.Number(item.WorkCode))
            });
        }
    }
}
