import { test } from "node:test";
import assert from "node:assert/strict";
import { paidRateLimit, clientKey } from "../src/ratelimit.js";

function call(mw, headers = {}, ip = "1.1.1.1") {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { ip, get: (h) => lower[h.toLowerCase()] };
  const res = {
    statusCode: 200, headers: {}, body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, res };
}

const PAY = { "payment-signature": "abc" };

test("requests without a payment header are never limited", () => {
  const mw = paidRateLimit({ limit: 1 });
  for (let i = 0; i < 5; i++) assert.equal(call(mw).passed, true);
});

test("paid requests over the limit get 429 with Retry-After", () => {
  const mw = paidRateLimit({ limit: 2, now: () => 1000 });
  assert.equal(call(mw, PAY).passed, true);
  assert.equal(call(mw, PAY).passed, true);
  const third = call(mw, PAY);
  assert.equal(third.passed, false);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.res.headers["Retry-After"], "60");
  assert.match(third.res.body.error, /Nothing was charged/);
});

test("the legacy x-payment header counts too", () => {
  const mw = paidRateLimit({ limit: 1 });
  call(mw, { "x-payment": "abc" });
  assert.equal(call(mw, { "x-payment": "abc" }).res.statusCode, 429);
});

test("the window resets", () => {
  let t = 0;
  const mw = paidRateLimit({ limit: 1, windowMs: 1000, now: () => t });
  call(mw, PAY);
  assert.equal(call(mw, PAY).passed, false);
  t = 1001;
  assert.equal(call(mw, PAY).passed, true);
});

test("clients are counted separately, by X-Real-IP first", () => {
  const mw = paidRateLimit({ limit: 1 });
  assert.equal(call(mw, { ...PAY, "x-real-ip": "2.2.2.2" }).passed, true);
  assert.equal(call(mw, { ...PAY, "x-real-ip": "3.3.3.3" }).passed, true);
  assert.equal(call(mw, { ...PAY, "x-real-ip": "2.2.2.2" }).passed, false);
});

test("clientKey falls back to req.ip without X-Real-IP", () => {
  assert.equal(clientKey({ ip: "9.9.9.9", get: () => undefined }), "9.9.9.9");
});

test("limit 0 disables the limiter", () => {
  const mw = paidRateLimit({ limit: 0 });
  for (let i = 0; i < 5; i++) assert.equal(call(mw, PAY).passed, true);
});
