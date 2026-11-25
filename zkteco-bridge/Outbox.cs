using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace SushiRolls.ZkTeco
{
    public sealed class OutboxEntry
    {
        public string EventId { get; set; }
        public string PayloadHash { get; set; }
        public AttendanceEvent Payload { get; set; }
        public DateTime CreatedAt { get; set; }
        public bool Synced { get; set; }

        public string ToJson()
        {
            return "{" +
                "\"event_id\":" + Json.Escape(EventId) + "," +
                "\"payload_hash\":" + Json.Escape(PayloadHash) + "," +
                "\"payload\":{" +
                    "\"device_user_id\":" + Json.Escape(Payload.DeviceUserId) + "," +
                    "\"verify_mode\":" + Json.Number(Payload.VerifyMode) + "," +
                    "\"raw_state\":" + Json.Number(Payload.RawState) + "," +
                    "\"year\":" + Json.Number(Payload.Year) + "," +
                    "\"month\":" + Json.Number(Payload.Month) + "," +
                    "\"day\":" + Json.Number(Payload.Day) + "," +
                    "\"hour\":" + Json.Number(Payload.Hour) + "," +
                    "\"minute\":" + Json.Number(Payload.Minute) + "," +
                    "\"second\":" + Json.Number(Payload.Second) + "," +
                    "\"work_code\":" + Json.Number(Payload.WorkCode) + "}," +
                "\"created_at\":" + Json.Escape(CreatedAt.ToString("o", System.Globalization.CultureInfo.InvariantCulture)) + "," +
                "\"synced\":" + Json.Bool(Synced) + "}";
        }
    }

    public sealed class Outbox : IDisposable
    {
        public const string DefaultDirectory = @"C:\ProgramData\SUSHI ROLLS\zkteco";
        private const string FileName = "outbox.json";
        private readonly object sync = new object();
        private readonly string filePath;
        private readonly Mutex fileMutex;
        private bool disposed;

        public Outbox() : this(Path.Combine(DefaultDirectory, FileName)) { }

        public Outbox(string filePath)
        {
            if (String.IsNullOrWhiteSpace(filePath)) throw new ArgumentException("outbox path is required", "filePath");
            this.filePath = Path.GetFullPath(filePath);
            var directory = Path.GetDirectoryName(this.filePath);
            if (String.IsNullOrEmpty(directory)) throw new ArgumentException("outbox path has no directory", "filePath");
            Directory.CreateDirectory(directory);
            fileMutex = new Mutex(false, @"Global\SushiRolls.ZkTeco.Outbox." + Convert.ToBase64String(Encoding.UTF8.GetBytes(directory.ToUpperInvariant())).Replace('/', '_').Replace('+', '-'));
            CleanupTemporaryFiles();
        }

        public string FilePath { get { return filePath; } }

        public OutboxEntry Append(AttendanceEvent attendanceEvent, string deviceSerial)
        {
            if (attendanceEvent == null) throw new ArgumentNullException("attendanceEvent");
            var hash = EventHash.For(attendanceEvent, deviceSerial);
            lock (sync)
            {
                CheckDisposed();
                return WithFileLock(() =>
                {
                    var entries = new List<OutboxEntry>(ReadAllCore());
                    foreach (var entry in entries)
                    {
                        if (String.Equals(entry.PayloadHash, hash, StringComparison.Ordinal)) return entry;
                    }
                    var added = new OutboxEntry
                    {
                        EventId = Guid.NewGuid().ToString("N"),
                        PayloadHash = hash,
                        Payload = attendanceEvent,
                        CreatedAt = DateTime.UtcNow,
                        Synced = false
                    };
                    entries.Add(added);
                    WriteAtomic(OutboxJson.WriteArray(entries));
                    return added;
                });
            }
        }

        public IReadOnlyList<OutboxEntry> ReadPending()
        {
            lock (sync)
            {
                CheckDisposed();
                return WithFileLock(() =>
                {
                    var pending = new List<OutboxEntry>();
                    foreach (var entry in ReadAllCore())
                    {
                        if (!entry.Synced) pending.Add(entry);
                    }
                    return (IReadOnlyList<OutboxEntry>)pending;
                });
            }
        }

        public bool MarkSynced(string eventId)
        {
            if (String.IsNullOrWhiteSpace(eventId)) throw new ArgumentException("event ID is required", "eventId");
            lock (sync)
            {
                CheckDisposed();
                return WithFileLock(() =>
                {
                    var entries = new List<OutboxEntry>(ReadAllCore());
                    var found = false;
                    foreach (var entry in entries)
                    {
                        if (entry.EventId != eventId || entry.Synced) continue;
                        entry.Synced = true;
                        found = true;
                    }
                    if (found) WriteAtomic(OutboxJson.WriteArray(entries));
                    return found;
                });
            }
        }

        public IReadOnlyList<OutboxEntry> ReadAll()
        {
            lock (sync)
            {
                CheckDisposed();
                return WithFileLock(() => ReadAllCore());
            }
        }

        public void Flush()
        {
            lock (sync)
            {
                CheckDisposed();
                WithFileLock(() =>
                {
                    if (File.Exists(filePath))
                    {
                        using (var stream = new FileStream(filePath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
                        {
                            stream.Flush(true);
                        }
                    }
                    return true;
                });
            }
        }

        public void Compact()
        {
            lock (sync)
            {
                CheckDisposed();
                WithFileLock(() =>
                {
                    var retained = new List<OutboxEntry>();
                    var hashes = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var entry in ReadAllCore())
                    {
                        if (!entry.Synced && hashes.Add(entry.PayloadHash)) retained.Add(entry);
                    }
                    WriteAtomic(OutboxJson.WriteArray(retained));
                    return true;
                });
            }
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (disposed) return;
                disposed = true;
                fileMutex.Dispose();
            }
        }

        private T WithFileLock<T>(Func<T> action)
        {
            var ownsMutex = false;
            try
            {
                try
                {
                    ownsMutex = fileMutex.WaitOne(TimeSpan.FromSeconds(10), false);
                    if (!ownsMutex) throw new TimeoutException("timed out waiting for the outbox file lock");
                }
                catch (AbandonedMutexException) { ownsMutex = true; }
                return action();
            }
            finally
            {
                if (ownsMutex) fileMutex.ReleaseMutex();
            }
        }

        private IReadOnlyList<OutboxEntry> ReadAllCore()
        {
            if (!File.Exists(filePath)) return new OutboxEntry[0];
            using (var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var reader = new StreamReader(stream, Encoding.UTF8, true))
            {
                return OutboxJson.ReadArray(reader.ReadToEnd());
            }
        }

        private void WriteAtomic(string json)
        {
            var tempPath = filePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    var bytes = new UTF8Encoding(false).GetBytes(json);
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (File.Exists(filePath)) File.Replace(tempPath, filePath, null);
                else File.Move(tempPath, filePath);
            }
            finally
            {
                if (File.Exists(tempPath)) File.Delete(tempPath);
            }
        }

        private void CleanupTemporaryFiles()
        {
            var directory = Path.GetDirectoryName(filePath);
            foreach (var path in Directory.GetFiles(directory, Path.GetFileName(filePath) + ".*.tmp", SearchOption.TopDirectoryOnly))
            {
                try { File.Delete(path); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }

        private void CheckDisposed()
        {
            if (disposed) throw new ObjectDisposedException("Outbox");
        }
    }
}
