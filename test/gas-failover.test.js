import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeBaseRpc } from "./helpers/fake-base-rpc.mjs";

// The primary RPC is down; /gas must still answer from the fallback, and
// rpcSource must name the RPC that actually answered (hostname only).
let dead, good, gas;

before(async () => {
  dead = await startFakeBaseRpc({ mode: "dead" });
  good = await startFakeBaseRpc();
  process.env.BASE_MAINNET_RPC_URL = `http://127.0.0.1:${dead.port}/v2/SECRETKEY`;
  // "localhost" so the fallback's hostname differs from the primary's.
  process.env.BASE_MAINNET_RPC_FALLBACK_URLS = `http://localhost:${good.port}`;
  process.env.RPC_CACHE_MS = "0";
  gas = await import("../src/gas.js");
});

after(() => {
  dead.close();
  good.close();
});

test("falls back to the next RPC when the primary is down", async () => {
  const data = await gas.getGasData();
  assert.equal(data.blockNumber, "30000000");
  assert.equal(data.baseFeePerGas, "0.005");
  assert.equal(data.rpcSource, "localhost");
  assert.ok(dead.calls() >= 1, "primary was tried first");
  assert.doesNotMatch(JSON.stringify(data), /SECRETKEY/);
});

test("fails only when every RPC fails", async () => {
  good.close();
  await assert.rejects(gas.getGasData());
});
