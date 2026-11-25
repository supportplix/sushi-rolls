using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;

namespace SushiRolls.ZkTeco
{
    public sealed class ZkTecoComDevice : IZkTecoDevice
    {
        private readonly object sync = new object();
        private readonly object sdk;
        private readonly int comPort;
        private readonly int machineNumber;
        private bool connected;
        private bool disposed;

        public ZkTecoComDevice(int comPort, int machineNumber = 1)
        {
            if (comPort < 1 || comPort > 256) throw new ArgumentOutOfRangeException("comPort");
            if (machineNumber < 1 || machineNumber > int.MaxValue) throw new ArgumentOutOfRangeException("machineNumber");
            this.comPort = comPort;
            this.machineNumber = machineNumber;
            var type = Type.GetTypeFromProgID("zkemkeeper.ZKEM");
            if (type == null) throw new InvalidOperationException("ZKEM COM is not registered");
            sdk = Activator.CreateInstance(type);
        }

        public int LastError
        {
            get { lock (sync) return Convert.ToInt32(Invoke("GetLastErrorCode", Type.Missing, BindingFlags.OptionalParamBinding), CultureInfo.InvariantCulture); }
        }

        public bool Connect(int ignoredComPort, int ignoredMachineNumber = 1, int baudRate = 115200)
        {
            if (baudRate <= 0) throw new ArgumentOutOfRangeException("baudRate");
            lock (sync)
            {
                ThrowIfDisposed();
                if (connected) return true;
                var result = Invoke("Connect_Com", comPort, machineNumber, baudRate);
                connected = Convert.ToInt32(result, CultureInfo.InvariantCulture) != 0;
                return connected;
            }
        }

        public DeviceInfo ReadInfo()
        {
            lock (sync)
            {
                RequireConnected();
                var status = Convert.ToInt32(Invoke("GetDeviceStatus", machineNumber, Type.Missing, BindingFlags.OptionalParamBinding), CultureInfo.InvariantCulture);
                if (status < 0) throw new InvalidOperationException("device status query failed; SDK error " + LastError);
                var serial = Convert.ToString(Invoke("GetSerialNumber", machineNumber, Type.Missing, BindingFlags.OptionalParamBinding), CultureInfo.InvariantCulture) ?? "";
                var firmware = Convert.ToString(Invoke("GetFirmwareVersion", machineNumber, Type.Missing, BindingFlags.OptionalParamBinding), CultureInfo.InvariantCulture) ?? "";
                var algorithm = Convert.ToString(Invoke("GetProductVersion", machineNumber, Type.Missing, BindingFlags.OptionalParamBinding), CultureInfo.InvariantCulture) ?? "";

                var values = Invoke("GetDeviceInfo", machineNumber, null, null, null, Type.Missing, Type.Missing, Type.Missing, BindingFlags.OptionalParamBinding) as object[];
                if (values == null || values.Length < 4) throw new InvalidOperationException("device information query returned no values");
                if (!Convert.ToBoolean(values[0], CultureInfo.InvariantCulture))
                    throw new InvalidOperationException("device information query failed; SDK error " + LastError);
                if (String.IsNullOrWhiteSpace(serial) || String.IsNullOrWhiteSpace(firmware))
                    throw new InvalidOperationException("device returned an empty identity; SDK error " + LastError);
                return new DeviceInfo(serial, firmware, algorithm,
                    Convert.ToInt32(values[1], CultureInfo.InvariantCulture),
                    Convert.ToInt32(values[2], CultureInfo.InvariantCulture),
                    Convert.ToInt32(values[3], CultureInfo.InvariantCulture));
            }
        }

        public bool EnsureUser(string deviceUserId, string name, int privilege = 0)
        {
            ValidateUser(deviceUserId, name, privilege);
            lock (sync)
            {
                RequireConnected();
                return Convert.ToBoolean(Invoke("SSR_SetUserInfo", machineNumber, deviceUserId, privilege, name, "", "", true, 0), CultureInfo.InvariantCulture);
            }
        }

        public bool StartEnrollment(string deviceUserId, int fingerIndex = 0)
        {
            ValidateFinger(deviceUserId, fingerIndex);
            lock (sync)
            {
                RequireConnected();
                return Convert.ToBoolean(Invoke("StartEnrollEx", deviceUserId, fingerIndex, 1), CultureInfo.InvariantCulture);
            }
        }

        public EnrollmentResult PollEnrollment(string deviceUserId)
        {
            ValidateFinger(deviceUserId, 0);
            lock (sync)
            {
                RequireConnected();
                var values = Invoke("SSR_GetUserTmpStr", machineNumber, deviceUserId, 0, null, 0, Type.Missing, BindingFlags.OptionalParamBinding) as object[];
                if (values == null || values.Length < 2) throw new InvalidOperationException("template query returned no values");
                var flag = Convert.ToInt32(values[0], CultureInfo.InvariantCulture);
                var length = Convert.ToInt32(values[1], CultureInfo.InvariantCulture);
                var template = values.Length > 2 ? values[2] as string : null;
                if (flag < 0) return new EnrollmentResult(deviceUserId, "failed", 0, "template query failed; SDK error " + LastError);
                if (length > 0)
                {
                    template = null;
                    return new EnrollmentResult(deviceUserId, "enrolled", length, "");
                }
                if (flag == 0) return new EnrollmentResult(deviceUserId, "failed", 0, "template query failed; SDK error " + LastError);
                template = null;
                return new EnrollmentResult(deviceUserId, "awaiting_scan", 0, "");
            }
        }

