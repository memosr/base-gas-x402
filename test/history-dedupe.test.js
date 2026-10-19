import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startFakeBaseRpc } from "./helpers/fake-base-rpc.mjs";

// A fake Upstash REST endpoint with just the commands the history store uses.
// Two sampler instances (the old and new container during a Railway deploy)
// share it, exactly like production shares one Redis.
const zset = [];
const keys = new Map();
const upstash = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const [cmd, key, ...args] = JSON.parse(body);
    let result = null;
    if (cmd === "SET") {
      const nx = args.includes("NX");
      if (nx && keys.has(key)) result = null;
      else { keys.set(key, args[0]); result = "OK"; }
    } else if (cmd === "ZADD") {
      zset.push({ score: Number(args[0]), member: args[1] });
      result = 1;
    } else if (cmd === "ZRANGEBYSCORE") {
      result = zset.filter((r) => r.score >= Number(args[0])).sort((a, b) => a.score - b.score).map((r) => r.member);
    } else if (cmd === "ZREMRANGEBYSCORE") {
      result = 0;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result }));
  });
});

let rpc;
before(async () => {
  rpc = await startFakeBaseRpc();
  await new Promise((r) => upstash.listen(0, "127.0.0.1", r));
  const rpcUrl = `http://127.0.0.1:${rpc.port}`;
  process.env.BASE_MAINNET_RPC_URL = rpcUrl;
  process.env.BASE_MAINNET_RPC_FALLBACK_URLS = rpcUrl;
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${upstash.address().port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.HISTORY_SAMPLE_INTERVAL_MS = "3600000";
});
after(() => {
  upstash.close();
  rpc.close();
});

const settle = () => new Promise((r) => setTimeout(r, 300));

test("two instances sampling the same slot persist it once", async () => {
  // Separate module instances = separate in-memory buffers, as in two containers.
  const oldInstance = await import("../src/history.js?instance=old");
  await oldInstance.startSampler();
  await settle();
  assert.equal(zset.length, 1, "old instance should persist its first sample");

  // The new container boots during the same slot: it restores the old
  // sample and must neither take an immediate duplicate nor persist one.
  const newInstance = await import("../src/history.js?instance=new");
  await newInstance.startSampler();
  await settle();
  assert.equal(zset.length, 1, `expected 1 persisted sample, got ${zset.length}`);
  assert.equal(newInstance.coverage().samples, 1, "restored sample is visible to the new instance");
});

test("claimSlot: the first instance wins a slot, the second is told to skip", async () => {
  const store = await import("../src/store.js");
  assert.equal(await store.claimSlot(424242, 600), true);
  assert.equal(await store.claimSlot(424242, 600), false);
  assert.equal(await store.claimSlot(424243, 600), true);
});
