using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace SushiRolls.ZkTeco
{
    public sealed class AttendancePoller : IDisposable
    {
        // Idle polls only query the device record counter; the full log transfer
        // runs when that counter changes. Three seconds keeps punches near-live
        // without holding the terminal on "Working".
        public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(3);
        private readonly IZkTecoDevice device;
        private readonly Outbox outbox;
        private readonly string deviceSerial;
        private readonly TimeSpan interval;
        private readonly Action<OutboxEntry> output;
        private readonly Queue<AttendanceEvent> persistBacklog = new Queue<AttendanceEvent>();
        private readonly object backlogSync = new object();
        private CancellationTokenSource stopSource;
        private Task worker;
        private readonly object sync = new object();
        private bool disposed;

        public AttendancePoller(IZkTecoDevice device, Outbox outbox, string deviceSerial)
            : this(device, outbox, deviceSerial, PollInterval, null) { }

        public AttendancePoller(IZkTecoDevice device, Outbox outbox, string deviceSerial, TimeSpan interval, Action<OutboxEntry> output)
        {
            if (device == null) throw new ArgumentNullException("device");
            if (outbox == null) throw new ArgumentNullException("outbox");
            if (String.IsNullOrWhiteSpace(deviceSerial)) throw new ArgumentException("device serial is required", "deviceSerial");
            if (interval <= TimeSpan.Zero) throw new ArgumentOutOfRangeException("interval");
            this.device = device;
            this.outbox = outbox;
            this.deviceSerial = deviceSerial;
            this.interval = interval;
            this.output = output ?? delegate { };
        }

        public int Cycles { get; private set; }
        public bool IsRunning { get { lock (sync) return worker != null && !worker.IsCompleted; } }
        public bool CancelRequested { get { lock (sync) return stopSource != null && stopSource.IsCancellationRequested; } }

        public Task RunAsync(CancellationToken cancellationToken)
        {
            ThrowIfDisposed();
            cancellationToken.ThrowIfCancellationRequested();
            lock (sync)
            {
                if (IsRunning) throw new InvalidOperationException("attendance poller is already running");
                stopSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                worker = Task.Factory.StartNew(() => RunCore(stopSource.Token), TaskCreationOptions.LongRunning).Unwrap();
                return worker;
            }
        }

        public void Cancel()
        {
            lock (sync)
            {
                if (stopSource != null) stopSource.Cancel();
            }
        }

        public int PollOnce()
        {
            ThrowIfDisposed();
            // ReadNewAttendance drains the device-side log; from that moment the
            // events exist only here. Persist the whole batch in ONE atomic outbox
            // write and, on ANY failure after the drain (device read, outbox IO,
            // mutex timeout), hold the events in a backlog so the next poll
            // retries them before draining more from the terminal — otherwise a
            // transient failure silently drops punches.
            List<AttendanceEvent> batch;
            lock (backlogSync)
            {
                batch = new List<AttendanceEvent>(persistBacklog);
                persistBacklog.Clear();
            }
            var persisted = false;
            try
            {
                var attendance = device.ReadNewAttendance();
                if (attendance != null)
                {
                    foreach (var item in attendance) batch.Add(item);
                }

                var added = new List<OutboxEntry>();
                if (batch.Count > 0)
                {
                    Exception lastError = null;
                    for (var attempt = 1; attempt <= 3; attempt++)
                    {
                        try
                        {
                            added.AddRange(outbox.AppendRange(batch, deviceSerial));
                            lastError = null;
                            break;
                        }
                        catch (Exception ex)
                        {
                            // One atomic write per batch, retried briefly: transient
                            // IO/mutex failures must not drop a drained punch batch.
                            if (attempt >= 3) lastError = ex;
                            else Thread.Sleep(250 * attempt);
                        }
                    }
                    if (lastError != null) throw lastError;
                }
                persisted = true;
                outbox.Flush();
                foreach (var entry in added)
                {
                    if (!entry.Synced) output(entry);
                }
                Cycles++;
                return added.Count;
            }
            finally
            {
                if (!persisted)
                {
                    lock (backlogSync)
                    {
                        foreach (var item in batch) persistBacklog.Enqueue(item);
                    }
                }
            }
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (disposed) return;
                Cancel();
                disposed = true;
            }
            var running = worker;
            if (running != null)
            {
                try { running.GetAwaiter().GetResult(); }
                catch (OperationCanceledException) { }
            }
            lock (sync)
            {
                if (stopSource != null)
                {
                    stopSource.Dispose();
                    stopSource = null;
                }
                worker = null;
            }
        }

        private async Task RunCore(CancellationToken cancellationToken)
        {
            var failures = 0;
            while (!cancellationToken.IsCancellationRequested)
            {
                var succeeded = false;
                try
                {
                    PollOnce();
                    succeeded = true;
                }
                catch (Exception)
                {
                    if (cancellationToken.IsCancellationRequested) break;
                    failures++;
                }

                if (succeeded)
                {
                    failures = 0;
                    await Task.Delay(interval, cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    var delay = TimeSpan.FromMilliseconds(Math.Min(30000, 250 * Math.Pow(2, Math.Min(failures, 7))));
                    await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
                }
            }
        }

        private void ThrowIfDisposed()
        {
            lock (sync)
            {
                if (disposed) throw new ObjectDisposedException("AttendancePoller");
            }
        }
    }
}
