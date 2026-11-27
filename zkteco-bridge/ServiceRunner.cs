using System;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SushiRolls.ZkTeco
{
    internal sealed class ZkTecoWindowsService : ServiceBase
    {
        private static readonly string LogPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "SUSHI ROLLS", "zkteco", "service.log");

        private Task worker;

        public ZkTecoWindowsService()
        {
            ServiceName = "SushiRolls.ZkTeco";
            CanStop = true;
            CanPauseAndContinue = false;
        }

        protected override void OnStart(string[] args)
        {
            worker = Task.Factory.StartNew(RunWorker, TaskCreationOptions.LongRunning);
        }

        protected override void OnStop()
        {
            Program.RequestStop();
            if (worker != null) worker.Wait(TimeSpan.FromSeconds(10));
        }

        private static void RunWorker()
        {
            // The app may spawn its own bridge during startup. RunPipe() then exits
            // with BUSY, and a one-shot worker would leave the service running with
            // no named pipe forever. Retry until the device is free or we stop.
            while (!Program.IsStopping)
            {
                try
                {
                    Program.RunPipe();
                }
                catch (Exception ex)
                {
                    // "One or more errors occurred." alone never identifies the failing
                    // call, so record the type, the full chain and the stack.
                    Log("worker error: " + DescribeException(ex));
                }
                if (Program.IsStopping) break;
                Log("bridge worker exited; retrying in 5 seconds");
                Thread.Sleep(TimeSpan.FromSeconds(5));
            }
            Log("bridge worker stopped");
        }

        private static string DescribeException(Exception ex)
        {
            if (ex == null) return "<null>";
            var text = new StringBuilder();
            text.Append(ex.GetType().FullName).Append(": ").Append(ex.Message);
            var current = ex;
            while (current.InnerException != null)
            {
                current = current.InnerException;
                text.Append(" -> ").Append(current.GetType().FullName).Append(": ").Append(current.Message);
            }
            if (ex.StackTrace != null)
            {
                text.AppendLine();
                text.Append(ex.StackTrace);
            }
            return text.ToString();
        }
        private static void Log(string message)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
                File.AppendAllText(LogPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        public static void Run()
        {
            ServiceBase.Run(new ZkTecoWindowsService());
        }
    }
}
