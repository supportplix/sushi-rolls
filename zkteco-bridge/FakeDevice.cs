using System;
using System.Collections.Generic;

namespace SushiRolls.ZkTeco
{
    public sealed class FakeDevice : IZkTecoDevice
    {
        private readonly object sync = new object();
        private readonly List<AttendanceEvent> pending = new List<AttendanceEvent>();
        private readonly HashSet<string> users = new HashSet<string>(StringComparer.Ordinal);
        private string enrollingUser = "";
        private bool connected;
        private int polls;
        private int pollLimit = int.MaxValue;
        private bool timeoutConfigured;
        private bool failCreate;
        private bool failStart;

        public bool Connected { get { lock (sync) return connected; } }
        public int LastError { get { return 0; } }
        public int ConnectCalls { get; private set; }
        public int DisconnectCalls { get; private set; }
        public int AttendanceReadCalls { get; private set; }
        public int StartEnrollmentCalls { get; private set; }
        public int CancelEnrollmentCalls { get; private set; }
        public bool CompleteEnrollmentOnNextPoll { get; set; }
        public bool FailNextEnrollmentPoll { get; set; }
        public bool EnrollmentActive { get { lock (sync) return enrollingUser.Length != 0; } }

        public void ConfigureSuccessEnrollment()
        {
            lock (sync) CompleteEnrollmentOnNextPoll = true;
        }

        public void ConfigureTimeout(int polls)
        {
            if (polls < 0) throw new ArgumentOutOfRangeException("polls");
            lock (sync)
            {
                pollLimit = polls;
                timeoutConfigured = true;
                CompleteEnrollmentOnNextPoll = false;
            }
        }

        public void ConfigureFailures(bool create, bool start)
        {
            lock (sync)
            {
                failCreate = create;
                failStart = start;
            }
        }

        public bool Connect(int comPort, int machineNumber = 1, int baudRate = 115200)
        {
            if (comPort < 1 || comPort > 256) throw new ArgumentOutOfRangeException("comPort");
            if (machineNumber < 1 || machineNumber > int.MaxValue) throw new ArgumentOutOfRangeException("machineNumber");
            if (baudRate <= 0) throw new ArgumentOutOfRangeException("baudRate");
            lock (sync) connected = true;
            ConnectCalls++;
            return true;
        }

        public DeviceInfo ReadInfo()
        {
            lock (sync) RequireConnected();
            return new DeviceInfo("FAKE-LX15", "FAKE-1.0", "fingerprint", users.Count, users.Count, pending.Count + AttendanceReadCalls);
        }

        public bool EnsureUser(string deviceUserId, string name, int privilege = 0)
        {
            ValidateUser(deviceUserId, name, privilege);
            lock (sync)
            {
                RequireConnected();
                if (failCreate) return false;
                users.Add(deviceUserId);
                return true;
            }
        }

        public bool StartEnrollment(string deviceUserId, int fingerIndex = 0)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            if (fingerIndex < 0 || fingerIndex > 9) throw new ArgumentOutOfRangeException("fingerIndex");
            lock (sync)
            {
                RequireConnected();
                if (failStart || !users.Contains(deviceUserId)) return false;
                enrollingUser = deviceUserId;
                polls = 0;
                if (!timeoutConfigured) pollLimit = int.MaxValue;
                timeoutConfigured = false;
                CompleteEnrollmentOnNextPoll = false;
                FailNextEnrollmentPoll = false;
                StartEnrollmentCalls++;
                return true;
            }
        }

        public EnrollmentResult PollEnrollment(string deviceUserId)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            lock (sync)
            {
                RequireConnected();
                if (enrollingUser != deviceUserId)
                    return new EnrollmentResult(deviceUserId, "failed", 0, "enrollment is not active for this user");

                polls++;
                if (FailNextEnrollmentPoll)
                {
                    FailNextEnrollmentPoll = false;
                    enrollingUser = "";
                    return new EnrollmentResult(deviceUserId, "failed", 0, "device read failed");
                }

                if (polls >= pollLimit)
                {
                    enrollingUser = "";
                    return new EnrollmentResult(deviceUserId, "timed_out", 0, "no template before timeout");
                }

                if (CompleteEnrollmentOnNextPoll || polls >= 2)
                {
                    enrollingUser = "";
                    return new EnrollmentResult(deviceUserId, "enrolled", 512, "");
                }

                return new EnrollmentResult(deviceUserId, "awaiting_scan", 0, "");
            }
        }

        public void CancelEnrollment()
        {
            lock (sync)
            {
                enrollingUser = "";
                CancelEnrollmentCalls++;
            }
        }

        public IReadOnlyList<AttendanceEvent> ReadNewAttendance()
        {
            lock (sync)
            {
                RequireConnected();
                AttendanceReadCalls++;
                var result = pending.ToArray();
                pending.Clear();
                return result;
            }
        }

        public void QueueAttendance(AttendanceEvent attendanceEvent)
        {
            if (attendanceEvent == null) throw new ArgumentNullException("attendanceEvent");
            lock (sync)
            {
                RequireConnected();
                pending.Add(attendanceEvent);
            }
        }

        public void DisableUser(string deviceUserId)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            lock (sync) RequireConnected();
        }

        public void DeleteUser(string deviceUserId)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            lock (sync)
            {
                RequireConnected();
                users.Remove(deviceUserId);
                if (enrollingUser == deviceUserId) enrollingUser = "";
            }
        }

        public void Disconnect()
        {
            lock (sync)
            {
                if (connected) DisconnectCalls++;
                connected = false;
                enrollingUser = "";
            }
        }

        public void Dispose()
        {
            Disconnect();
        }

        private void RequireConnected()
        {
            if (!connected) throw new InvalidOperationException("fake device is not connected");
        }

        private static void ValidateUser(string deviceUserId, string name, int privilege)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            if (String.IsNullOrWhiteSpace(name)) throw new ArgumentException("name is required", "name");
            if (privilege < 0 || privilege > 2) throw new ArgumentOutOfRangeException("privilege");
        }
    }
}
