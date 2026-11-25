using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace SushiRolls.ZkTeco
{
    public sealed class CommandResult
    {
        public string CommandId { get; private set; }
        public string Type { get; private set; }
        public string Status { get; private set; }
        public string Error { get; private set; }

        public CommandResult(string commandId, string type, string status, string error)
        {
            CommandId = commandId ?? "";
            Type = type ?? "";
            Status = status ?? "";
            Error = error ?? "";
        }

        public string ToJson()
        {
            return Json.Object(new[]
            {
                Pair("command_id", Json.Escape(CommandId)),
                Pair("type", Json.Escape(Type)),
                Pair("status", Json.Escape(Status)),
                Pair("error", Json.Escape(Error))
            });
        }

        internal static KeyValuePair<string, string> Pair(string key, string value)
        {
            return new KeyValuePair<string, string>(key, value);
        }
    }

    public sealed class EnrollmentWorker : IDisposable
    {
        public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(60);
        public static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(750);

        private readonly IZkTecoDevice device;
        private readonly TimeSpan timeout;
        private readonly TimeSpan pollInterval;

        public EnrollmentWorker(IZkTecoDevice device) : this(device, DefaultTimeout, PollInterval) { }

        public EnrollmentWorker(IZkTecoDevice device, TimeSpan timeout, TimeSpan pollInterval)
        {
            if (device == null) throw new ArgumentNullException("device");
            if (timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException("timeout");
            if (pollInterval <= TimeSpan.Zero) throw new ArgumentOutOfRangeException("pollInterval");
            this.device = device;
            this.timeout = timeout;
            this.pollInterval = pollInterval;
        }

        public async Task<CommandResult> ExecuteAsync(DeviceCommand command, CancellationToken cancellationToken)
        {
            if (command == null) throw new ArgumentNullException("command");
            command.Validate();
            RequireConnected();
            try
            {
                switch (command.Type)
                {
                    case "create_user":
                    case "update_user":
                        if (!device.EnsureUser(command.DeviceUserId, command.Name, command.Privilege))
                            return Failure(command, "device user operation failed");
                        return new CommandResult(command.Id, command.Type, "completed", "");

                    case "start_enrollment":
                        if (!device.StartEnrollment(command.DeviceUserId, 0))
                            return Failure(command, "device enrollment start failed");
                        return await PollEnrollmentAsync(command, cancellationToken).ConfigureAwait(false);

                    case "disable_user":
                        device.DisableUser(command.DeviceUserId);
                        return new CommandResult(command.Id, command.Type, "completed", "");

                    case "delete_user":
                        device.DeleteUser(command.DeviceUserId);
                        return new CommandResult(command.Id, command.Type, "completed", "");

                    default:
                        return Failure(command, "unsupported command type");
                }
            }
            catch (OperationCanceledException)
            {
                return Failure(command, "cancelled");
            }
            catch (Exception ex)
            {
                return Failure(command, SafeError(ex));
            }
        }

        public void Dispose()
        {
            CancelPendingEnrollment();
        }

        private void CancelPendingEnrollment()
        {
            try { device.CancelEnrollment(); }
            catch (Exception) { }
        }

        private void RequireConnected()
        {
            try { device.ReadInfo(); }
            catch (Exception ex) { throw new InvalidOperationException("device is not connected: " + SafeError(ex)); }
        }

        public Task<EnrollmentResult> ExecuteEnrollmentAsync(string deviceUserId, CancellationToken cancellationToken)
        {
            return ExecuteEnrollmentAsync(deviceUserId, DefaultTimeout, cancellationToken);
        }

        public async Task<EnrollmentResult> ExecuteEnrollmentAsync(string deviceUserId, TimeSpan timeout, CancellationToken cancellationToken)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            if (timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException("timeout");
            RequireConnected();
            try
            {
                if (!device.StartEnrollment(deviceUserId, 0))
                    return new EnrollmentResult(deviceUserId, "failed", 0, "device enrollment start failed");

                var deadline = DateTime.UtcNow + timeout;
                var result = device.PollEnrollment(deviceUserId);
                while (result.Status == "awaiting_scan" || result.Status == "scanning")
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (DateTime.UtcNow >= deadline)
                        return new EnrollmentResult(deviceUserId, "timed_out", 0, "no template before timeout");
                    await Task.Delay(pollInterval, cancellationToken).ConfigureAwait(false);
                    result = device.PollEnrollment(deviceUserId);
                }
                return result;
            }
            catch (OperationCanceledException)
            {
                return new EnrollmentResult(deviceUserId, "cancelled", 0, "cancelled");
            }
            catch (Exception ex)
            {
                return new EnrollmentResult(deviceUserId, "failed", 0, SafeError(ex));
            }
            finally
            {
                CancelPendingEnrollment();
            }
        }

        private async Task<CommandResult> PollEnrollmentAsync(DeviceCommand command, CancellationToken cancellationToken)
        {
            var deadline = DateTime.UtcNow + timeout;
            try
            {
                var result = device.PollEnrollment(command.DeviceUserId);
                while (result.Status == "awaiting_scan" || result.Status == "scanning")
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (DateTime.UtcNow >= deadline)
                        return new CommandResult(command.Id, command.Type, "timed_out", "no template before timeout");
                    await Task.Delay(pollInterval, cancellationToken).ConfigureAwait(false);
                    result = device.PollEnrollment(command.DeviceUserId);
                }

                var status = result.Status == "enrolled" && result.TemplateLength > 0
                    ? "completed"
                    : (result.Status == "timed_out" ? "timed_out" : "failed");
                var error = status == "completed" ? "" : (String.IsNullOrWhiteSpace(result.Error) ? "template was not enrolled" : result.Error);
                return new CommandResult(command.Id, command.Type, status, error);
            }
            finally
            {
                CancelPendingEnrollment();
            }
        }

        private static CommandResult Failure(DeviceCommand command, string error)
        {
            return new CommandResult(command.Id, command.Type, "failed", error);
        }

        private static string SafeError(Exception error)
        {
            return String.IsNullOrWhiteSpace(error.Message) ? "device operation failed" : error.Message;
        }
    }
}
