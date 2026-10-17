import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`);
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
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
