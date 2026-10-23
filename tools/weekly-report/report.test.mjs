import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, postText, renderSvg } from "./report.mjs";

// A week on the 0.006 gwei floor with one 25-minute spike to 0.0499 and one
// single 5-minute blip, shaped like the real week of Oct 11 to 18.
function week() {
  const start = Date.parse("2026-10-11T12:30:00Z");
  return Array.from({ length: 2016 }, (_, i) => {
    let gasPrice = 0.006;
    if (i >= 1000 && i < 1005) gasPrice = i === 1002 ? 0.0499 : 0.03;
    if (i === 1500) gasPrice = 0.0091;
    return { t: new Date(start + i * 300_000).toISOString(), gasPrice };
  });
}

test("finds the floor, the share on it and each spike", () => {
  const a = analyze(week());
  assert.equal(a.floor, 0.006);
  assert.equal(a.readings, 2016);
  assert.equal(a.spikeCount, 2);
  assert.equal(a.biggest.minutes, 25);
  assert.equal(a.biggest.multiple.toFixed(1), "8.3");
  assert.ok(a.onFloorPercent > 99.6 && a.onFloorPercent < 99.8);
});

test("post fits in one X post and states the facts", () => {
  const text = postText(analyze(week()), "0.0026");
  assert.ok(text.length <= 280, `${text.length} chars`);
  assert.match(text, /8\.3x/);
  assert.match(text, /\$0\.0026/);
  assert.match(text, /0\.006 gwei floor/);
});

test("a flat week says so instead of inventing a spike", () => {
  const flat = week().map((s) => ({ ...s, gasPrice: 0.006 }));
  const a = analyze(flat);
  assert.equal(a.spikeCount, 0);
  assert.match(postText(a, null), /No spike above 5% all week/);
});

test("refuses to report on too little data", () => {
  assert.throws(() => analyze(week().slice(0, 5)), /Not enough history/);
});

test("chart is a well-formed SVG with the floor and the spike marked", () => {
  const samples = week();
  const svg = renderSvg(samples, analyze(samples));
  assert.match(svg, /^<svg /);
  assert.match(svg, /floor 0\.006 gwei/);
  assert.match(svg, /8\.3x spike/);
  assert.ok(!svg.includes("NaN"));
});
