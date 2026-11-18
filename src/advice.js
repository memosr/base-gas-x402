/**
 * "Should I send this transaction on Base now, or wait?" in one answer.
 *
 * Built only from data the service already has: the live read from
 * getGasData() and the 24-hour range from getHistory(24). The verdict is
 * recomputed against the LIVE gas price rather than taken from history,
 * whose last sample can be up to 5 minutes old while a Base spike lasts about
 * 15. Only an expensive live price says wait. cheap, normal and flat all mean
 * waiting is unlikely to save anything, and with no history yet the answer
 * defaults to send_now with low confidence rather than inventing a reason to
 * hold.
 */

/** How long to hold off when gas is expensive, roughly three sample intervals. */
export const ADVICE_WAIT_MINUTES = 15;

// Same threshold as getHistory(): below it the window has nothing to time.
const MEANINGFUL_SPREAD_PERCENT = 1;

// Live price must be at least 10% over the 24h max to count as a spike, so a rounding-level tick on a flat window does not say wait.
export const SPIKE_FACTOR = 1.1;

const REASONS = {
  spike: `Base gas right now is above anything seen in the last 24 hours, likely a short spike, so waiting about ${ADVICE_WAIT_MINUTES} minutes may cost less.`,
  expensive: `Base gas is in the top third of its last-24-hour range, so waiting about ${ADVICE_WAIT_MINUTES} minutes may cost less.`,
  normal: "Base gas is in the middle of its last-24-hour range, so waiting is unlikely to save much and sending now is fine.",
  cheap: "Base gas is in the bottom third of its last-24-hour range, so now is a good time to send.",
  flat: "Base gas has not moved meaningfully in the last 24 hours, so there is nothing to wait for.",
};
const NO_HISTORY_REASON =
  "Not enough gas history has been collected yet to compare against, so this defaults to sending now.";

/**
 * Places the live gas price (gwei) in the window's range.
 * @param {number} live
 * @param {{ min: number, max: number }} summary
 * @returns {{ verdict: string, verdictNote: string, spike: boolean }}
 */
export function liveVerdict(live, { min, max }) {
  // Rounded to the 9 decimals history uses, or 0.006 x 1.1 lands a hair above 0.0066.
  const spikeAt = Number((max * SPIKE_FACTOR).toFixed(9));
  if (live >= spikeAt) {
    return {
      verdict: "expensive",
      verdictNote: `Live price ${live} gwei is at least ${Math.round((SPIKE_FACTOR - 1) * 100)}% above the 24-hour max of ${max} gwei.`,
      spike: true,
    };
  }

  const spreadPercent = min > 0 ? Number((((max - min) / min) * 100).toFixed(4)) : null;
  if (spreadPercent === null || spreadPercent < MEANINGFUL_SPREAD_PERCENT) {
    return {
      verdict: "flat",
      verdictNote:
        spreadPercent === null
          ? "Not enough data to judge variation."
          : `Gas has not moved meaningfully in this window (spread ${spreadPercent}%, below the ${MEANINGFUL_SPREAD_PERCENT}% threshold). There is nothing to wait for.`,
      spike: false,
    };
  }

  // Clamped to [0, 1]: under the floor is cheap, a little over the max (below
  // the spike threshold) is just the top of the range.
  const position = Math.min(1, Math.max(0, (live - min) / (max - min)));
  return {
    verdict: position <= 0.33 ? "cheap" : position <= 0.66 ? "normal" : "expensive",
    verdictNote: `Live price sits at ${Math.round(position * 100)}% of the window's range (spread ${spreadPercent}%).`,
    spike: false,
  };
}

/**
 * @param {object} gas Result of getGasData(gasLimit).
 * @param {{ summary: { min: number, max: number } | null }} history Result of getHistory(24).
 */
export function buildAdvice(gas, history) {
  const live = Number(gas.gasPrice);
  const summary = history?.summary ?? null;
  const judged = summary && Number.isFinite(live) ? liveVerdict(live, summary) : null;

  const verdict = judged?.verdict ?? null;
  const shouldWait = verdict === "expensive";

  return {
    advice: shouldWait ? "wait" : "send_now",
    confidence: judged ? "high" : "low",
    reason: judged ? REASONS[judged.spike ? "spike" : verdict] : NO_HISTORY_REASON,
    waitMinutes: shouldWait ? ADVICE_WAIT_MINUTES : null,
    now: {
      costUsd: gas.estimatedTransferCost?.usd ?? null,
      gasLimit: gas.estimatedTransferCost?.gasLimit ?? null,
      baseFeePerGas: gas.baseFeePerGas ?? null,
      priorityFeePerGas: { medium: gas.priorityFeePerGas?.medium ?? null },
    },
    verdict,
    verdictNote: judged?.verdictNote ?? null,
    // Medium tier in wei, ready to sign. Null when the block had no base fee.
    suggestedFees: gas.suggestedFees?.medium ?? null,
    fetchedAt: new Date().toISOString(),
  };
}
