using System;
using System.Collections.Generic;

namespace SushiRolls.ZkTeco
{
    [Serializable]
    public sealed class DeviceInfo
    {
        public DeviceInfo(string serial, string firmware, string algorithm, int users, int fingerprints, int records)
        {
            if (serial == null) throw new ArgumentNullException("serial");
            if (firmware == null) throw new ArgumentNullException("firmware");
            if (algorithm == null) throw new ArgumentNullException("algorithm");
            Serial = serial;
            Firmware = firmware;
            Algorithm = algorithm;
            Users = users;
            Fingerprints = fingerprints;
            Records = records;
        }

        public string Serial { get; private set; }
        public string Firmware { get; private set; }
        public string Algorithm { get; private set; }
        public int Users { get; private set; }
        public int Fingerprints { get; private set; }
        public int Records { get; private set; }
    }

    [Serializable]
    public sealed class EnrollmentResult
    {
        public EnrollmentResult(string deviceUserId, string status, int templateLength, string error)
        {
            DeviceUserId = deviceUserId ?? "";
            Status = status ?? "";
            TemplateLength = templateLength;
            Error = error ?? "";
        }

        public string DeviceUserId { get; private set; }
        public string Status { get; private set; }
        public int TemplateLength { get; private set; }
        public string Error { get; private set; }
    }

    [Serializable]
    public sealed class AttendanceEvent
    {
        public AttendanceEvent(string deviceUserId, int verifyMode, int rawState,
            int year, int month, int day, int hour, int minute, int second, int workCode)
        {
            DeviceUserId = deviceUserId ?? "";
            VerifyMode = verifyMode;
            RawState = rawState;
            Year = year;
            Month = month;
            Day = day;
            Hour = hour;
            Minute = minute;
            Second = second;
            WorkCode = workCode;
            Validate();
        }

        public string DeviceUserId { get; private set; }
        public int VerifyMode { get; private set; }
        public int RawState { get; private set; }
        public int Year { get; private set; }
        public int Month { get; private set; }
        public int Day { get; private set; }
        public int Hour { get; private set; }
        public int Minute { get; private set; }
        public int Second { get; private set; }
        public int WorkCode { get; private set; }

        public void Validate()
        {
            if (DeviceUserId.Length == 0) throw new ArgumentException("device user ID is required", "deviceUserId");
            if (Year < 1900 || Year > 9999 || Month < 1 || Month > 12 || Day < 1 || Day > 31 ||
                Hour < 0 || Hour > 23 || Minute < 0 || Minute > 59 || Second < 0 || Second > 59)
            {
                throw new ArgumentException("attendance timestamp is outside its valid range", "attendance");
            }

            var date = new DateTime(Year, Month, Day, Hour, Minute, Second, DateTimeKind.Unspecified);
            if (date.Year != Year || date.Month != Month || date.Day != Day)
            {
                throw new ArgumentException("attendance timestamp is not a valid calendar date", "attendance");
            }
        }
    }

    internal static class Json
    {
        public static string Escape(string value)
        {
            if (value == null) return "";
            var result = new System.Text.StringBuilder(value.Length + 16);
            result.Append('"');
            foreach (var c in value)
            {
                switch (c)
                {
                    case '"': result.Append("\\\""); break;
                    case '\\': result.Append("\\\\"); break;
                    case '\b': result.Append("\\b"); break;
                    case '\f': result.Append("\\f"); break;
                    case '\n': result.Append("\\n"); break;
                    case '\r': result.Append("\\r"); break;
                    case '\t': result.Append("\\t"); break;
                    default:
                        if (c < ' ' || Char.IsSurrogate(c))
                        {
                            result.Append("\\u");
                            result.Append(((int)c).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                        }
                        else result.Append(c);
                        break;
                }
            }
            result.Append('"');
            return result.ToString();
        }

        public static string Object(IEnumerable<KeyValuePair<string, string>> fields)
        {
            var result = new System.Text.StringBuilder("{");
            var first = true;
            foreach (var field in fields)
            {
                if (!first) result.Append(',');
                first = false;
                result.Append(Escape(field.Key));
                result.Append(':');
                result.Append(field.Value);
            }
            result.Append('}');
            return result.ToString();
        }

        public static string Number(int value)
        {
            return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        public static string Bool(bool value)
        {
            return value ? "true" : "false";
        }
    }
}
