using System;
using System.ServiceProcess;

namespace SushiRolls.ZkTeco
{
    internal sealed class ZkTecoWindowsService : ServiceBase
    {
        private System.Threading.Tasks.Task worker;

        public ZkTecoWindowsService()
        {
            ServiceName = "SushiRolls.ZkTeco";
            CanStop = true;
            CanPauseAndContinue = false;
        }

        protected override void OnStart(string[] args)
        {
            worker = System.Threading.Tasks.Task.Factory.StartNew(() => Program.RunPipe(),
                System.Threading.Tasks.TaskCreationOptions.LongRunning);
        }

        protected override void OnStop()
        {
            Program.RequestStop();
            if (worker != null) worker.Wait(TimeSpan.FromSeconds(10));
        }

        public static void Run()
        {
            ServiceBase.Run(new ZkTecoWindowsService());
        }
    }
}
