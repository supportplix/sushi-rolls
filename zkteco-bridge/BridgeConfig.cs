using System;
using System.IO;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

namespace SushiRolls.ZkTeco
{
    internal sealed class BridgeConfig
    {
        private static readonly string DirectoryPath = @"C:\ProgramData\SUSHI ROLLS\zkteco";
        private static readonly string FilePath = Path.Combine(DirectoryPath, "bridge.json");
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("SUSHI ROLLS ZKTeco LX15 v1");

        public string SupabaseUrl { get; private set; }
        public string DeviceToken { get; private set; }
        public string Timezone { get; private set; }
        public string InteractiveUserSid { get; private set; }

        public bool IsConfigured
        {
            get { return !String.IsNullOrWhiteSpace(SupabaseUrl) && !String.IsNullOrWhiteSpace(DeviceToken); }
        }

        public void SetTimezone(string timezone)
        {
            if (String.IsNullOrWhiteSpace(timezone)) return;
            ResolveWindowsTimeZone(timezone);
            Timezone = timezone;
        }

        public static string ResolveWindowsTimeZone(string timezone)
        {
            if (String.IsNullOrWhiteSpace(timezone)) return "Egypt Standard Time";
            var windowsId = timezone;
            if (timezone == "Africa/Cairo") windowsId = "Egypt Standard Time";
            else if (timezone == "America/New_York") windowsId = "Eastern Standard Time";
            else if (timezone == "America/Chicago") windowsId = "Central Standard Time";
            else if (timezone == "America/Los_Angeles") windowsId = "Pacific Standard Time";
            else if (timezone == "Europe/London") windowsId = "GMT Standard Time";
            else if (timezone == "Europe/Paris") windowsId = "W. Europe Standard Time";
            else if (timezone == "Asia/Riyadh") windowsId = "Arab Standard Time";
            else if (timezone == "Asia/Dubai") windowsId = "Arabian Standard Time";
            else if (timezone == "Asia/Kolkata") windowsId = "India Standard Time";
            else if (timezone == "UTC") windowsId = "UTC";
            TimeZoneInfo.FindSystemTimeZoneById(windowsId);
            return windowsId;
        }

        public static BridgeConfig Load()
        {
            try
            {
                if (!File.Exists(FilePath)) return new BridgeConfig();
                var json = File.ReadAllText(FilePath, Encoding.UTF8);
                var data = new JavaScriptSerializer().Deserialize<StoredConfig>(json);
                if (data == null || String.IsNullOrWhiteSpace(data.ProtectedToken)) return new BridgeConfig();
                var protectedBytes = Convert.FromBase64String(data.ProtectedToken);
                var tokenBytes = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.LocalMachine);
                var token = Encoding.UTF8.GetString(tokenBytes);
                Array.Clear(tokenBytes, 0, tokenBytes.Length);
                return new BridgeConfig
                {
                    SupabaseUrl = (data.SupabaseUrl ?? "").Trim().TrimEnd('/'),
                    DeviceToken = token,
                    Timezone = String.IsNullOrWhiteSpace(data.Timezone) ? "Africa/Cairo" : data.Timezone,
                    InteractiveUserSid = data.InteractiveUserSid ?? ""
                };
            }
            catch
            {
                return new BridgeConfig();
            }
        }

        public static void Save(string supabaseUrl, string deviceToken, string timezone)
        {
            if (String.IsNullOrWhiteSpace(supabaseUrl) || !supabaseUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Supabase URL must use HTTPS", "supabaseUrl");
            if (String.IsNullOrWhiteSpace(deviceToken) || deviceToken.Length < 32 || deviceToken.Length > 512)
                throw new ArgumentException("Device token is invalid", "deviceToken");
            if (String.IsNullOrWhiteSpace(timezone)) timezone = "Africa/Cairo";
            ResolveWindowsTimeZone(timezone);

            Directory.CreateDirectory(DirectoryPath);
            var tokenBytes = Encoding.UTF8.GetBytes(deviceToken);
            byte[] protectedBytes;
            try
            {
                protectedBytes = ProtectedData.Protect(tokenBytes, Entropy, DataProtectionScope.LocalMachine);
            }
            finally
            {
                Array.Clear(tokenBytes, 0, tokenBytes.Length);
            }
            var data = new StoredConfig
            {
                SupabaseUrl = supabaseUrl.Trim().TrimEnd('/'),
                ProtectedToken = Convert.ToBase64String(protectedBytes),
                Timezone = timezone,
                InteractiveUserSid = WindowsIdentity.GetCurrent().User.Value
            };
            var json = new JavaScriptSerializer().Serialize(data);
            var temp = FilePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    var bytes = new UTF8Encoding(false).GetBytes(json);
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (File.Exists(FilePath)) File.Replace(temp, FilePath, null);
                else File.Move(temp, FilePath);
                HardenAcl();
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }
        }

        private static void HardenAcl()
        {
            var security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,
                FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            File.SetAccessControl(FilePath, security);
        }

        private sealed class StoredConfig
        {
            public string SupabaseUrl { get; set; }
            public string ProtectedToken { get; set; }
            public string Timezone { get; set; }
            public string InteractiveUserSid { get; set; }
        }
    }
}
