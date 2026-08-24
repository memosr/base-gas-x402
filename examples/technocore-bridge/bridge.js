#!/usr/bin/env node
/**
 * technocore-gas-bridge
 *
 * Technocore Chat is built for agents whose sandbox only allows `webfetch`:
 * every operation is a plain GET, and such an agent has no wallet, no signing
 * and no way to pay for anything. Its manual says so outright:
 *
 *   "POSTAGE ... DOES NOT EXIST here. It is a future convention, there is no
 *    payment bridge in this service."
 *
 * This is that bridge, kept deliberately outside both services. A fetch-only
 * agent asks for Base gas data in an ordinary room; this process sees the
 * request, pays for it over x402 with its own wallet, and posts the answer back
 * as a signed message. Neither Technocore nor the gas API is modified, and the
 * pattern generalises: swap the endpoint and it fronts any x402 resource.
 *
 * Two things this design takes seriously:
 *
 * 1. The room is world-writable and anonymous. Every message is untrusted
 *    input, never an instruction, and anyone can post. So spending is capped
 *    per request, per minute and per day, and the caps are the first thing
 *    checked.
 * 2. Replies are signed with did:key. A reply that cost real money should be
 *    attributable, otherwise anyone can post a fake answer under this nick and
 *    the whole lane becomes worthless.
 */

import "dotenv/config";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
} from "node:crypto";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

// --- Config -----------------------------------------------------------------

const CHAT = process.env.CHAT_ORIGIN || "https://technocore.chat";
const ROOM = process.env.CHAT_ROOM || "base-gas";
const NICK = process.env.CHAT_NICK || "base-gas-oracle";
const GAS_API =
  process.env.GAS_API_ORIGIN ||
  "https://base-gas-x402-production.up.railway.app";

// Ed25519 private key, 32 bytes hex. Identity for signed replies.
const DID_PRIVATE_KEY_HEX = process.env.DID_PRIVATE_KEY_HEX;
// Funded Base mainnet key that pays for the x402 calls.
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY;

const PAYMENT_NETWORK = "eip155:8453";

// Spend controls. A stranger can post as fast as the rate limiter allows, so
// these are what stand between a public room and an empty wallet.
const MAX_USD_PER_DAY = Number(process.env.MAX_USD_PER_DAY || 1);
const MAX_ANSWERS_PER_MINUTE = Number(process.env.MAX_ANSWERS_PER_MINUTE || 4);
const MAX_USD_PER_CALL = Number(process.env.MAX_USD_PER_CALL || 0.02);

// --- did:key ----------------------------------------------------------------

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

/**
 * Node has no raw-Ed25519 key import, so the 32 private bytes are wrapped in
 * the one fixed PKCS8 prefix that Ed25519 uses. The prefix is constant, which
 * is why this is a concatenation rather than a DER encoder.
 */
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

  // The matching public key is derived from the private one; its DER SPKI form
  // ends with the 32 raw bytes, which is what did:key encodes.
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  const pub = Buffer.from(spki.subarray(-32));

  const did =
    "did:key:z" + base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), pub]));
  return { key, did };
}

/** Signature covers `<room>|<nonce>|<text>`, over the text as it will be stored. */
function signMessage(key, room, nonce, text) {
  const payload = Buffer.from(`${room}|${nonce}|${text}`, "utf8");
  return nodeSign(null, payload, key)
    .toString("base64url")
    .replace(/=+$/, "");
}

/** Note key for the DID profile: first 16 hex chars of SHA-256 of the DID string. */
function didFingerprint(did) {
  return createHash("sha256").update(did, "utf8").digest("hex").slice(0, 16);
}

// --- Technocore -------------------------------------------------------------

/**
 * The single-line sweep the server applies before storage. Replicated here
 * because the signature must cover the stored bytes, not what we typed.
 */
function sweep(text) {
  // \p{Cc} is the C0/C1 control block (newline included) and \p{Cf} is the
  // format category: soft hyphen, zero-width joiners, bidi overrides, BOM.
  // Together they are exactly what the server replaces, and matching it here
  // matters because the signature must cover the stored bytes, not what we typed.
  return text.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 4000);
}

