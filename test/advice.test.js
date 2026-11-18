import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdvice, ADVICE_WAIT_MINUTES } from "../src/advice.js";

const GAS = {
  baseFeePerGas: "0.005",
  priorityFeePerGas: { low: "0.0005", medium: "0.001", high: "0.006" },
  gasPrice: "0.006",
  estimatedTransferCost: { gasLimit: 21000, eth: "0.000000126", usd: "0.0003" },
  suggestedFees: {
    unit: "wei",
    low: { maxFeePerGas: "10500000", maxPriorityFeePerGas: "500000" },
    medium: { maxFeePerGas: "11000000", maxPriorityFeePerGas: "1000000" },
    high: { maxFeePerGas: "16000000", maxPriorityFeePerGas: "6000000" },
  },
};

// A 24h window from 0.005 to 0.015 gwei (200% spread). `verdict` is what
// getHistory() said about its own last sample, which advice must ignore.
const RANGE = { min: 0.005, max: 0.015, avg: 0.008, median: 0.007 };
const history = (summary = RANGE, verdict = "normal") => ({ summary, verdict, verdictNote: "stale" });
const gasAt = (gasPrice) => ({ ...GAS, gasPrice });

test("live price above the 24h max -> wait 15 minutes as a spike", () => {
  const r = buildAdvice(gasAt("0.02"), history(RANGE, "cheap"));
  assert.equal(r.advice, "wait");
  assert.equal(r.confidence, "high");
  assert.equal(r.waitMinutes, ADVICE_WAIT_MINUTES);
  assert.equal(r.waitMinutes, 15);
  assert.equal(r.verdict, "expensive");
  assert.match(r.reason, /above anything seen in the last 24 hours/);
});

test("live price in the top third -> wait", () => {
  const r = buildAdvice(gasAt("0.014"), history());
  assert.equal(r.advice, "wait");
  assert.equal(r.verdict, "expensive");
  assert.match(r.verdictNote, /90% of the window's range/);
});

test("live price at the bottom while the last sample was expensive -> send_now", () => {
  const r = buildAdvice(gasAt("0.0055"), history(RANGE, "expensive"));
  assert.equal(r.advice, "send_now");
  assert.equal(r.verdict, "cheap");
  assert.equal(r.waitMinutes, null);
  assert.match(r.verdictNote, /5% of the window's range/);
});

test("live price mid-range -> normal, send_now", () => {
  const r = buildAdvice(gasAt("0.01"), history());
  assert.equal(r.advice, "send_now");
  assert.equal(r.verdict, "normal");
});

test("flat window (spread under 1%) -> send_now", () => {
  const flat = { min: 0.006, max: 0.006000402, avg: 0.006, median: 0.006 };
  const r = buildAdvice(gasAt("0.0060004"), history(flat, "expensive"));
  assert.equal(r.advice, "send_now");
  assert.equal(r.confidence, "high");
  assert.equal(r.verdict, "flat");
  assert.match(r.reason, /nothing to wait for/);
});

// Base on its fee floor: the whole 24h window sat at exactly 0.006 gwei.
const FLOOR = { min: 0.006, max: 0.006, avg: 0.006, median: 0.006 };

test("flat window, live a rounding tick above max -> send_now (flat)", () => {
  const r = buildAdvice(gasAt("0.006000001"), history(FLOOR));
  assert.equal(r.advice, "send_now");
  assert.equal(r.verdict, "flat");
});

test("flat window, live exactly 10% above max -> wait (spike)", () => {
  const r = buildAdvice(gasAt("0.0066"), history(FLOOR));
  assert.equal(r.advice, "wait");
  assert.equal(r.waitMinutes, 15);
  assert.match(r.reason, /above anything seen in the last 24 hours/);
});

test("flat window, live under 10% above max -> send_now", () => {
  const r = buildAdvice(gasAt("0.0065"), history(FLOOR));
  assert.equal(r.advice, "send_now");
  assert.equal(r.verdict, "flat");
});

test("varied window, live above max but under the spike threshold -> top of range", () => {
  const r = buildAdvice(gasAt("0.016"), history());
  assert.equal(r.verdict, "expensive");
  assert.match(r.verdictNote, /100% of the window's range/);
  assert.doesNotMatch(r.reason, /above anything seen/);
});

test("no samples (summary null) -> send_now with low confidence", () => {
  const r = buildAdvice(GAS, { summary: null, verdict: null, verdictNote: null });
  assert.equal(r.advice, "send_now");
  assert.equal(r.confidence, "low");
  assert.equal(r.waitMinutes, null);
  assert.equal(r.verdict, null);
  assert.equal(r.verdictNote, null);
});

test("now and suggestedFees come from the gas data, medium tier only", () => {
  const r = buildAdvice(GAS, history());
  assert.deepEqual(r.now, {
    costUsd: "0.0003",
    gasLimit: 21000,
    baseFeePerGas: "0.005",
    priorityFeePerGas: { medium: "0.001" },
  });
  assert.deepEqual(r.suggestedFees, { maxFeePerGas: "11000000", maxPriorityFeePerGas: "1000000" });
  assert.match(r.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("null suggestedFees (block without a base fee) stays null, no throw", () => {
  const r = buildAdvice({ ...GAS, suggestedFees: null }, history());
  assert.equal(r.suggestedFees, null);
  assert.equal(r.advice, "send_now");
});

test("missing USD price is passed through as null", () => {
  const r = buildAdvice(
    { ...GAS, estimatedTransferCost: { ...GAS.estimatedTransferCost, usd: null } },
    history(),
  );
  assert.equal(r.now.costUsd, null);
});
