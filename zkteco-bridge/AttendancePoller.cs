using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace SushiRolls.ZkTeco
{
    public sealed class AttendancePoller : IDisposable
    {
        public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);
        private readonly IZkTecoDevice device;
        private readonly Outbox outbox;
        private readonly string deviceSerial;
        private readonly TimeSpan interval;
        private readonly Action<OutboxEntry> output;
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
            var attendance = device.ReadNewAttendance();
            var added = new List<OutboxEntry>();
            foreach (var item in attendance)
            {
                added.Add(outbox.Append(item, deviceSerial));
            }
            outbox.Flush();
            foreach (var entry in added)
            {
                if (!entry.Synced) output(entry);
            }
            Cycles++;
            return added.Count;
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
