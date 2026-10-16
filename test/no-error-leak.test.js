import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// viem puts the full RPC URL in error.message, and that URL can carry a
// provider API key in its path (Alchemy, QuickNode, Infura). A 502 is not
// charged, so echoing error.message to the client would hand the key to anyone
// who calls while the RPC is failing. Errors go to the server log only.
test("server.js never sends error.message to a client", () => {
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /detail:\s*error/);
  for (const block of src.match(/res\.status\(\d+\)\.json\(\{[\s\S]*?\}\)/g) ?? []) {
    assert.doesNotMatch(block, /error\.message|String\(error\)/, block);
  }
});
