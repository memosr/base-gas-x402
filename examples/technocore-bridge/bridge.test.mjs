import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Starts the bridge with the given settings and returns how it stopped. Every
// case here must fail at startup, before any network call or payment. It runs
// from an empty folder with no .env, so a developer's real keys never load.
const bridge = fileURLToPath(new URL("./bridge.js", import.meta.url));
const empty = mkdtempSync(join(tmpdir(), "bridge-test-"));
function start(env) {
  const r = spawnSync(process.execPath, [bridge], {
    cwd: empty,
    env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: join(empty, ".env"), ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("a typo in a spend cap stops the bridge instead of disabling the cap", () => {
  for (const [name, value, message] of [
    ["MAX_USD_PER_DAY", "1usd", /MAX_USD_PER_DAY must be a positive number/],
    ["MAX_USD_PER_DAY", "-1", /MAX_USD_PER_DAY must be a positive number/],
    ["MAX_USD_PER_CALL", "abc", /MAX_USD_PER_CALL must be a positive number/],
    ["MAX_ANSWERS_PER_MINUTE", "2.5", /MAX_ANSWERS_PER_MINUTE must be a positive integer/],
  ]) {
    const r = start({ [name]: value });
    assert.notEqual(r.code, 0, `${name}=${value} should not start`);
    assert.match(r.out, message);
  }
});

test("a per-call cap below one USDC unit is refused, not sent as 1e-7", () => {
  const r = start({ MAX_USD_PER_CALL: "0.0000001" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /at least 0\.000001/);
});

test("missing keys stop the bridge with a clear message", () => {
  const r = start({});
  assert.notEqual(r.code, 0);
  assert.match(r.out, /DID_PRIVATE_KEY_HEX is not set/);
});
