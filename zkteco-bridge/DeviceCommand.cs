using System;
using System.Threading;
using System.Threading.Tasks;

namespace SushiRolls.ZkTeco
{
    public sealed class DeviceCommand
    {
        public static readonly string[] AllowedTypes = { "create_user", "update_user", "start_enrollment", "disable_user", "delete_user" };

        public DeviceCommand(string id, string type, string deviceUserId, string name, int privilege, string idempotencyKey)
        {
            Id = id ?? "";
            Type = type ?? "";
            DeviceUserId = deviceUserId ?? "";
            Name = name ?? "";
            Privilege = privilege;
            IdempotencyKey = idempotencyKey ?? "";
        }

        public string Id { get; private set; }
        public string Type { get; private set; }
        public string DeviceUserId { get; private set; }
        public string Name { get; private set; }
        public int Privilege { get; private set; }
        public string IdempotencyKey { get; private set; }

        public void Validate()
        {
            Guid parsedId;
            if (!Guid.TryParse(Id, out parsedId) || parsedId == Guid.Empty) throw new ArgumentException("command ID must be a UUID", "Id");
            if (Array.IndexOf(AllowedTypes, Type) < 0) throw new ArgumentException("unsupported command type", "Type");
            if (String.IsNullOrWhiteSpace(DeviceUserId)) throw new ArgumentException("device user ID is required", "DeviceUserId");
            if (String.IsNullOrWhiteSpace(Name)) throw new ArgumentException("name is required", "Name");
            if (Privilege < 0 || Privilege > 2) throw new ArgumentOutOfRangeException("Privilege");
            if (String.IsNullOrWhiteSpace(IdempotencyKey)) throw new ArgumentException("idempotency key is required", "IdempotencyKey");
        }
    }
}
