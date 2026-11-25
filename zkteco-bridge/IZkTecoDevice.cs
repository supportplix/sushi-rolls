using System;
using System.Collections.Generic;

namespace SushiRolls.ZkTeco
{
    public interface IZkTecoDevice : IDisposable
    {
        int LastError { get; }
        bool Connect(int comPort, int machineNumber = 1, int baudRate = 115200);
        DeviceInfo ReadInfo();
        bool EnsureUser(string deviceUserId, string name, int privilege = 0);
        bool StartEnrollment(string deviceUserId, int fingerIndex = 0);
        EnrollmentResult PollEnrollment(string deviceUserId);
        void CancelEnrollment();
        IReadOnlyList<AttendanceEvent> ReadNewAttendance();
        void DisableUser(string deviceUserId);
        void DeleteUser(string deviceUserId);
        void Disconnect();
    }
}