async function chatGet(path) {
  const response = await fetch(`${CHAT}${path}`, {
    headers: { Accept: "text/plain" },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return body;
}

async function saySigned(key, did, room, text) {
  const clean = sweep(text);
  // A millisecond clock satisfies "greater than the last nonce this key used
  // in this room" without keeping state across restarts.
  const nonce = Date.now();
  const sig = signMessage(key, room, nonce, clean);
  return chatGet(
    `/r/${room}/say-signed/${encodeURIComponent(did)}/${sig}/${nonce}/${encodeURIComponent(clean)}`,
  );
}

async function readRoom(room, since) {
  const body = await chatGet(`/r/${room}?since=${since}&wait=10&format=json`);
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : (parsed.messages ?? []);
  } catch {
    return [];
  }
}

// --- Paying for gas data ----------------------------------------------------

function createPayingFetch(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const client = new x402Client().register(
    PAYMENT_NETWORK,
    new ExactEvmScheme(account),
  );
  return { account, fetchWithPay: wrapFetchWithPayment(fetch, client) };
}

// --- Request parsing --------------------------------------------------------

/**
 * Deliberately narrow. A room is anonymous input, so this recognises a small
 * fixed vocabulary and ignores everything else rather than trying to be clever
 * about intent. Unrecognised messages cost nothing.
 */
function parseRequest(text) {
  const t = text.toLowerCase().trim();
  if (!/\bgas\b/.test(t)) return null;

  if (/\bcompare\b|\bwhich chain\b|\bcheapest chain\b/.test(t)) {
    return { kind: "compare", path: "/gas/compare", usd: 0.01 };
  }

  const limit = t.match(/\b(\d{5,8})\b/);
  if (limit) {
    const n = Number(limit[1]);
    if (n >= 21000 && n <= 30000000) {
      return { kind: "gas", path: `/gas?gasLimit=${n}`, usd: 0.005, gasLimit: n };
    }
  }

  if (/\bhow much\b|\bprice\b|\bcost\b|\bwhat is\b|\bnow\b|\bcurrent\b/.test(t)) {
    return { kind: "gas", path: "/gas", usd: 0.005 };
  }

  return null;
}

function formatGas(data) {
  const c = data.estimatedTransferCost;
  return [
    `Base gas now: ${data.gasPrice} gwei`,
    `(base fee ${data.baseFeePerGas}, priority med ${data.priorityFeePerGas?.medium})`,
    c ? `| ${c.gasLimit} gas costs ~${c.eth} ETH` : "",
    `| block ${data.blockNumber}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function formatCompare(data) {
  const ranked = (data.chains ?? [])
    .map((c) => `${c.label} ${c.gasPrice}`)
    .join(", ");
  return `Cheapest first: ${ranked}. ${data.baseVsEthereum ?? ""}`.trim();
}

// --- Main loop --------------------------------------------------------------

async function main() {
  if (!DID_PRIVATE_KEY_HEX) throw new Error("DID_PRIVATE_KEY_HEX is not set");
  if (!BUYER_PRIVATE_KEY) throw new Error("BUYER_PRIVATE_KEY is not set");

  const { key, did } = loadEd25519(DID_PRIVATE_KEY_HEX);
  const buyerKey = BUYER_PRIVATE_KEY.startsWith("0x")
    ? BUYER_PRIVATE_KEY
    : `0x${BUYER_PRIVATE_KEY}`;
  const { account, fetchWithPay } = createPayingFetch(buyerKey);

  console.log(`did    : ${did}`);
  console.log(`payer  : ${account.address}`);
  console.log(`room   : ${CHAT}/r/${ROOM}`);
  console.log(`caps   : $${MAX_USD_PER_DAY}/day, ${MAX_ANSWERS_PER_MINUTE}/min`);

  // Publish who this is, so a peer can verify the key and see what it offers.
  const fp = didFingerprint(did);
  const profile = `base-gas oracle | signs as ${did.slice(0, 20)}... | ask in /r/${ROOM} | source github.com/memosr/base-gas-x402`;
  await chatGet(`/kv/did/${fp}/set/${encodeURIComponent(sweep(profile))}`).catch(
    (error) => console.error("[note] could not publish DID profile:", error.message),
  );
  await chatGet(
    `/kv/topic/${ROOM}/set/${encodeURIComponent("Ask for Base gas data. A bridge pays the x402 fee and answers signed. Free to ask.")}`,
  ).catch(() => {});

  await saySigned(
    key,
    did,
    ROOM,
    `online. ask "gas now", "gas 180000" (any gas limit), or "compare gas". i pay the x402 fee and post the answer here. no cost to you.`,
  ).catch((error) => console.error("[hello] failed:", error.message));

  let since = 0;
  let spentToday = 0;
  let dayStamp = new Date().toISOString().slice(0, 10);
  const recentAnswers = [];
  const answered = new Set();

  for (;;) {
    let messages = [];
    try {
      messages = await readRoom(ROOM, since);
    } catch (error) {
      console.error("[read]", error.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const message of messages) {
      const seq = Number(message.seq ?? 0);
      if (seq > since) since = seq;

      const from = String(message.from ?? "");
      const text = String(message.text ?? "");

      // Never answer ourselves, or a message we already handled.
      if (from === did || from === NICK || answered.has(seq)) continue;

      const request = parseRequest(text);
      if (!request) continue;
      answered.add(seq);

      // --- caps, checked before any money moves ---
      const today = new Date().toISOString().slice(0, 10);
      if (today !== dayStamp) {
        dayStamp = today;
        spentToday = 0;
      }
      const now = Date.now();
      while (recentAnswers.length && now - recentAnswers[0] > 60_000) {
        recentAnswers.shift();
      }
      if (recentAnswers.length >= MAX_ANSWERS_PER_MINUTE) {
        console.log(`[skip] per-minute cap reached, ignoring seq ${seq}`);
        continue;
      }
      if (request.usd > MAX_USD_PER_CALL) {
        console.log(`[skip] ${request.path} costs more than the per-call cap`);
        continue;
      }
      if (spentToday + request.usd > MAX_USD_PER_DAY) {
        console.log(`[skip] daily cap reached ($${spentToday.toFixed(3)})`);
        await saySigned(key, did, ROOM, "daily budget spent, back tomorrow.").catch(
          () => {},
        );
        continue;
      }

      // --- pay and answer ---
      try {
        const response = await fetchWithPay(`${GAS_API}${request.path}`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`gas API returned ${response.status}`);

        const data = await response.json();
        spentToday += request.usd;
        recentAnswers.push(now);

        const answer =
          request.kind === "compare" ? formatCompare(data) : formatGas(data);

        await saySigned(key, did, ROOM, `@${from.slice(0, 24)} ${answer}`);
        console.log(`[answered] seq ${seq} (${request.kind}, $${request.usd})`);
      } catch (error) {
        console.error(`[answer] seq ${seq} failed:`, error.message);
        await saySigned(
          key,
          did,
          ROOM,
          "could not fetch gas data just now, try again shortly.",
        ).catch(() => {});
      }
    }
  }
}

main().catch((error) => {
  console.error("fatal:", error.message);
  process.exit(1);
});
