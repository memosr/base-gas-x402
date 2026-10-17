import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { intEnv } from "../src/config.js";

const range = { min: 1, max: 720 };

test("intEnv uses the fallback when unset or empty", () => {
  delete process.env.X_TEST_INT;
  assert.equal(intEnv("X_TEST_INT", 168, range), 168);
  process.env.X_TEST_INT = "  ";
  assert.equal(intEnv("X_TEST_INT", 168, range), 168);
});

test("intEnv accepts a valid integer", () => {
  process.env.X_TEST_INT = "24";
  assert.equal(intEnv("X_TEST_INT", 168, range), 24);
});

test("intEnv refuses typos, decimals and out-of-range values", () => {
  for (const bad of ["5m", "abc", "1.5", "0", "721", "-3"]) {
    process.env.X_TEST_INT = bad;
    assert.throws(() => intEnv("X_TEST_INT", 168, range), /X_TEST_INT must be an integer/, bad);
  }
});

// The server must refuse to start on a bad setting rather than run broken.
const root = fileURLToPath(new URL("..", import.meta.url));
function boot(env) {
  return spawnSync(
    process.execPath,
    ["--import", "./test/helpers/stub-facilitator.mjs", "src/server.js"],
    {
      cwd: root,
      env: { ...process.env, PORT: "0", BASE_MAINNET_RPC_URL: "http://127.0.0.1:9", ...env },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
}

test("server refuses to start without a valid PAY_TO_ADDRESS", () => {
  for (const bad of ["", "0x123", "not-an-address"]) {
    const r = boot({ PAY_TO_ADDRESS: bad });
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /PAY_TO_ADDRESS must be a valid EVM address/, bad);
  }
});

test("server refuses to start on a bad sampler interval", () => {
  const r = boot({
    PAY_TO_ADDRESS: "0x0D083590c048A243e24a75E3a7C968145DE25B44",
    HISTORY_SAMPLE_INTERVAL_MS: "5m",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HISTORY_SAMPLE_INTERVAL_MS must be an integer/);
});
