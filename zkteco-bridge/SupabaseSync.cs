using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace SushiRolls.ZkTeco
{
    internal sealed class SupabaseSync : IDisposable
    {
        private readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };

        static SupabaseSync()
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        }

        public async Task PushPendingAsync(Outbox outbox, BridgeConfig config, CancellationToken cancellationToken)
        {
            var zone = TimeZoneInfo.FindSystemTimeZoneById(BridgeConfig.ResolveWindowsTimeZone(config.Timezone));
            while (true)
            {
                var pending = outbox.ReadPending();
                if (pending.Count == 0)
                {
                    outbox.Compact();
                    return;
                }
                var batch = new List<Dictionary<string, object>>();
                var count = Math.Min(200, pending.Count);
                for (var index = 0; index < count; index++)
                {
                    var entry = pending[index];
                    var p = entry.Payload;
                    var local = new DateTime(p.Year, p.Month, p.Day, p.Hour, p.Minute, p.Second, DateTimeKind.Unspecified);
                    var offset = zone.GetUtcOffset(local);
                    var instant = new DateTimeOffset(local, offset);
                    batch.Add(new Dictionary<string, object>
                    {
                        { "event_id", new Guid(entry.EventId).ToString() },
                        { "device_user_id", p.DeviceUserId },
                        { "occurred_at", instant.ToString("o", CultureInfo.InvariantCulture) },
                        { "device_timestamp", local.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) },
                        { "timezone", config.Timezone },
                        { "verify_mode", p.VerifyMode },
                        { "raw_state", p.RawState },
                        { "work_code", p.WorkCode },
                        { "payload_hash", entry.PayloadHash }
                    });
                }
                Dictionary<string, object> response;
                try
                {
                    response = await PostAsync(config, "push_events", new Dictionary<string, object>
                    {
                        { "action", "push_events" },
                        { "events", batch }
                    }, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception pushError)
                {
                    // 409 means the events were already committed by a previous attempt.
                    // Treat it as delivered so the local outbox can be drained.
                    if (!pushError.Message.Contains("409")) throw;
                    for (var index = 0; index < count; index++) outbox.MarkSynced(pending[index].EventId);
                    outbox.Compact();
                    return;
                }
                if (!response.ContainsKey("ok") || !Convert.ToBoolean(response["ok"], CultureInfo.InvariantCulture))
                    throw new InvalidOperationException("device-sync rejected attendance events");
                for (var index = 0; index < count; index++) outbox.MarkSynced(pending[index].EventId);
                outbox.Compact();
            }
        }

        public async Task<IReadOnlyList<DeviceCommand>> PullCommandsAsync(BridgeConfig config, CancellationToken cancellationToken)
        {
            var response = await PostAsync(config, "pull_commands", new Dictionary<string, object>
            {
                { "action", "pull_commands" },
                { "limit", 50 }
            }, cancellationToken).ConfigureAwait(false);
            // JavaScriptSerializer materialises JSON arrays as ArrayList, not object[].
            var raw = response.ContainsKey("commands") ? response["commands"] as System.Collections.IEnumerable : null;
            var result = new List<DeviceCommand>();
            if (raw == null) return result;
            foreach (var item in raw)
            {
                var row = item as Dictionary<string, object>;
                if (row == null) continue;
                var payload = row.ContainsKey("payload") ? row["payload"] as Dictionary<string, object> : null;
                if (payload == null) continue;
                result.Add(new DeviceCommand(
                    Convert.ToString(row["id"], CultureInfo.InvariantCulture) ?? "",
                    Convert.ToString(row["type"], CultureInfo.InvariantCulture) ?? "",
                    Convert.ToString(payload["device_user_id"], CultureInfo.InvariantCulture) ?? "",
                    Convert.ToString(payload["name"], CultureInfo.InvariantCulture) ?? "",
                    payload.ContainsKey("privilege") ? Convert.ToInt32(payload["privilege"], CultureInfo.InvariantCulture) : 0,
                    Convert.ToString(row["idempotency_key"], CultureInfo.InvariantCulture) ?? ""));
            }
            return result;
        }

        public async Task CompleteAsync(BridgeConfig config, DeviceCommand command, CancellationToken cancellationToken)
        {
            await PostAsync(config, "complete_command", new Dictionary<string, object>
            {
                { "action", "complete_command" },
                { "command_id", command.Id },
                { "idempotency_key", command.IdempotencyKey }
            }, cancellationToken).ConfigureAwait(false);
        }

        public async Task FailAsync(BridgeConfig config, DeviceCommand command, string error, CancellationToken cancellationToken)
        {
            await PostAsync(config, "fail_command", new Dictionary<string, object>
            {
                { "action", "fail_command" },
                { "command_id", command.Id },
                { "idempotency_key", command.IdempotencyKey },
                { "error", String.IsNullOrWhiteSpace(error) ? "device command failed" : error.Substring(0, Math.Min(error.Length, 2000)) }
            }, cancellationToken).ConfigureAwait(false);
        }

        public async Task HeartbeatAsync(BridgeConfig config, CancellationToken cancellationToken)
        {
            var response = await PostAsync(config, "heartbeat", new Dictionary<string, object>
            {
                { "action", "heartbeat" },
                { "bridge_version", "1.0.0" }
            }, cancellationToken).ConfigureAwait(false);
            if (response.ContainsKey("timezone")) config.SetTimezone(Convert.ToString(response["timezone"], CultureInfo.InvariantCulture));
        }

        public void Dispose()
        {
            http.Dispose();
        }

        private async Task<Dictionary<string, object>> PostAsync(BridgeConfig config, string action, object payload, CancellationToken cancellationToken)
        {
            if (!config.IsConfigured) throw new InvalidOperationException("bridge is not configured");
            var url = config.SupabaseUrl + "/functions/v1/device-sync";
            var body = json.Serialize(payload);
            using (var request = new HttpRequestMessage(HttpMethod.Post, url))
            {
                request.Headers.TryAddWithoutValidation("X-Device-Token", config.DeviceToken);
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                using (var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false))
                {
                    var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    if (!response.IsSuccessStatusCode)
                        throw new InvalidOperationException("device-sync " + action + " failed with HTTP " + (int)response.StatusCode);
                    var parsed = json.Deserialize<Dictionary<string, object>>(text);
                    return parsed ?? new Dictionary<string, object>();
                }
            }
        }
    }
}
