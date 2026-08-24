#!/usr/bin/env node
/**
 * One-shot key setup.
 *
 * Generates the two keys the bridge needs and writes them into .env, rather
 * than printing them for a human to copy. Copying a 64-character hex by hand is
 * the step people actually get wrong, and a truncated key fails much later with
 * an error that points somewhere else entirely.
 *
 * Existing values are never overwritten: re-running this is safe, and it fills
 * in only what is missing.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const ENV_PATH = new URL(".env", import.meta.url).pathname;

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

function didFromPrivate(privateKeyObject) {
  const spki = createPublicKey(privateKeyObject).export({
    format: "der",
    type: "spki",
  });
  const pub = Buffer.from(spki.subarray(-32));
  return "did:key:z" + base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), pub]));
}

if (!existsSync(ENV_PATH)) {
  console.error("No .env found. Run: cp .env.example .env");
  process.exit(1);
}

let env = readFileSync(ENV_PATH, "utf8");

/** Replaces `KEY=` with `KEY=value`, only when the value is currently empty. */
function fill(key, value) {
  const pattern = new RegExp(`^${key}=\\s*$`, "m");
  if (!pattern.test(env)) return false;
  env = env.replace(pattern, `${key}=${value}`);
  return true;
}

// --- DID key ---
const { privateKey } = generateKeyPairSync("ed25519");
const didHex = privateKey
  .export({ format: "der", type: "pkcs8" })
  .subarray(-32)
  .toString("hex");
const did = didFromPrivate(privateKey);

const wroteDid = fill("DID_PRIVATE_KEY_HEX", didHex);

// --- Buyer wallet ---
const buyerHex = "0x" + randomBytes(32).toString("hex");
const buyerAddress = privateKeyToAccount(buyerHex).address;

const wroteBuyer = fill("BUYER_PRIVATE_KEY", buyerHex);

writeFileSync(ENV_PATH, env);
// The file now holds two private keys, so stop it being world-readable.
chmodSync(ENV_PATH, 0o600);

console.log("");
if (wroteDid) {
  console.log(`DID key   : generated`);
  console.log(`  ${did}`);
} else {
  console.log("DID key   : already set in .env, left alone");
}

if (wroteBuyer) {
  console.log(`Buyer key : generated`);
  console.log(`  address ${buyerAddress}`);
  console.log("");
  console.log("  Fund this address with a small amount of USDC on Base");
  console.log("  ($1 to $2 is plenty). Anyone in the room can trigger a paid");
  console.log("  call, so treat it as spending money, not savings.");
} else {
  console.log("Buyer key : already set in .env, left alone");
}

console.log("");
console.log(".env is now chmod 600. It is gitignored; never commit it.");
console.log("Next: npm start");
