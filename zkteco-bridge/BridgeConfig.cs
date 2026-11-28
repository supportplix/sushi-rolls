using System;
using System.Collections.Generic;
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

        // The database validates against pg_timezone_names (600+ IANA ids) while
        // .NET Framework only knows Windows time zone ids. Anything outside the
        // explicit map falls back to a known-good zone instead of throwing: a
        // bad free-text value must never stop the whole attendance sync loop.
        public const string DefaultTimezone = "Africa/Cairo";
        private const string DefaultWindowsTimezone = "Egypt Standard Time";

        public static readonly string[] SupportedTimezones =
        {
            "Africa/Cairo",
            "America/New_York",
            "America/Chicago",
            "America/Los_Angeles",
            "Europe/London",
            "Europe/Paris",
            "Asia/Riyadh",
            "Asia/Dubai",
            "Asia/Kolkata",
            "UTC"
        };

        private static readonly Dictionary<string, string> IanaToWindows = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "Africa/Cairo", "Egypt Standard Time" },
            { "America/New_York", "Eastern Standard Time" },
            { "America/Chicago", "Central Standard Time" },
            { "America/Los_Angeles", "Pacific Standard Time" },
            { "Europe/London", "GMT Standard Time" },
            { "Europe/Paris", "W. Europe Standard Time" },
            { "Asia/Riyadh", "Arab Standard Time" },
            { "Asia/Dubai", "Arabian Standard Time" },
            { "Asia/Kolkata", "India Standard Time" },
            { "UTC", "UTC" }
        };

        private static readonly Dictionary<string, string> WindowsToIana = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "Egypt Standard Time", "Africa/Cairo" },
            { "Eastern Standard Time", "America/New_York" },
            { "Central Standard Time", "America/Chicago" },
            { "Pacific Standard Time", "America/Los_Angeles" },
            { "GMT Standard Time", "Europe/London" },
            { "W. Europe Standard Time", "Europe/Paris" },
            { "Arab Standard Time", "Asia/Riyadh" },
            { "Arabian Standard Time", "Asia/Dubai" },
            { "India Standard Time", "Asia/Kolkata" },
            { "UTC", "UTC" }
        };

        private static readonly object DiagnosticSync = new object();
        private static readonly HashSet<string> WarnedTimezones = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static string lastTimezoneDiagnostic;

        public string SupabaseUrl { get; private set; }
        public string DeviceToken { get; private set; }
        public string Timezone { get; private set; }
        public string InteractiveUserSid { get; private set; }

        /// <summary>Last unsupported-timezone warning, for surfacing in diagnostics.</summary>
        public static string LastTimezoneDiagnostic
        {
            get { lock (DiagnosticSync) return lastTimezoneDiagnostic; }
        }

        public bool IsConfigured
        {
            get { return !String.IsNullOrWhiteSpace(SupabaseUrl) && !String.IsNullOrWhiteSpace(DeviceToken); }
        }

        public void SetTimezone(string timezone)
        {
            if (String.IsNullOrWhiteSpace(timezone)) return;
            Timezone = NormalizeTimezone(timezone);
        }

        /// <summary>
        /// Resolves an IANA id (or an already-Windows id) to a Windows time zone
        /// that exists on this machine. Never throws; reports and falls back for
        /// unsupported ids so SupabaseSync never halts the sync loop.
        /// </summary>
        public static string ResolveWindowsTimeZone(string timezone)
        {
            string windowsId;
            string ianaId;
            if (TryResolveWindowsTimeZone(timezone, out windowsId, out ianaId))
            {
                try
                {
                    TimeZoneInfo.FindSystemTimeZoneById(windowsId);
                    return windowsId;
                }
                catch (Exception) { }
            }
            ReportUnsupported(timezone);
            return DefaultWindowsTimezone;
        }

        /// <summary>Effective IANA id matching the offset actually used for events.</summary>
        public static string NormalizeTimezone(string timezone)
        {
            string windowsId;
            string ianaId;
            if (TryResolveWindowsTimeZone(timezone, out windowsId, out ianaId)) return ianaId;
            ReportUnsupported(timezone);
            return DefaultTimezone;
        }

        private static bool TryResolveWindowsTimeZone(string timezone, out string windowsId, out string ianaId)
        {
            windowsId = DefaultWindowsTimezone;
            ianaId = DefaultTimezone;
            if (String.IsNullOrWhiteSpace(timezone)) return false;
            var candidate = timezone.Trim();
            string mapped;
            if (IanaToWindows.TryGetValue(candidate, out mapped))
            {
                windowsId = mapped;
                ianaId = candidate;
                return true;
            }
            if (WindowsToIana.TryGetValue(candidate, out mapped))
            {
                windowsId = candidate;
                ianaId = mapped;
                return true;
            }
            return false;
        }

        private static void ReportUnsupported(string requested)
        {
            if (String.IsNullOrWhiteSpace(requested)) return;
            var message = "Unsupported timezone '" + requested.Trim() + "'; attendance sync is using " +
                DefaultTimezone + " (" + DefaultWindowsTimezone + "). Supported ids: " +
                String.Join(", ", SupportedTimezones);
            lock (DiagnosticSync)
            {
                if (!WarnedTimezones.Add(requested.Trim())) return;
                lastTimezoneDiagnostic = message;
            }
            try { Console.Error.WriteLine("[zkteco] " + message); }
            catch (Exception) { }
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
                    Timezone = NormalizeTimezone(data.Timezone),
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
            var effectiveTimezone = NormalizeTimezone(timezone);

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
            // When Save is called by the SYSTEM service, keep the desktop user SID
            // already stored so the named pipe stays reachable by the Electron app.
            var previous = Load();
            var interactiveSid = previous.InteractiveUserSid;
            if (String.IsNullOrWhiteSpace(interactiveSid)) interactiveSid = WindowsIdentity.GetCurrent().User.Value;
            var data = new StoredConfig
            {
                SupabaseUrl = supabaseUrl.Trim().TrimEnd('/'),
                ProtectedToken = Convert.ToBase64String(protectedBytes),
                Timezone = effectiveTimezone,
                InteractiveUserSid = interactiveSid
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
                HardenAcl(interactiveSid);
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }
        }

        private static void HardenAcl(string interactiveSid)
        {
            var security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,
                FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            if (!String.IsNullOrWhiteSpace(interactiveSid))
            {
                try
                {
                    security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(interactiveSid),
                        FileSystemRights.FullControl, AccessControlType.Allow));
                }
                catch (ArgumentException) { }
            }
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
