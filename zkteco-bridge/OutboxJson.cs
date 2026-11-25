using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace SushiRolls.ZkTeco
{
    internal static class OutboxJson
    {
        public static string WriteArray(IReadOnlyList<OutboxEntry> entries)
        {
            var result = new StringBuilder("[");
            for (var i = 0; i < entries.Count; i++)
            {
                if (i != 0) result.Append(',');
                result.Append(entries[i].ToJson());
            }
            result.Append(']');
            return result.ToString();
        }

        public static IReadOnlyList<OutboxEntry> ReadArray(string json)
        {
            if (String.IsNullOrWhiteSpace(json)) return new OutboxEntry[0];
            var index = 0;
            SkipWhitespace(json, ref index);
            Require(json, ref index, '[');
            SkipWhitespace(json, ref index);
            var entries = new List<OutboxEntry>();
            if (Peek(json, index) == ']')
            {
                index++;
                SkipWhitespace(json, ref index);
                RequireEnd(json, ref index);
                return entries;
            }

            while (true)
            {
                entries.Add(ReadEntry(json, ref index));
                SkipWhitespace(json, ref index);
                var separator = Peek(json, index);
                if (separator == ']')
                {
                    index++;
                    break;
                }
                Require(json, ref index, ',');
            }

            SkipWhitespace(json, ref index);
            RequireEnd(json, ref index);
            var ids = new HashSet<string>(StringComparer.Ordinal);
            var hashes = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entry in entries)
            {
                Guid parsedGuid;
                if (!Guid.TryParseExact(entry.EventId, "N", out parsedGuid) || parsedGuid == Guid.Empty ||
                    entry.PayloadHash == null || entry.PayloadHash.Length != 64 || !IsLowerHex(entry.PayloadHash) ||
                    entry.Payload == null || entry.CreatedAt == default(DateTime) ||
                    entry.CreatedAt.Kind != DateTimeKind.Utc || !ids.Add(entry.EventId) || !hashes.Add(entry.PayloadHash))
                {
                    throw new InvalidDataException("outbox contains an invalid or duplicate entry");
                }
                entry.Payload.Validate();
            }
            return entries;
        }

        private static OutboxEntry ReadEntry(string json, ref int index)
        {
            Require(json, ref index, '{');
            string eventId = null;
            string hash = null;
            AttendanceEvent payload = null;
            DateTime createdAt = default(DateTime);
            var synced = false;
            var seen = new HashSet<string>(StringComparer.Ordinal);

            SkipWhitespace(json, ref index);
            if (Peek(json, index) == '}')
            {
                index++;
                throw new InvalidDataException("outbox entry is incomplete");
            }

            while (true)
            {
                var key = ReadString(json, ref index);
                if (!seen.Add(key)) throw new InvalidDataException("outbox entry contains a duplicate field");
                SkipWhitespace(json, ref index);
                Require(json, ref index, ':');
                SkipWhitespace(json, ref index);
                switch (key)
                {
                    case "event_id": eventId = ReadString(json, ref index); break;
                    case "payload_hash": hash = ReadString(json, ref index); break;
                    case "payload": payload = ReadPayload(json, ref index); break;
                    case "created_at": createdAt = ReadCreatedAt(json, ref index); break;
                    case "synced": synced = ReadBoolean(json, ref index); break;
                    default: throw new InvalidDataException("outbox entry contains an unknown field");
                }
                SkipWhitespace(json, ref index);
                var separator = Peek(json, index);
                if (separator == '}')
                {
                    index++;
                    break;
                }
                Require(json, ref index, ',');
            }

            return new OutboxEntry { EventId = eventId, PayloadHash = hash, Payload = payload, CreatedAt = createdAt, Synced = synced };
        }

        private static AttendanceEvent ReadPayload(string json, ref int index)
        {
            Require(json, ref index, '{');
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            SkipWhitespace(json, ref index);
            if (Peek(json, index) != '}')
            {
                while (true)
                {
                    var key = ReadString(json, ref index);
                    if (values.ContainsKey(key)) throw new InvalidDataException("outbox payload contains a duplicate field");
                    SkipWhitespace(json, ref index);
                    Require(json, ref index, ':');
                    SkipWhitespace(json, ref index);
                    if (key == "device_user_id") values[key] = ReadString(json, ref index);
                    else
                    {
                        var token = ReadIntegerToken(json, ref index);
                        int integer;
                        if (!Int32.TryParse(token, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out integer))
                            throw new InvalidDataException("outbox payload integer is outside the supported range");
                        values[key] = token;
                    }
                    SkipWhitespace(json, ref index);
                    var separator = Peek(json, index);
                    if (separator == '}')
                    {
                        index++;
                        break;
                    }
                    Require(json, ref index, ',');
                }
            }
            else index++;

            string[] required = { "device_user_id", "verify_mode", "raw_state", "year", "month", "day", "hour", "minute", "second", "work_code" };
            foreach (var key in required)
            {
                if (!values.ContainsKey(key)) throw new InvalidDataException("outbox payload is incomplete");
            }
            if (values.Count != required.Length) throw new InvalidDataException("outbox payload contains an unknown field");
            return new AttendanceEvent(values["device_user_id"], ReadInt(values, "verify_mode"), ReadInt(values, "raw_state"),
                ReadInt(values, "year"), ReadInt(values, "month"), ReadInt(values, "day"), ReadInt(values, "hour"),
                ReadInt(values, "minute"), ReadInt(values, "second"), ReadInt(values, "work_code"));
        }

        private static DateTime ReadCreatedAt(string json, ref int index)
        {
            var text = ReadString(json, ref index);
            DateTime value;
            if (!DateTime.TryParseExact(text, "o", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out value) || value.Kind != DateTimeKind.Utc)
                throw new InvalidDataException("outbox created_at is not a UTC round-trip timestamp");
            return value;
        }

        private static int ReadInt(IReadOnlyDictionary<string, string> values, string key)
        {
            int value;
            if (!Int32.TryParse(values[key], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value))
                throw new InvalidDataException("outbox payload contains a non-integer value");
            return value;
        }

        private static bool ReadBoolean(string json, ref int index)
        {
            if (ReadLiteral(json, ref index, "true")) return true;
            if (ReadLiteral(json, ref index, "false")) return false;
            throw new InvalidDataException("outbox synced field is not boolean");
        }

        private static bool ReadLiteral(string json, ref int index, string literal)
        {
            if (index + literal.Length > json.Length || String.CompareOrdinal(json, index, literal, 0, literal.Length) != 0) return false;
            index += literal.Length;
            return true;
        }

        private static string ReadIntegerToken(string json, ref int index)
        {
            var start = index;
            if (Peek(json, index) == '-') index++;
            if (Peek(json, index) == '0') index++;
            else
            {
                if (Peek(json, index) < '1' || Peek(json, index) > '9') throw new InvalidDataException("invalid integer in outbox");
                while (!AtEnd(json, index) && Peek(json, index) >= '0' && Peek(json, index) <= '9')
            {
                index++;
            }
            }
            if (index == start) throw new InvalidDataException("invalid integer in outbox");
            return json.Substring(start, index - start);
        }

        private static string ReadString(string json, ref int index)
        {
            Require(json, ref index, '"');
            var result = new StringBuilder();
            while (true)
            {
                var c = Peek(json, index++);
                if (c == '"') return result.ToString();
                if (c < ' ') throw new InvalidDataException("unescaped control character in outbox string");
                if (c != '\\')
                {
                    if (Char.IsSurrogate(c)) throw new InvalidDataException("unpaired surrogate in outbox string");
                    result.Append(c);
                    continue;
                }

                var escape = Peek(json, index++);
                switch (escape)
                {
                    case '"': result.Append('"'); break;
                    case '\\': result.Append('\\'); break;
                    case '/': result.Append('/'); break;
                    case 'b': result.Append('\b'); break;
                    case 'f': result.Append('\f'); break;
                    case 'n': result.Append('\n'); break;
                    case 'r': result.Append('\r'); break;
                    case 't': result.Append('\t'); break;
                    case 'u':
                        result.Append(ReadUnicodeEscape(json, ref index));
                        break;
                    default: throw new InvalidDataException("invalid escape in outbox string");
                }
            }
        }

        private static char ReadUnicodeEscape(string json, ref int index)
        {
            var value = 0;
            for (var i = 0; i < 4; i++)
            {
                var c = Peek(json, index++);
                var digit = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
                if (digit < 0) throw new InvalidDataException("invalid unicode escape in outbox string");
                value = value * 16 + digit;
            }
            return (char)value;
        }

        private static bool IsLowerHex(string text)
        {
            foreach (var c in text)
            {
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            }
            return true;
        }

        private static void Require(string json, ref int index, char expected)
        {
            SkipWhitespace(json, ref index);
            if (Peek(json, index) != expected) throw new InvalidDataException("outbox JSON does not match its schema");
            index++;
        }

        private static void RequireEnd(string json, ref int index)
        {
            if (index != json.Length) throw new InvalidDataException("trailing data after outbox JSON");
        }

        private static void SkipWhitespace(string json, ref int index)
        {
            while (Peek(json, index) == ' ' || Peek(json, index) == '\r' || Peek(json, index) == '\n' || Peek(json, index) == '\t') index++;
        }

        private static bool AtEnd(string json, int index)
        {
            return index < 0 || index >= json.Length;
        }

        private static char Peek(string json, int index)
        {
            return AtEnd(json, index) ? '\0' : json[index];
        }
    }
}
