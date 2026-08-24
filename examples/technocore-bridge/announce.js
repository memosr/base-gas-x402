#!/usr/bin/env node
/**
 * Post a one-off signed message to a Technocore room, using the same did:key
 * the bridge answers with.
 *
 * The bridge itself only ever replies to gas questions, deliberately: a process
 * that will post arbitrary text on request is a process someone else can steer.
 * Announcements are a human decision, so they get their own entry point.
 *
 * Signing matters here. An unsigned post is attributed to `~<nick>`, which the
 * server marks as self-asserted and proves nothing. If the point of the message
 * is "this DID did this work", an unsigned message does not make that claim at
 * all: anyone could have typed it.
 *
 *   node announce.js <room> "<text>"
 *   node announce.js meta "x402 bridge live in /r/base-gas ..."
 */

import "dotenv/config";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
} from "node:crypto";

const CHAT = process.env.CHAT_ORIGIN || "https://technocore.chat";
const DID_PRIVATE_KEY_HEX = process.env.DID_PRIVATE_KEY_HEX;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58btc(bytes) {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    const r = n % 58n;
    n /= 58n;
    out = B58[Number(r)] + out;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function loadEd25519(hex) {
  const raw = Buffer.from(hex.trim().replace(/^0x/, ""), "hex");
  if (raw.length !== 32) {
    throw new Error(`DID_PRIVATE_KEY_HEX must be 32 bytes, got ${raw.length}`);
  }
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    raw,
  ]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const pub = Buffer.from(spki.subarray(-32));
  const did =
    "did:key:z" + base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), pub]));
  return { key, did };
}

const sweep = (text) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 4000);

async function chatGet(path) {
  const response = await fetch(`${CHAT}${path}`, {
    headers: { Accept: "text/plain" },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status}: ${body.slice(0, 300)}`);
  }
  return body;
}

const [room, text] = process.argv.slice(2);

if (!room || !text) {
  console.error('usage: node announce.js <room> "<text>"');
  process.exit(1);
}
if (!DID_PRIVATE_KEY_HEX) {
  console.error("DID_PRIVATE_KEY_HEX is not set (is .env present?)");
  process.exit(1);
}

const { key, did } = loadEd25519(DID_PRIVATE_KEY_HEX);
const clean = sweep(text);

/**
 * Technocore is explicitly ephemeral infrastructure and does go down: a 503 is
 * a normal state, not an error to hand back to the operator as a stack trace.
 * Waiting here is better than making a human re-run the command every minute.
 *
 * The nonce and signature are recomputed per attempt because the signature
 * covers the nonce, and a nonce that ages out could collide with one this key
 * already used in this room.
 */
async function postWithRetry({ attempts = 60, waitMs = 30_000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const nonce = Date.now();
    const sig = nodeSign(
      null,
      Buffer.from(`${room}|${nonce}|${clean}`, "utf8"),
      key,
    )
      .toString("base64url")
      .replace(/=+$/, "");

    try {
      return await chatGet(
        `/r/${room}/say-signed/${encodeURIComponent(did)}/${sig}/${nonce}/${encodeURIComponent(clean)}`,
      );
    } catch (error) {
      const transient = /^(429|5\d\d):/.test(error.message);
      if (!transient || attempt === attempts) throw error;

      const minutes = ((attempts - attempt) * waitMs) / 60_000;
      console.log(
        `attempt ${attempt}: ${error.message.split(":")[0]}, retrying in ${waitMs / 1000}s (giving up in ~${Math.round(minutes)}m)`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error("unreachable");
}

const response = await postWithRetry();

// The seq is the citable pointer: "this DID said this, here". Without it there
// is nothing to link to, and the whole point of signing was to be citable.
const seq = response.match(/^\[(\d+)\]/m)?.[1] ?? "?";

console.log("");
console.log(`posted signed to /r/${room}`);
console.log(`  did : ${did}`);
console.log(`  seq : ${seq}`);
console.log(`  link: ${CHAT}/humans#r/${room}/${seq}`);
console.log(`  fingerprint (DID note key): ${createHash("sha256").update(did, "utf8").digest("hex").slice(0, 16)}`);
