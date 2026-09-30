import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRound, weiToUsd, ethUsdBlock } from "../src/price.js";

const NOW = 1_790_000_000;
const round = (answer, updatedAt) => [1n, answer, 0n, BigInt(updatedAt), 1n];

test("parses a fresh 8-decimal answer", () => {
  const p = parseRound(round(265012000000n, NOW - 60), 8, NOW);
  assert.equal(p.usd, 2650.12);
  assert.equal(p.updatedAt, new Date((NOW - 60) * 1000).toISOString());
});

test("rejects a stale answer (older than 2 hours)", () => {
  assert.equal(parseRound(round(265012000000n, NOW - 2 * 3600 - 1), 8, NOW), null);
});

test("rejects a zero or negative answer", () => {
  assert.equal(parseRound(round(0n, NOW), 8, NOW), null);
  assert.equal(parseRound(round(-1n, NOW), 8, NOW), null);
});

test("rejects an answer dated in the future", () => {
  assert.equal(parseRound(round(265012000000n, NOW + 600), 8, NOW), null);
});

test("converts wei to a USD string without exponent notation", () => {
  const price = { usd: 2650.12 };
  // 21000 gas at 0.006 gwei = 126 gwei = 1.26e-7 ETH -> ~$0.0003339
  assert.equal(weiToUsd(126_000_000_000n, price), "0.0003339");
  // 1 ETH
  assert.equal(weiToUsd(10n ** 18n, price), "2650");
  assert.equal(weiToUsd(0n, price), "0");
});

test("returns null without a price", () => {
  assert.equal(weiToUsd(10n ** 18n, null), null);
  assert.equal(ethUsdBlock(null), null);
});

test("ethUsd block shape", () => {
  assert.deepEqual(ethUsdBlock({ usd: 2650.1234, updatedAt: "2026-09-30T00:00:00.000Z" }), {
    price: "2650.12",
    source: "chainlink-eth-usd-base",
    updatedAt: "2026-09-30T00:00:00.000Z",
  });
});
