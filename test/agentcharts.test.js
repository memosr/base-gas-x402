import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Boots the real server (facilitator stubbed) with and without the proof set.
const root = fileURLToPath(new URL("..", import.meta.url));
const servers = [];

async function startServer(proof) {
  const port = 4900 + Math.floor(Math.random() * 300);
  const env = {
    ...process.env,
    PORT: String(port),
    PAY_TO_ADDRESS: "0x0D083590c048A243e24a75E3a7C968145DE25B44",
    BASE_MAINNET_RPC_URL: "http://127.0.0.1:9",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
  };
  delete env.AGENTCHARTS_PROOF;
  if (proof !== undefined) env.AGENTCHARTS_PROOF = proof;

  const server = spawn(
    process.execPath,
    ["--import", "./test/helpers/stub-facilitator.mjs", "src/server.js"],
    { cwd: root, env, stdio: "ignore" },
  );
  servers.push(server);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return port;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}

after(() => servers.forEach((s) => s.kill()));

test("/.well-known/agentcharts.txt serves the trimmed proof as text/plain, free", async () => {
  const port = await startServer("  agentcharts-proof-abc123\n");
  const res = await fetch(`http://127.0.0.1:${port}/.well-known/agentcharts.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain/);
  assert.equal(await res.text(), "agentcharts-proof-abc123");
});

test("/.well-known/agentcharts.txt is a JSON 404 when the proof is unset", async () => {
  const port = await startServer(undefined);
  const res = await fetch(`http://127.0.0.1:${port}/.well-known/agentcharts.txt`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /json/);
  const body = await res.json();
  assert.equal(body.error, "not_found");
  assert.ok(body.routes["GET /gas"]);
});
