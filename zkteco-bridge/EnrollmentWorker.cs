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

    public sealed class EnrollmentProgress
    {
        public string DeviceUserId;
        public string Status;
        public string Message;
        public string UpdatedAt;

        public Dictionary<string, string> ToFields()
        {
            return new Dictionary<string, string>
            {
                { "device_user_id", Json.Escape(DeviceUserId ?? "") },
                { "status", Json.Escape(Status ?? "") },
                { "message", Json.Escape(Message ?? "") },
                { "updated_at", Json.Escape(UpdatedAt ?? "") }
            };
        }
    }

    public sealed class EnrollmentWorker : IDisposable
    {
        public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(60);
        public static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(750);

        private readonly IZkTecoDevice device;
        private readonly TimeSpan timeout;
        private readonly TimeSpan pollInterval;
        public Action<EnrollmentProgress> Progress;

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
            // Use the worker's configured timeout: the pipe's timeoutSeconds is
            // passed to the constructor, and hard-coding DefaultTimeout here made
            // every direct enrollment ignore it and expire after 60 seconds.
            return ExecuteEnrollmentAsync(deviceUserId, timeout, cancellationToken);
        }

        public async Task<EnrollmentResult> ExecuteEnrollmentAsync(string deviceUserId, TimeSpan timeout, CancellationToken cancellationToken)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            if (timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException("timeout");
            RequireConnected();
            try
            {
                if (!device.StartEnrollment(deviceUserId, 0))
                {
                    Report(deviceUserId, "failed", "device enrollment start failed; SDK error " + device.LastError);
                    return new EnrollmentResult(deviceUserId, "failed", 0, "device enrollment start failed");
                }
                Report(deviceUserId, "awaiting_scan", "place your finger on the device");

                var deadline = DateTime.UtcNow + timeout;
                var result = device.PollEnrollment(deviceUserId);
                while (result.Status == "awaiting_scan" || result.Status == "scanning")
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (DateTime.UtcNow >= deadline)
                    {
                        Report(deviceUserId, "timed_out", "no template before timeout");
                        return new EnrollmentResult(deviceUserId, "timed_out", 0, "no template before timeout");
                    }
                    if (result.Status == "scanning") Report(deviceUserId, "scanning", "reading fingerprint");
                    await Task.Delay(pollInterval, cancellationToken).ConfigureAwait(false);
                    result = device.PollEnrollment(deviceUserId);
                }
                Report(deviceUserId, result.Status, result.Error);
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
                Report(command.DeviceUserId, "awaiting_scan", "place your finger on the device");
                var result = device.PollEnrollment(command.DeviceUserId);
                while (result.Status == "awaiting_scan" || result.Status == "scanning")
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (DateTime.UtcNow >= deadline)
                    {
                        Report(command.DeviceUserId, "timed_out", "no template before timeout");
                        return new CommandResult(command.Id, command.Type, "timed_out", "no template before timeout");
                    }
                    if (result.Status == "scanning") Report(command.DeviceUserId, "scanning", "reading fingerprint");
                    await Task.Delay(pollInterval, cancellationToken).ConfigureAwait(false);
                    result = device.PollEnrollment(command.DeviceUserId);
                }

                // The fingerprint counter increase (not a template read) is the
                // enrollment signal, so "enrolled" alone completes the command.
                var status = result.Status == "enrolled"
                    ? "completed"
                    : (result.Status == "timed_out" ? "timed_out" : "failed");
                var error = status == "completed" ? "" : (String.IsNullOrWhiteSpace(result.Error) ? "template was not enrolled" : result.Error);
                Report(command.DeviceUserId, status == "completed" ? "enrolled" : status, error);
                return new CommandResult(command.Id, command.Type, status, error);
            }
            finally
            {
                CancelPendingEnrollment();
            }
        }

        private void Report(string deviceUserId, string status, string message)
        {
            if (Progress == null) return;
            try
            {
                Progress(new EnrollmentProgress
                {
                    DeviceUserId = deviceUserId ?? "",
                    Status = status ?? "",
                    Message = String.IsNullOrWhiteSpace(message) ? "" : message,
                    UpdatedAt = DateTime.UtcNow.ToString("o")
                });
            }
            catch (Exception) { }
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
