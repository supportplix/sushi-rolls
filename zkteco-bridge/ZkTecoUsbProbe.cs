using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace SushiRolls.ZkTeco
{
    internal static class ZkTecoUsbProbe
    {
        private const ushort Vid = 0x1B55;
        private const int Pid = 0x0A01;
        private const int MachineNumber = 1;

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

        public static DeviceInfo Probe()
        {
            var handle = Z_Connect_USB_STD(Vid, 0, Pid, MachineNumber);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Z_Connect_USB_STD could not open the LX15");
            try
            {
                var serial = new StringBuilder(256);
                var firmware = new StringBuilder(256);
                var serialResult = Z_GetSerialNumber(handle, serial);
                var firmwareResult = Z_GetFirmwareVersion(handle, firmware);
                int users, fingerprints, records;
                var statusResult = Z_GetDeviceStatus(handle, 2, out users);
                var fingerprintResult = Z_GetDeviceStatus(handle, 3, out fingerprints);
                var recordResult = Z_GetDeviceStatus(handle, 6, out records);
                if (serialResult <= 0 || firmwareResult <= 0 || statusResult <= 0 || fingerprintResult <= 0 || recordResult <= 0)
                    throw new InvalidOperationException("LX15 identity query failed");
                if (serial.Length == 0) throw new InvalidOperationException("LX15 returned an empty serial number");
                return new DeviceInfo(serial.ToString(), firmware.ToString(), "ZKFinger", users, fingerprints, records);
            }
            finally
            {
                Z_Close(handle);
            }
        }
    }
}
