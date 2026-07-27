import { getGasData } from "./gas.js";

/**
 * In-memory gas history.
 *
 * This is the part a free RPC cannot replace. `eth_gasPrice` tells you what gas
 * costs right now; it cannot tell you whether that is high or low, or when the
 * cheap hours are. Answering that requires someone to have been watching, which
 * is exactly what this module does.
 *
 * Storage is a plain in-process ring buffer: at one sample every 5 minutes,
 * seven days of history is ~2000 records of ~100 bytes. Persisting that to Redis
 * or a volume would cost money and operational surface for no benefit at this
 * traffic level. The tradeoff is that a redeploy resets the buffer, which is why
 * every response reports its own coverage instead of pretending to be complete.
 */

const SAMPLE_INTERVAL_MS = Number(
  process.env.HISTORY_SAMPLE_INTERVAL_MS || 5 * 60 * 1000,
);

const RETENTION_HOURS = Number(process.env.HISTORY_RETENTION_HOURS || 168);

// Ring buffer capacity derived from retention, plus a small margin.
const MAX_SAMPLES = Math.ceil((RETENTION_HOURS * 3600_000) / SAMPLE_INTERVAL_MS) + 10;

/** @type {{t: number, baseFee: number, gasPrice: number, priorityMedium: number}[]} */
const samples = [];

let lastError = null;
let sampleCount = 0;
let startedAt = null;

function prune() {
  const cutoff = Date.now() - RETENTION_HOURS * 3600_000;
  while (samples.length && samples[0].t < cutoff) samples.shift();
  while (samples.length > MAX_SAMPLES) samples.shift();
}

async function takeSample() {
  try {
    const data = await getGasData();
    samples.push({
      t: Date.parse(data.fetchedAt),
      baseFee: Number(data.baseFeePerGas),
      gasPrice: Number(data.gasPrice),
      priorityMedium: Number(data.priorityFeePerGas.medium),
    });
    sampleCount += 1;
    lastError = null;
    prune();
  } catch (error) {
    // A failed sample must never crash the sampler loop: a transient RPC error
    // would otherwise silently kill history collection for the whole process.
    lastError = error instanceof Error ? error.message : String(error);
    console.error("[history] sample failed:", lastError);
  }
}

/** Starts the background sampler. Safe to call once at boot. */
export function startSampler() {
  if (startedAt) return;
  startedAt = Date.now();

  // Take one immediately so a freshly deployed instance is not completely blind.
  takeSample();
  const timer = setInterval(takeSample, SAMPLE_INTERVAL_MS);
  timer.unref?.();

  console.log(
    `[history] sampling every ${SAMPLE_INTERVAL_MS / 1000}s, retaining ${RETENTION_HOURS}h`,
  );
}

/**
 * How much history is actually available. Exposed on the free /health route so
 * agents can decide whether paying for /gas/history is worth it, rather than
 * discovering thin coverage after they have already been charged.
 */
export function coverage() {
  if (samples.length === 0) {
    return {
      samples: 0,
      hoursCovered: 0,
      oldestSample: null,
      newestSample: null,
      sampleIntervalSeconds: SAMPLE_INTERVAL_MS / 1000,
      retentionHours: RETENTION_HOURS,
      lastError,
    };
  }

  const oldest = samples[0].t;
  const newest = samples[samples.length - 1].t;

  return {
    samples: samples.length,
    hoursCovered: Number(((newest - oldest) / 3600_000).toFixed(2)),
    oldestSample: new Date(oldest).toISOString(),
    newestSample: new Date(newest).toISOString(),
    sampleIntervalSeconds: SAMPLE_INTERVAL_MS / 1000,
    retentionHours: RETENTION_HOURS,
    totalSamplesTaken: sampleCount,
    lastError,
  };
}

function windowSamples(hours) {
  const cutoff = Date.now() - hours * 3600_000;
  return samples.filter((s) => s.t >= cutoff);
}

function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    min: Number(sorted[0].toFixed(9)),
    max: Number(sorted[sorted.length - 1].toFixed(9)),
    avg: Number((sum / values.length).toFixed(9)),
    median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(9)),
  };
}

/**
 * Gas history over the requested window, with summary statistics and a verdict
 * on where the current price sits relative to that window.
 */
