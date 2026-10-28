import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

function getWithHost(path, host) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path, headers: { Host: host, "X-Forwarded-Proto": "https" } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      })
      .on("error", reject);
  });
}

// Boots the real server (facilitator stubbed) and checks the x402 contract.
//
// The CDP facilitator rejects payment payloads past ~4200 bytes, and the
// bazaar metadata in the 402 challenge is echoed into that payload. Measured
// on Base: 4188 bytes accepted, 4260 rejected. An x402 upgrade or a longer
// description can push a route over silently, so cap every route here.
const MAX_402_HEADER_BYTES = 3800;
const PORT = 4600 + Math.floor(Math.random() * 300);
const root = fileURLToPath(new URL("..", import.meta.url));
let server;

before(async () => {
  server = spawn(
    process.execPath,
    ["--import", "./test/helpers/stub-facilitator.mjs", "src/server.js"],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        PAY_TO_ADDRESS: "0x0D083590c048A243e24a75E3a7C968145DE25B44",
        // Unreachable on purpose: the sampler must not need a live chain.
        BASE_MAINNET_RPC_URL: "http://127.0.0.1:9",
        UPSTASH_REDIS_REST_URL: "",
        UPSTASH_REDIS_REST_TOKEN: "",
        RATE_LIMIT_PAID_PER_MIN: "2",
      },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
});

after(() => server?.kill());

for (const route of ["/gas", "/gas/compare", "/gas/history", "/gas/cheapest-window"]) {
  test(`${route}: 402 without payment, Base USDC terms, payload under ${MAX_402_HEADER_BYTES} bytes`, async () => {
    // Measured as production sees it: the long Railway host ends up in the
    // header's resource URL, which a 127.0.0.1 request would understate.
    // fetch() cannot set Host, so this goes through node:http.
    const res = await getWithHost(route, "base-gas-x402-production.up.railway.app");
    assert.equal(res.status, 402);
    const header = res.headers["payment-required"];
    assert.ok(header, "payment-required header missing");
    assert.ok(header.length < MAX_402_HEADER_BYTES, `${header.length} bytes`);
    const body = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const [accept] = body.accepts;
    assert.equal(accept.network, "eip155:8453");
    assert.equal(accept.payTo, "0x0D083590c048A243e24a75E3a7C968145DE25B44");
    assert.equal(accept.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
}

for (const route of ["/health", "/info", "/openapi.json"]) {
  test(`${route} is free`, async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`);
    assert.equal(res.status, 200);
  });
}

test("paid requests are rate limited per client before the paywall", async () => {
  const fakePayment = Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64");
  const send = () =>
    fetch(`http://127.0.0.1:${PORT}/gas`, {
      headers: { "payment-signature": fakePayment, "x-real-ip": "203.0.113.7" },
    });
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await send()).status);
  assert.notEqual(statuses[0], 429);
  assert.notEqual(statuses[1], 429);
  assert.equal(statuses[2], 429);

  // Another client is unaffected, and so is the free 402 challenge.
  const other = await fetch(`http://127.0.0.1:${PORT}/gas`, {
    headers: { "payment-signature": fakePayment, "x-real-ip": "203.0.113.8" },
  });
  assert.notEqual(other.status, 429);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/gas`)).status, 402);
});

// HEAD on a paid route used to bypass the paywall and run the handler unpaid
// (x402 SDK bug, fixed upstream in x402-foundation/x402#3796).
for (const route of [
  "/gas", "/gas/compare", "/gas/history", "/gas/cheapest-window",
  // Express matches these to the same handlers (case-insensitive, trailing slash).
  "/GAS", "/gas/", "/Gas/Compare", "/gas/history/", "/GAS/CHEAPEST-WINDOW//",
]) {
  test(`HEAD ${route} is refused, never served unpaid`, async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`, { method: "HEAD" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET");
  });
}

test("HEAD on a free route still works", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`, { method: "HEAD" });
  assert.equal(res.status, 200);
});

test("free routes allow cross-origin reads, paid routes do not", async () => {
  for (const route of ["/health", "/info", "/openapi.json"]) {
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*", route);
  }
  const paid = await fetch(`http://127.0.0.1:${PORT}/gas`);
  assert.equal(paid.headers.get("access-control-allow-origin"), null);
});

test("the unpaid 402 body explains the price, how to pay, and that failures are free", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/gas`, { headers: { Accept: "application/json" } });
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error, "payment_required");
  assert.match(body.price, /^\$\d/);
  assert.match(body.noChargeOnFailure, /never charged/);
  assert.match(body.howToPay.agentcash, /agentcash@latest fetch ".*\/gas"/);
});

test("unknown routes answer JSON 404 listing the real routes", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/nope`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /json/);
  const body = await res.json();
  assert.ok(body.routes["GET /gas"]);
});
