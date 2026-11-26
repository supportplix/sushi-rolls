using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace SushiRolls.ZkTeco
{
    public sealed class ZkTecoUsbDevice : IZkTecoDevice
    {
        private const ushort Vid = 0x1B55;
        private const int Pid = 0x0A01;
        private const int MachineNumber = 1;
        private readonly object sync = new object();
        private IntPtr handle;
        private bool disposed;
        private int fingerprintBaseline;
        private int lastRecordCount = -1;

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern IntPtr Z_Connect_USB_STD(ushort vid, int reserved, int pid, int machineNumber);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern void Z_Close(IntPtr handle);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_GetSerialNumber(IntPtr handle, [MarshalAs(UnmanagedType.LPStr)] StringBuilder buffer);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_GetFirmwareVersion(IntPtr handle, [MarshalAs(UnmanagedType.LPStr)] StringBuilder buffer);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_GetDeviceStatus(IntPtr handle, int statusType, out int value);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_LastError(IntPtr handle);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_DisableDevice(IntPtr handle);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_EnableDevice(IntPtr handle);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_RefreshData(IntPtr handle);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int SSR_Z_SetUserInfo(IntPtr handle,
            [MarshalAs(UnmanagedType.LPStr)] string deviceUserId,
            [MarshalAs(UnmanagedType.LPStr)] string name,
            int privilege,
            bool enabled,
            [MarshalAs(UnmanagedType.LPStr)] string password,
            [MarshalAs(UnmanagedType.LPStr)] string cardNumber,
            int fingerIndex,
            IntPtr cardBinary);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int SSR_Z_DelUserTmpExt(IntPtr handle,
            [MarshalAs(UnmanagedType.LPStr)] string deviceUserId,
            int fingerIndex);

        // These two SDK calls return a one-byte boolean. Declaring them as int leaves
        // garbage in the upper bits (e.g. 55567), which made a failed call look successful.
        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.I1)]
        private static extern bool Z_StartEnrollEx(IntPtr handle,
            [MarshalAs(UnmanagedType.LPStr)] string deviceUserId,
            int fingerIndex,
            int flag);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int SSR_Z_GetUserTmp(IntPtr handle,
            [MarshalAs(UnmanagedType.LPStr)] string deviceUserId,
            int fingerIndex,
            IntPtr template,
            ref int templateLength);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_CancelOperation(IntPtr handle);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_ReadLog(IntPtr handle, int machineNumber, int dataFlag);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int Z_SSR_GetLog(IntPtr handle,
            [MarshalAs(UnmanagedType.LPStr)] StringBuilder deviceUserId,
            ref int verifyMode,
            ref int rawState,
            ref int year,
            ref int month,
            ref int day,
            ref int hour,
            ref int minute,
            ref int second,
            ref int workCode);

        [DllImport("zkemsdk.dll", CallingConvention = CallingConvention.StdCall, ExactSpelling = true)]
        private static extern int SSR_Z_DelUser(IntPtr handle, [MarshalAs(UnmanagedType.LPStr)] string deviceUserId);

        public int LastError { get { lock (sync) return handle == IntPtr.Zero ? -1 : Z_LastError(handle); } }

        public bool Connect(int comPort, int machineNumber = 1, int baudRate = 115200)
        {
            lock (sync)
            {
                ThrowIfDisposed();
                if (handle != IntPtr.Zero) return true;
                handle = Z_Connect_USB_STD(Vid, 0, Pid, MachineNumber);
                if (handle == IntPtr.Zero) return false;
                lastRecordCount = -1;
                // A terminated previous session can leave the LX15 stuck on "Working"
                // with its scanner disabled. Always bring it back to a clean state on
                // every connect (startup, service restart or reconnect).
                Z_EnableDevice(handle);
                Z_RefreshData(handle);
                return true;
            }
        }

        public DeviceInfo ReadInfo()
        {
            lock (sync)
            {
                RequireConnected();
                var serial = new StringBuilder(256);
                var firmware = new StringBuilder(256);
                int users, fingerprints, records;
                if (Z_GetSerialNumber(handle, serial) <= 0 || Z_GetFirmwareVersion(handle, firmware) <= 0 ||
                    Z_GetDeviceStatus(handle, 2, out users) <= 0 ||
                    Z_GetDeviceStatus(handle, 3, out fingerprints) <= 0 ||
                    Z_GetDeviceStatus(handle, 6, out records) <= 0 || serial.Length == 0)
                {
                    throw new InvalidOperationException("LX15 identity query failed; SDK error " + LastError);
                }
                return new DeviceInfo(serial.ToString(), firmware.ToString(), "ZKFinger", users, fingerprints, records);
            }
        }

        public bool EnsureUser(string deviceUserId, string name, int privilege = 0)
        {
            ValidateUser(deviceUserId, name, privilege);
            lock (sync)
            {
                RequireConnected();
                Z_DisableDevice(handle);
                try
                {
                    var result = SSR_Z_SetUserInfo(handle, deviceUserId, name, privilege, true, "", "", 0, IntPtr.Zero);
                    if (result <= 0) return false;
                    Z_RefreshData(handle);
                    return true;
                }
                finally
                {
                    Z_EnableDevice(handle);
                }
            }
        }

        public bool StartEnrollment(string deviceUserId, int fingerIndex = 0)
        {
            ValidateFinger(deviceUserId, fingerIndex);
            lock (sync)
            {
                RequireConnected();
                // Match the official ZKEM demo sequence exactly: cancel, delete any old
                // template, then start enrollment. Querying a template before starting
                // leaves the LX15 in a "Working" state without showing the finger prompt.
                Z_CancelOperation(handle);
                SSR_Z_DelUserTmpExt(handle, deviceUserId, fingerIndex);
                // Polling SSR_Z_GetUserTmp while the terminal is in enrollment mode blocks
                // this handle. The fingerprint counter is a non-blocking completion signal.
                if (Z_GetDeviceStatus(handle, 3, out fingerprintBaseline) <= 0) return false;
                // Do NOT call StartIdentify here: on the LX15 it takes the terminal out of
                // the enrollment prompt and shows "Working" instead of asking for a finger.
                return Z_StartEnrollEx(handle, deviceUserId, fingerIndex, 0);
            }
        }

        public EnrollmentResult PollEnrollment(string deviceUserId)
        {
            ValidateFinger(deviceUserId, 0);
            lock (sync)
            {
                RequireConnected();
                int count;
                if (Z_GetDeviceStatus(handle, 3, out count) <= 0)
                    return new EnrollmentResult(deviceUserId, "failed", 0, "fingerprint counter query failed; SDK error " + LastError);
                if (count <= fingerprintBaseline) return new EnrollmentResult(deviceUserId, "awaiting_scan", 0, "");
                // A counter increase is the authoritative enrollment signal on this
                // firmware: reading the template back with SSR_Z_GetUserTmp fails
                // with SDK error -13012 even though the registration succeeded.
                // Templates are never persisted, so the length stays best-effort.
                return new EnrollmentResult(deviceUserId, "enrolled", BestEffortTemplateLength(deviceUserId, 0), "");
            }
        }

        private int BestEffortTemplateLength(string deviceUserId, int fingerIndex)
        {
            // Diagnostic only: a -13012 read failure must not veto the counter signal.
            try
            {
                var buffer = new byte[2048];
                var pinned = GCHandle.Alloc(buffer, GCHandleType.Pinned);
                try
                {
                    var length = buffer.Length;
                    var result = SSR_Z_GetUserTmp(handle, deviceUserId, fingerIndex, pinned.AddrOfPinnedObject(), ref length);
                    if (result > 0 && length > 0) return length;
                    return 0;
                }
                finally
                {
                    pinned.Free();
                    Array.Clear(buffer, 0, buffer.Length);
                }
            }
            catch (Exception)
            {
                return 0;
            }
        }

        public void CancelEnrollment()
        {
            lock (sync)
            {
                if (!disposed && handle != IntPtr.Zero) Z_CancelOperation(handle);
            }
        }

        public IReadOnlyList<AttendanceEvent> ReadNewAttendance()
        {
            lock (sync)
            {
                RequireConnected();
                // Z_ReadNewAttLog is not reliable on the LX15 firmware (Ver 6.60):
                // it returns nothing and leaves the terminal on "Working". Use the
                // proven Z_ReadLog + SSR_Z_GetLog sequence, but only when the device
                // record counter changed. An idle poll then costs one status call
                // instead of a full log transfer that freezes the keypad.
                int recordCount;
                var countKnown = Z_GetDeviceStatus(handle, 6, out recordCount) > 0;
                if (countKnown && recordCount == lastRecordCount)
                    return new AttendanceEvent[0];
                try
                {
                    var read = Z_ReadLog(handle, 0, 0);
                    if (read < 0)
                        throw new InvalidOperationException("attendance log read failed; SDK error " + LastError);
                    var result = new List<AttendanceEvent>();
                    while (true)
                    {
                        var userId = new StringBuilder(256);
                        var verify = 0;
                        var state = 0;
                        var year = 0;
                        var month = 0;
                        var day = 0;
                        var hour = 0;
                        var minute = 0;
                        var second = 0;
                        var workCode = 0;
                        var item = Z_SSR_GetLog(handle, userId, ref verify, ref state, ref year, ref month, ref day,
                            ref hour, ref minute, ref second, ref workCode);
                        if (item <= 0) break;
                        try
                        {
                            result.Add(new AttendanceEvent(userId.ToString(), verify, state, year, month, day, hour, minute, second, workCode));
                        }
                        catch (ArgumentException)
                        {
                            // Keep draining the SDK buffer so one malformed record cannot discard later punches.
                        }
                    }
                    if (countKnown) lastRecordCount = recordCount;
                    return result;
                }
                finally
                {
                    // Z_ReadLog holds the terminal in a data-transfer state. Re-enable
                    // it so the LCD returns to its normal clock screen immediately.
                    Z_EnableDevice(handle);
                }
            }
        }

        public int ReadFingerprintCount()
        {
            lock (sync)
            {
                RequireConnected();
                int count;
                if (Z_GetDeviceStatus(handle, 3, out count) <= 0)
                    throw new InvalidOperationException("fingerprint counter query failed; SDK error " + LastError);
                return count;
            }
        }

        public bool IsAlive()
        {
            lock (sync)
            {
                if (disposed || handle == IntPtr.Zero) return false;
                int users;
                return Z_GetDeviceStatus(handle, 2, out users) > 0;
            }
        }

        public void DisableUser(string deviceUserId)
        {
            DeleteUser(deviceUserId);
        }

        public void DeleteUser(string deviceUserId)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId) || deviceUserId.Length > 24)
                throw new ArgumentException("device user ID must contain at most 24 digits", "deviceUserId");
            foreach (var character in deviceUserId)
                if (character < '0' || character > '9')
                    throw new ArgumentException("device user ID must contain at most 24 digits", "deviceUserId");
            lock (sync)
            {
                RequireConnected();
                if (SSR_Z_DelUser(handle, deviceUserId) <= 0) throw new InvalidOperationException("delete user failed; SDK error " + LastError);
            }
        }

        public void Disconnect()
        {
            lock (sync)
            {
                if (handle == IntPtr.Zero) return;
                // Release any in-progress terminal operation so the next process
                // (or the same device on another PC) does not boot into "Working".
                Z_CancelOperation(handle);
                Z_EnableDevice(handle);
                Z_Close(handle);
                handle = IntPtr.Zero;
                lastRecordCount = -1;
            }
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (disposed) return;
                Disconnect();
                disposed = true;
            }
        }

        private void RequireConnected()
        {
            ThrowIfDisposed();
            if (handle == IntPtr.Zero) throw new InvalidOperationException("device is not connected");
        }

        private void ThrowIfDisposed()
        {
            if (disposed) throw new ObjectDisposedException("ZkTecoUsbDevice");
        }

        private static void ValidateUser(string deviceUserId, string name, int privilege)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId) || deviceUserId.Length > 24)
                throw new ArgumentException("device user ID must contain at most 24 digits", "deviceUserId");
            foreach (var character in deviceUserId)
                if (character < '0' || character > '9')
                    throw new ArgumentException("device user ID must contain at most 24 digits", "deviceUserId");
            if (String.IsNullOrWhiteSpace(name)) throw new ArgumentException("name is required", "name");
            if (privilege < 0 || privilege > 2) throw new ArgumentOutOfRangeException("privilege");
        }

        private static void ValidateFinger(string deviceUserId, int fingerIndex)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId) || deviceUserId.Length > 24)
                throw new ArgumentException("device user ID must contain at most 24 digits", "deviceUserId");
            foreach (var character in deviceUserId)
                if (character < '0' || character > '9')
                    throw new ArgumentException("device user ID must contain at most 24 digits", "deviceUserId");
            if (fingerIndex < 0 || fingerIndex > 9) throw new ArgumentOutOfRangeException("fingerIndex");
        }
    }
}
