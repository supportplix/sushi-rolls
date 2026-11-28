using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace SushiRolls.ZkTeco
{
    /// <summary>
    /// Proof-of-possession challenges for privileged pipe commands (configure,
    /// enrollment). A challenge is bound to one pipe connection and one client
    /// PID, lives for at most ChallengeLifetime, and is removed BEFORE the proof
    /// is checked so a captured frame can never be replayed. The HMAC key is
    /// derived from two nonces exchanged over the pipe and exists only in the
    /// two processes' memory: it is never persisted, logged, or sent back.
    /// </summary>
    internal sealed class BridgeAuth
    {
        private static readonly TimeSpan ChallengeLifetime = TimeSpan.FromSeconds(20);

        private sealed class Challenge
        {
            public byte[] Key;
            public int ProcessId;
            public string ConnectionId;
            public DateTime ExpiresAt;
        }

        private readonly object sync = new object();
        private readonly Dictionary<string, Challenge> challenges = new Dictionary<string, Challenge>(StringComparer.Ordinal);

        /// <summary>32 random bytes, base64 encoded. Not a secret on its own.</summary>
        public static string RandomNonce()
        {
            var bytes = new byte[32];
            using (var random = new RNGCryptoServiceProvider())
            {
                random.GetBytes(bytes);
            }
            return Convert.ToBase64String(bytes);
        }

        /// <summary>
        /// Both sides derive the same key from the client and server nonces. The
        /// key itself never crosses the pipe or lands on disk.
        /// </summary>
        public static byte[] DeriveKey(string clientNonce, string serverNonce)
        {
            if (String.IsNullOrWhiteSpace(clientNonce) || String.IsNullOrWhiteSpace(serverNonce))
                throw new ArgumentException("nonces are required");
            var client = Convert.FromBase64String(clientNonce);
            var server = Convert.FromBase64String(serverNonce);
            if (client.Length != 32 || server.Length != 32)
                throw new ArgumentException("invalid nonce length");
            var material = new byte[client.Length + server.Length];
            Buffer.BlockCopy(client, 0, material, 0, client.Length);
            Buffer.BlockCopy(server, 0, material, client.Length, server.Length);
            using (var sha = SHA256.Create())
            {
                return sha.ComputeHash(material);
            }
        }

        public string Issue(byte[] key, int processId, string connectionId)
        {
            if (key == null) throw new ArgumentNullException("key");
            if (processId <= 0) throw new ArgumentException("invalid process id", "processId");
            if (String.IsNullOrWhiteSpace(connectionId)) throw new ArgumentException("connection id is required", "connectionId");
            var challenge = RandomNonce();
            lock (sync)
            {
                PruneExpired();
                challenges[challenge] = new Challenge
                {
                    Key = (byte[])key.Clone(),
                    ProcessId = processId,
                    ConnectionId = connectionId,
                    ExpiresAt = DateTime.UtcNow.Add(ChallengeLifetime)
                };
            }
            return challenge;
        }

        /// <summary>
        /// Consumes the challenge (valid or not, success or failure) and verifies
        /// the HMAC proof in constant time. Returns false for unknown, expired,
        /// cross-connection, cross-PID, or bad-proof submissions.
        /// </summary>
        public bool Verify(string challengeText, string proofText, int processId, string connectionId)
        {
            if (String.IsNullOrWhiteSpace(challengeText) || challengeText.Length > 512) return false;
            if (String.IsNullOrWhiteSpace(proofText) || proofText.Length > 512) return false;
            Challenge issued;
            lock (sync)
            {
                // Single use: remove first, even when the proof is wrong.
                if (!challenges.TryGetValue(challengeText, out issued)) return false;
                challenges.Remove(challengeText);
                PruneExpired();
            }
            try
            {
                if (issued == null || processId <= 0 || issued.ProcessId != processId) return false;
                if (!String.Equals(issued.ConnectionId, connectionId, StringComparison.Ordinal)) return false;
                if (DateTime.UtcNow > issued.ExpiresAt) return false;
                var proof = Convert.FromBase64String(proofText);
                var rawChallenge = Convert.FromBase64String(challengeText);
                if (proof.Length != 32 || rawChallenge.Length != 32) return false;
                byte[] expected;
                using (var hmac = new HMACSHA256(issued.Key))
                {
                    expected = hmac.ComputeHash(rawChallenge);
                }
                var difference = 0;
                for (var index = 0; index < expected.Length; index++)
                    difference |= expected[index] ^ proof[index];
                return difference == 0;
            }
            catch (FormatException) { return false; }
            finally
            {
                if (issued != null && issued.Key != null) Array.Clear(issued.Key, 0, issued.Key.Length);
            }
        }

        public void DiscardConnection(string connectionId)
        {
            lock (sync)
            {
                var stale = new List<string>();
                foreach (var pair in challenges)
                {
                    if (String.Equals(pair.Value.ConnectionId, connectionId, StringComparison.Ordinal)) stale.Add(pair.Key);
                }
                foreach (var key in stale) challenges.Remove(key);
            }
        }

        private void PruneExpired()
        {
            var now = DateTime.UtcNow;
            var stale = new List<string>();
            foreach (var pair in challenges)
            {
                if (pair.Value.ExpiresAt < now) stale.Add(pair.Key);
            }
            foreach (var key in stale) challenges.Remove(key);
        }
    }
}
