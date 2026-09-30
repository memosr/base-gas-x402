/**
 * Tiny time-based cache for RPC reads.
 *
 * Base produces a block every 2 seconds, so two callers asking within that
 * window would get the same answer from the chain anyway. Sharing one read
 * between them cuts RPC traffic (and the rate-limit risk on free RPCs) without
 * serving anything staler than a single block.
 *
 * Two rules keep it safe for a paid endpoint:
 *   1. Concurrent callers share the in-flight promise, so a burst of requests
 *      triggers one RPC read, not one each.
 *   2. A failed read is never cached. The next caller retries immediately.
 *
 * @template T
 * @param {() => Promise<T>} load Function that performs the real read.
 * @param {number} ttlMs How long a successful result is reused.
 * @returns {() => Promise<T>}
 */
export function cached(load, ttlMs) {
  // A TTL of 0 (RPC_CACHE_MS=0) switches caching off entirely.
  if (!(ttlMs > 0)) return load;

  let value;
  let expiresAt = 0;
  let inFlight = null;

  return function read() {
    if (Date.now() < expiresAt) return Promise.resolve(value);
    if (inFlight) return inFlight;

    inFlight = load()
      .then((result) => {
        value = result;
        expiresAt = Date.now() + ttlMs;
        return result;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };
}

/**
 * RPC cache lifetime in milliseconds, from RPC_CACHE_MS. Defaults to 2000
 * (one Base block). Set 0 to disable.
 */
export const RPC_CACHE_MS = (() => {
  const raw = process.env.RPC_CACHE_MS;
  if (raw === undefined || raw === "") return 2000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
})();
