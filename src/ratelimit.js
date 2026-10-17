/**
 * Per-client rate limit for requests that carry an x402 payment.
 *
 * Every request with a payment header makes the server call the CDP
 * facilitator to verify it, so a flood of fake payment headers would burn the
 * facilitator quota and could get the service throttled for real customers.
 * Requests without a payment are not limited here: they only produce a cheap
 * 402 challenge, and discovery crawlers rely on fetching those freely.
 *
 * A limited request gets 429 before the paywall runs, so it is never charged.
 *
 * Client identity: Railway's edge sets X-Real-IP on public traffic and
 * replaces any value the caller sent, and Railway recommends it for rate
 * limiting. Its proxy hop count is not fixed, so req.ip (derived from
 * X-Forwarded-For and trust proxy) is only the fallback, for local runs.
 *
 * In-memory fixed window: right for a single instance. With several replicas
 * each one would enforce its own limit.
 */

const PAYMENT_HEADERS = ["x-payment", "payment-signature"];
const WINDOW_MS = 60_000;

/** Paid requests allowed per client per minute, from RATE_LIMIT_PAID_PER_MIN. 0 disables. */
export const PAID_PER_MINUTE = (() => {
  const raw = process.env.RATE_LIMIT_PAID_PER_MIN;
  if (raw === undefined || raw === "") return 60;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`RATE_LIMIT_PAID_PER_MIN must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
})();

export function clientKey(req) {
  const real = req.get("x-real-ip");
  return (real && real.trim()) || req.ip || "unknown";
}

/**
 * @param {{ limit?: number, windowMs?: number, now?: () => number }} [options]
 */
export function paidRateLimit({ limit = PAID_PER_MINUTE, windowMs = WINDOW_MS, now = Date.now } = {}) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();
  let lastSweep = now();

  return function rateLimit(req, res, next) {
    if (limit === 0) return next();
    if (!PAYMENT_HEADERS.some((h) => req.get(h))) return next();

    const t = now();

    // Drop expired buckets now and then so the map cannot grow without bound.
    if (t - lastSweep > windowMs) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= t) buckets.delete(key);
      lastSweep = t;
    }

    const key = clientKey(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - t) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Too many paid requests from this client. Nothing was charged.",
        limitPerMinute: limit,
        retryAfterSeconds: retryAfter,
      });
    }

    next();
  };
}
