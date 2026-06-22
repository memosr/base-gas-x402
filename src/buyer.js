import "dotenv/config";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// --- Config ------------------------------------------------------------
// The buyer pays the live /gas endpoint over x402. Payment is settled on
// Base mainnet (eip155:8453 / chainId 8453), matching the server.
const DEFAULT_TARGET_URL =
  "https://base-gas-x402-production.up.railway.app/gas";
const TARGET_URL = process.env.TARGET_URL || DEFAULT_TARGET_URL;
const PAYMENT_NETWORK = "eip155:8453"; // Base mainnet

// The private key signs the EIP-712 payment authorization. It is read from
// the environment only and is NEVER logged, printed, or otherwise exposed.
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY;

/**
 * Normalizes a hex private key to the 0x-prefixed form viem expects.
 * Never logs the key itself.
 *
 * @param {string} key
 * @returns {`0x${string}`}
 */
function normalizePrivateKey(key) {
  const trimmed = key.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function extractErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  if (!BUYER_PRIVATE_KEY) {
    // Fail fast: without a signer we can't create a payment authorization.
    console.error(
      "[error] BUYER_PRIVATE_KEY is not set. Add it to .env (a funded Base mainnet key holding USDC) and re-run.",
    );
    process.exit(1);
  }

  // privateKeyToAccount throws on a malformed key; surface a clean message
  // without ever echoing the key value.
  let account;
  try {
    account = privateKeyToAccount(normalizePrivateKey(BUYER_PRIVATE_KEY));
  } catch {
    console.error(
      "[error] BUYER_PRIVATE_KEY is not a valid hex private key. Expected 32 bytes (64 hex chars, optional 0x prefix).",
    );
    process.exit(1);
  }

  console.log("=== x402 buyer ===");
  console.log(`  target:  ${TARGET_URL}`);
  console.log(`  network: ${PAYMENT_NETWORK} (Base mainnet, chainId ${base.id})`);
  // Only the public address is logged — never the private key.
  console.log(`  payer:   ${account.address}`);
  console.log("");

  // --- Step 1: probe without payment to see the 402 challenge ----------
  console.log("[1/2] GET without payment (expecting HTTP 402)...");
  const probe = await fetch(TARGET_URL);
  console.log(`      status: ${probe.status} ${probe.statusText}`);

  if (probe.status === 402) {
    const challenge = await probe.json().catch(() => null);
    if (challenge?.accepts?.length) {
      // accepts[] carries the payment requirements the server advertises.
      for (const req of challenge.accepts) {
        console.log(
          `      requires: ${req.price ?? req.maxAmountRequired ?? "?"} ` +
            `on ${req.network} -> payTo ${req.payTo}`,
        );
      }
    } else {
      console.log("      402 body:", JSON.stringify(challenge));
    }
  } else {
    console.log(
      "      (did not get a 402; continuing — the paid request will still work if payment is required)",
    );
  }
  console.log("");

  // --- Step 2: pay via x402 and read the gas data ----------------------
  // x402Client registers the EVM "exact" scheme for Base mainnet using the
  // viem account as the signer. wrapFetchWithPayment then transparently
  // answers any 402 by signing + retrying with an X-PAYMENT header.
  const client = new x402Client().register(
    PAYMENT_NETWORK,
    new ExactEvmScheme(account),
  );
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log("[2/2] GET with x402 payment ($0.001 USDC on Base mainnet)...");
  const response = await fetchWithPayment(TARGET_URL);
  console.log(`      status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`[error] paid request failed:\n${body}`);
    process.exit(1);
  }

  const data = await response.json();
  console.log("");
  console.log("=== Base mainnet gas data ===");
  console.log(JSON.stringify(data, null, 2));

  // --- Settlement details ----------------------------------------------
  // The X-PAYMENT-RESPONSE header carries the facilitator's settlement
  // receipt (tx hash, payer, settled amount) once payment clears on-chain.
  const settlementHeader = response.headers.get("x-payment-response");
  if (settlementHeader) {
    try {
      const settlement = decodePaymentResponseHeader(settlementHeader);
      console.log("");
      console.log("=== Payment settlement ===");
      console.log(`  success:     ${settlement.success}`);
      console.log(`  network:     ${settlement.network}`);
      if (settlement.payer) console.log(`  payer:       ${settlement.payer}`);
      if (settlement.amount)
        console.log(`  amount:      ${settlement.amount} (atomic USDC units)`);
      if (settlement.transaction)
        console.log(`  transaction: ${settlement.transaction}`);
    } catch (error) {
      console.log(
        `  (could not decode X-PAYMENT-RESPONSE: ${extractErrorMessage(error)})`,
      );
    }
  } else {
    console.log("");
    console.log("(no X-PAYMENT-RESPONSE header returned by the server)");
  }
}

main().catch((error) => {
  console.error("[fatal]", extractErrorMessage(error));
  process.exit(1);
});
