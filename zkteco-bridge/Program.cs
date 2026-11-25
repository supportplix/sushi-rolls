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
        private static readonly object ConsoleLock = new object();

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
                    if (result.Status != "enrolled" || result.TemplateLength <= 0) exitCode = 1;
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
                AttendancePoller poller = null;
                string lastSyncAt = null;
                server.Start();
                while (!Stop.IsCancellationRequested)
                {
                    try
                    {
                        if (!device.Connect(0)) throw new InvalidOperationException("Z_Connect_USB_STD could not open the LX15");
                        var info = device.ReadInfo();
                        if (poller == null)
                        {
                            poller = new AttendancePoller(device, outbox, info.Serial, AttendancePoller.PollInterval, delegate { });
                            poller.RunAsync(Stop.Token);
                        }

                        string syncMessage = null;
                        var config = BridgeConfig.Load();
                        if (config.IsConfigured)
                        {
                            try
                            {
                                sync.HeartbeatAsync(config, Stop.Token).GetAwaiter().GetResult();
                                sync.PushPendingAsync(outbox, config, Stop.Token).GetAwaiter().GetResult();
                                var commands = sync.PullCommandsAsync(config, Stop.Token).GetAwaiter().GetResult();
                                using (var worker = new EnrollmentWorker(device))
                                {
                                    foreach (var command in commands)
                                    {
                                        var result = worker.ExecuteAsync(command, Stop.Token).GetAwaiter().GetResult();
                                        if (result.Status == "completed")
                                            sync.CompleteAsync(config, command, Stop.Token).GetAwaiter().GetResult();
                                        else
                                            sync.FailAsync(config, command, result.Error, Stop.Token).GetAwaiter().GetResult();
                                    }
                                }
                                lastSyncAt = DateTime.UtcNow.ToString("o");
                            }
                            catch (Exception syncError)
                            {
                                syncMessage = "sync delayed: " + SafeError(syncError);
                            }
                        }

                        server.UpdateStatus(new BridgeStatus
                        {
                            State = "connected",
                            DeviceName = "Attendance Device",
                            SerialNumber = info.Serial,
                            Firmware = info.Firmware,
                            Transport = "usb-std",
                            ComPort = null,
                            LastSeenAt = DateTime.UtcNow.ToString("o"),
                            LastSyncAt = lastSyncAt,
                            PendingOutbox = outbox.ReadPending().Count,
                            Message = syncMessage
                        });
                    }
                    catch (Exception ex)
                    {
                        if (poller != null)
                        {
                            poller.Dispose();
                            poller = null;
                        }
                        device.Disconnect();
                        server.UpdateStatus(new BridgeStatus
                        {
                            State = ex is DllNotFoundException ? "driver-missing" : "device-missing",
                            DeviceName = "Attendance Device",
                            Transport = "usb-std",
                            ComPort = null,
                            LastSeenAt = null,
                            LastSyncAt = lastSyncAt,
                            PendingOutbox = outbox.ReadPending().Count,
                            Message = SafeError(ex)
                        });
                    }
                    Stop.Token.WaitHandle.WaitOne(5000);
                }
                if (poller != null) poller.Dispose();
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
