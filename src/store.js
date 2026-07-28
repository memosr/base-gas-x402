/**
 * Optional durable backing for the gas history buffer.
 *
 * The read path stays in memory: queries never touch the network, so adding
 * durability costs nothing in latency. Redis is used only to survive restarts,
 * which matters because Railway redeploys otherwise wipe the buffer and every
 * deploy resets the one asset that takes real time to rebuild.
 *
 * Configuration is optional. With no Upstash credentials the service behaves
 * exactly as before, in-memory only, and says so at boot. That keeps local
 * development and forks working with zero setup.
 */

const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const KEY = process.env.HISTORY_REDIS_KEY || "base-gas:samples";

export const isEnabled = Boolean(REST_URL && REST_TOKEN);

/**
 * Upstash exposes Redis over HTTP, so no TCP client or connection pool is
 * needed. Commands are sent as a JSON array of arguments.
 * @param {(string|number)[]} command
 */
async function redis(command) {
  const response = await fetch(REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Upstash ${response.status}: ${detail.slice(0, 200)}`);
  }

  const body = await response.json();
  if (body.error) throw new Error(`Upstash: ${body.error}`);
  return body.result;
}

/**
 * Loads persisted samples newer than the retention cutoff.
 * Returns an empty array when persistence is off or the store is empty, so the
 * caller can treat "no durable store" and "store is cold" identically.
 *
 * @param {number} retentionHours
 */
export async function load(retentionHours) {
  if (!isEnabled) return [];

  const cutoff = Date.now() - retentionHours * 3600_000;
  const rows = await redis(["ZRANGEBYSCORE", KEY, cutoff, "+inf"]);
  if (!Array.isArray(rows)) return [];

  const samples = [];
  for (const row of rows) {
    try {
      samples.push(JSON.parse(row));
    } catch {
      // A single corrupt row must not discard an otherwise good history.
    }
  }

  // The sorted set is keyed by timestamp, so this is already chronological.
  return samples;
}

/**
 * Appends one sample and drops anything past the retention window.
 * The score is the sample timestamp, which makes range queries and pruning
 * exact rather than approximate.
 *
 * @param {{t: number}} sample
 * @param {number} retentionHours
 */
export async function append(sample, retentionHours) {
  if (!isEnabled) return;

  const cutoff = Date.now() - retentionHours * 3600_000;
  await redis(["ZADD", KEY, sample.t, JSON.stringify(sample)]);
  await redis(["ZREMRANGEBYSCORE", KEY, "-inf", `(${cutoff}`]);
}