export function getHistory(hours) {
  const window = windowSamples(hours);
  const gasPrices = window.map((s) => s.gasPrice);
  const summary = stats(gasPrices);

  let current = null;
  let verdict = null;
  let verdictNote = null;
  let spreadPercent = null;

  if (window.length > 0) {
    current = window[window.length - 1].gasPrice;

    if (summary && summary.min > 0) {
      // How wide the window actually is, as a percentage of the floor.
      spreadPercent = Number(
        (((summary.max - summary.min) / summary.min) * 100).toFixed(4),
      );
    }

    // A cheap/normal/expensive verdict only means something if the window has
    // meaningful variation. Base sits on its fee floor for hours at a time, so
    // `max > min` can be true by a rounding artifact and still produce a
    // confident-sounding "cheap" that a caller would wrongly read as "act now".
    // Below this threshold the honest answer is that there is nothing to time.
    const MEANINGFUL_SPREAD_PERCENT = 1;

    if (spreadPercent !== null && spreadPercent >= MEANINGFUL_SPREAD_PERCENT) {
      // Where the current price sits in the window's range, 0 = cheapest seen.
      const position = (current - summary.min) / (summary.max - summary.min);
      verdict =
        position <= 0.33 ? "cheap" : position <= 0.66 ? "normal" : "expensive";
      verdictNote = `Current price sits at ${Math.round(position * 100)}% of the window's range (spread ${spreadPercent}%).`;
    } else {
      verdict = "flat";
      verdictNote =
        spreadPercent === null
          ? "Not enough data to judge variation."
          : `Gas has not moved meaningfully in this window (spread ${spreadPercent}%, below the ${MEANINGFUL_SPREAD_PERCENT}% threshold). There is nothing to wait for.`;
    }
  }

  return {
    chain: "base-mainnet",
    chainId: 8453,
    requestedHours: hours,
    units: "gwei",
    currentGasPrice: current,
    verdict,
    verdictNote,
    spreadPercent,
    summary,
    samples: window.map((s) => ({
      t: new Date(s.t).toISOString(),
      baseFee: s.baseFee,
      gasPrice: s.gasPrice,
      priorityMedium: s.priorityMedium,
    })),
    coverage: coverage(),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Average gas price bucketed by hour of day (UTC), so agents can schedule work
 * for the hours that are historically cheapest.
 */
export function getCheapestWindow(hours) {
  const window = windowSamples(hours);

  /** @type {Map<number, number[]>} */
  const buckets = new Map();
  for (const s of window) {
    const hour = new Date(s.t).getUTCHours();
    if (!buckets.has(hour)) buckets.set(hour, []);
    buckets.get(hour).push(s.gasPrice);
  }

  const hourly = [...buckets.entries()]
    .map(([hour, values]) => ({
      hourUtc: hour,
      samples: values.length,
      avgGasPrice: Number(
        (values.reduce((a, b) => a + b, 0) / values.length).toFixed(9),
      ),
    }))
    .sort((a, b) => a.avgGasPrice - b.avgGasPrice);

  const cheapest = hourly[0] ?? null;
  const priciest = hourly[hourly.length - 1] ?? null;

  let savingsPercent = null;
  if (cheapest && priciest && priciest.avgGasPrice > 0) {
    savingsPercent = Number(
      (
        ((priciest.avgGasPrice - cheapest.avgGasPrice) / priciest.avgGasPrice) *
        100
      ).toFixed(1),
    );
  }

  // Ranking hours by average price implies the hours differ. On a chain that
  // sits at its fee floor they do not, and returning a confident "cheapest hour"
  // would be selling a decision that cannot be made. Say so instead.
  const MEANINGFUL_SAVINGS_PERCENT = 1;
  const hasDailyCycle =
    savingsPercent !== null && savingsPercent >= MEANINGFUL_SAVINGS_PERCENT;

  let recommendation;
  if (hourly.length === 0) {
    recommendation = "No history collected yet. Check GET /health for coverage.";
  } else if (hasDailyCycle) {
    recommendation = `Transact around ${String(cheapest.hourUtc).padStart(2, "0")}:00 UTC to save about ${savingsPercent}% versus the priciest hour (${String(priciest.hourUtc).padStart(2, "0")}:00 UTC).`;
  } else {
    recommendation = `No meaningful daily gas cycle on this chain: the gap between the cheapest and priciest hour is ${savingsPercent ?? 0}%. Timing a transaction by hour of day will not save anything. Transact whenever you need to.`;
  }

  return {
    chain: "base-mainnet",
    chainId: 8453,
    requestedHours: hours,
    units: "gwei",
    // The headline answer, stated plainly, so a caller does not have to infer
    // it from the ranking below.
    hasDailyCycle,
    recommendation,
    savingsPercent,
    // Hours seen so far, cheapest first. Only actionable when hasDailyCycle is
    // true; kept either way because the raw distribution is still data.
    hourlyAverages: hourly,
    cheapestHourUtc: cheapest ? cheapest.hourUtc : null,
    priciestHourUtc: priciest ? priciest.hourUtc : null,
    hoursObserved: hourly.length,
    coverage: coverage(),
    fetchedAt: new Date().toISOString(),
  };
}
