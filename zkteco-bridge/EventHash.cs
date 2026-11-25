using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace SushiRolls.ZkTeco
{
    public static class EventHash
    {
        public static string For(AttendanceEvent value, string deviceSerial)
        {
            if (value == null) throw new ArgumentNullException("value");
            if (String.IsNullOrWhiteSpace(deviceSerial)) throw new ArgumentException("device serial is required", "deviceSerial");
            value.Validate();

            var canonical = String.Join("|", new[]
            {
                "sushi-rolls-attendance-v1",
                LengthPrefixed(deviceSerial),
                LengthPrefixed(value.DeviceUserId),
                value.Year.ToString("D4", CultureInfo.InvariantCulture) + "-" +
                    value.Month.ToString("D2", CultureInfo.InvariantCulture) + "-" +
                    value.Day.ToString("D2", CultureInfo.InvariantCulture) + "T" +
                    value.Hour.ToString("D2", CultureInfo.InvariantCulture) + ":" +
                    value.Minute.ToString("D2", CultureInfo.InvariantCulture) + ":" +
                    value.Second.ToString("D2", CultureInfo.InvariantCulture),
                value.VerifyMode.ToString(CultureInfo.InvariantCulture),
                value.RawState.ToString(CultureInfo.InvariantCulture),
                value.WorkCode.ToString(CultureInfo.InvariantCulture)
            });

            using (var sha256 = SHA256.Create())
            {
                var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(canonical));
                var result = new StringBuilder(bytes.Length * 2);
                foreach (var b in bytes) result.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return result.ToString();
            }
        }

        private static string LengthPrefixed(string value)
        {
            return value.Length.ToString(CultureInfo.InvariantCulture) + ":" + value;
        }
    }
}
