import { test } from "node:test";
import assert from "node:assert/strict";
import { __setSamplesForTests, getCheapestWindow } from "../src/history.js";

// Hourly averages measured on the live service on 30 Sep 2026 (7 days).
const LIVE = {
  22: 0.006, 23: 0.006, 3: 0.006, 4: 0.006, 2: 0.006000025, 11: 0.006000072,
  19: 0.006000106, 21: 0.00600011, 20: 0.006000193, 6: 0.006000338,
  10: 0.006000449, 18: 0.006000582, 5: 0.006000682, 7: 0.006000814,
  0: 0.006001233, 13: 0.006003941, 12: 0.006004842, 1: 0.006004922,
  15: 0.006005137, 17: 0.006013899, 16: 0.006037973, 9: 0.006055709,
  14: 0.00638651, 8: 0.00708324,
};

function seed(byHour) {
  const now = Date.now();
  const series = [];
  for (let t = now - 167 * 3600_000; t <= now; t += 300_000) {
    series.push({ t, baseFee: 0, gasPrice: byHour[new Date(t).getUTCHours()], priorityMedium: 0 });
  }
  __setSamplesForTests(series);
}

test("live data: flags 08 and 14 UTC to avoid, worst first", () => {
  seed(LIVE);
  const r = getCheapestWindow(168);
  assert.equal(r.hasDailyCycle, true);
  assert.deepEqual(r.avoidHoursUtc, [8, 14]);
  assert.equal(r.savingsPercent, 15.3); // unchanged, backward compatible
});

test("live data: savings vs the average hour is the honest ~1% figure", () => {
  seed(LIVE);
  const r = getCheapestWindow(168);
  assert.ok(r.savingsVsAveragePercent > 0.5 && r.savingsVsAveragePercent < 1.5, String(r.savingsVsAveragePercent));
  assert.match(r.recommendation, /^Avoid 08:00 and 14:00 UTC/);
  assert.match(r.recommendation, /cheaper than the average hour/);
});

test("savingsUsd appears with a price and is null without one", () => {
  seed(LIVE);
  assert.equal(getCheapestWindow(168).savingsUsd, null);
  const r = getCheapestWindow(168, { usd: 2691.56 });
  assert.equal(r.savingsUsd.gasLimit, 21000);
  // (0.00708324 - 0.006) gwei * 21000 = 22.748 gwei = 2.2748e-8 ETH * 2691.56 ~ $0.00006123
  assert.equal(r.savingsUsd.vsPriciestHour, "0.00006123");
  assert.ok(Number(r.savingsUsd.vsAverageHour) < Number(r.savingsUsd.vsPriciestHour));
});

test("flat chain: no avoid hours, no cycle", () => {
  const flat = Object.fromEntries([...Array(24).keys()].map((h) => [h, 0.006]));
  seed(flat);
  const r = getCheapestWindow(168, { usd: 2691.56 });
  assert.equal(r.hasDailyCycle, false);
  assert.deepEqual(r.avoidHoursUtc, []);
  assert.equal(r.savingsVsAveragePercent, 0);
  assert.equal(r.savingsUsd.vsAverageHour, "0");
});

test("empty history does not throw", () => {
  __setSamplesForTests([]);
  const r = getCheapestWindow(168, { usd: 2691.56 });
  assert.deepEqual(r.avoidHoursUtc, []);
  assert.equal(r.savingsVsAveragePercent, null);
  assert.equal(r.savingsUsd, null);
});
