import { test } from "node:test";
import assert from "node:assert/strict";

// Points the price reader at an address that cannot answer, so the read fails.
// getEthUsd must resolve to null quickly instead of throwing: /gas and the
// history sampler both depend on that.
process.env.BASE_MAINNET_RPC_URL = "http://127.0.0.1:9";

test("getEthUsd returns null instead of throwing when the RPC is down", async () => {
  const { getEthUsd } = await import("../src/price.js");
  const started = Date.now();
  const price = await getEthUsd();
  assert.equal(price, null);
  assert.ok(Date.now() - started < 10_000, "must fail fast");
});

test("after a failure, the next call skips the feed and answers at once", async () => {
  const { getEthUsd } = await import("../src/price.js");
  const started = Date.now();
  assert.equal(await getEthUsd(), null);
  assert.ok(Date.now() - started < 50, "backoff should answer without an RPC round trip");
});
