import { test } from "node:test";
import assert from "node:assert/strict";
import { cached } from "../src/cache.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("reuses a successful result within the TTL", async () => {
  let calls = 0;
  const read = cached(async () => ++calls, 50);
  assert.equal(await read(), 1);
  assert.equal(await read(), 1);
  assert.equal(calls, 1);
});

test("reloads after the TTL expires", async () => {
  let calls = 0;
  const read = cached(async () => ++calls, 20);
  await read();
  await sleep(30);
  assert.equal(await read(), 2);
});

test("concurrent callers share one in-flight read", async () => {
  let calls = 0;
  const read = cached(async () => {
    calls += 1;
    await sleep(20);
    return calls;
  }, 50);
  const results = await Promise.all([read(), read(), read()]);
  assert.deepEqual(results, [1, 1, 1]);
  assert.equal(calls, 1);
});

test("never caches a failure", async () => {
  let calls = 0;
  const read = cached(async () => {
    calls += 1;
    if (calls === 1) throw new Error("rpc down");
    return "ok";
  }, 1000);
  await assert.rejects(read(), /rpc down/);
  assert.equal(await read(), "ok");
  assert.equal(calls, 2);
});

test("TTL 0 disables caching", async () => {
  let calls = 0;
  const read = cached(async () => ++calls, 0);
  await read();
  await read();
  assert.equal(calls, 2);
});