        public void CancelEnrollment()
        {
            lock (sync)
            {
                if (disposed) return;
                Invoke("CancelOperation", Type.Missing, BindingFlags.OptionalParamBinding);
            }
        }

        public IReadOnlyList<AttendanceEvent> ReadNewAttendance()
        {
            lock (sync)
            {
                RequireConnected();
                if (!Convert.ToBoolean(Invoke("ReadNewGLogData", machineNumber), CultureInfo.InvariantCulture))
                    return new AttendanceEvent[0];

                var result = new List<AttendanceEvent>();
                while (true)
                {
                var values = Invoke("SSR_GetGeneralLogData", machineNumber, null, null, null, null, null, null, null, null, null, null) as object[];
                if (values == null || values.Length < 10 || !Convert.ToBoolean(values[0], CultureInfo.InvariantCulture)) break;
                result.Add(new AttendanceEvent(Convert.ToString(values[1], CultureInfo.InvariantCulture) ?? "",
                    Convert.ToInt32(values[2], CultureInfo.InvariantCulture),
                    Convert.ToInt32(values[3], CultureInfo.InvariantCulture),
                    Convert.ToInt32(values[4], CultureInfo.InvariantCulture), Convert.ToInt32(values[5], CultureInfo.InvariantCulture),
                    Convert.ToInt32(values[6], CultureInfo.InvariantCulture), Convert.ToInt32(values[7], CultureInfo.InvariantCulture),
                    Convert.ToInt32(values[8], CultureInfo.InvariantCulture), Convert.ToInt32(values[9], CultureInfo.InvariantCulture),
                    Convert.ToInt32(values[10], CultureInfo.InvariantCulture)));
                values = null;
                    if (result.Count >= 10000) throw new InvalidOperationException("device returned an excessive attendance batch");
                }
                return result;
            }
        }

        public void DisableUser(string deviceUserId)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            lock (sync)
            {
                RequireConnected();
                if (!Convert.ToBoolean(Invoke("SSR_EnableUser", machineNumber, deviceUserId, false, Type.Missing, BindingFlags.OptionalParamBinding), CultureInfo.InvariantCulture))
                    throw new InvalidOperationException("disable user failed; SDK error " + LastError);
            }
        }

        public void DeleteUser(string deviceUserId)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            lock (sync)
            {
                RequireConnected();
                if (!Convert.ToBoolean(Invoke("SSR_DeleteUser", machineNumber, deviceUserId, Type.Missing, BindingFlags.OptionalParamBinding), CultureInfo.InvariantCulture))
                    throw new InvalidOperationException("delete user failed; SDK error " + LastError);
            }
        }

        public void Disconnect()
        {
            lock (sync)
            {
                if (disposed) return;
                try
                {
                    if (connected) Invoke("Disconnect", Type.Missing, BindingFlags.OptionalParamBinding);
                }
                finally
                {
                    connected = false;
                }
            }
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (disposed) return;
                try { Disconnect(); }
                finally
                {
                    disposed = true;
                    if (Marshal.IsComObject(sdk)) Marshal.ReleaseComObject(sdk);
                }
            }
        }

        private object Invoke(string name, params object[] args)
        {
            try
            {
                return sdk.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, sdk, args);
            }
            catch (TargetInvocationException ex)
            {
                throw new InvalidOperationException("ZKEM " + name + " failed: " + SafeMessage(ex.InnerException), ex.InnerException);
            }
        }

        private void RequireConnected()
        {
            ThrowIfDisposed();
            if (!connected) throw new InvalidOperationException("device is not connected");
        }

        private void ThrowIfDisposed()
        {
            if (disposed) throw new ObjectDisposedException("ZkTecoComDevice");
        }

        private static void ValidateUser(string deviceUserId, string name, int privilege)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            if (String.IsNullOrWhiteSpace(name)) throw new ArgumentException("name is required", "name");
            if (privilege < 0 || privilege > 2) throw new ArgumentOutOfRangeException("privilege");
        }

        private static void ValidateFinger(string deviceUserId, int fingerIndex)
        {
            if (String.IsNullOrWhiteSpace(deviceUserId)) throw new ArgumentException("device user ID is required", "deviceUserId");
            if (fingerIndex < 0 || fingerIndex > 9) throw new ArgumentOutOfRangeException("fingerIndex");
        }

        private static string SafeMessage(Exception error)
        {
            return error == null || String.IsNullOrWhiteSpace(error.Message) ? "COM invocation failed" : error.Message;
        }
    }
}
