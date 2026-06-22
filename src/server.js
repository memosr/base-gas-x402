import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { getGasData } from "./gas.js";

const PORT = process.env.PORT || 4021;
const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS;
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

// Payment is verified and settled on Base mainnet (eip155:8453) through the
// Coinbase CDP production facilitator. The gas data itself also comes from
// Base mainnet (see gas.js).
const PAYMENT_NETWORK = "eip155:8453";
const GAS_PRICE = "$0.001";
const FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

if (!PAY_TO_ADDRESS) {
  // Fail fast: without a payTo address the facilitator can't settle payments.
  console.warn(
    "[warn] PAY_TO_ADDRESS is not set. /gas will reject payments until you set it in .env",
  );
}

if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  // The CDP mainnet facilitator requires signed requests.
  console.warn(
    "[warn] CDP_API_KEY_ID / CDP_API_KEY_SECRET are not set. The CDP facilitator will reject verify/settle calls until you set them in .env",
  );
}

const app = express();
app.use(express.json());

// --- x402 wiring --------------------------------------------------------
// The Coinbase CDP facilitator config carries the production facilitator URL
// (https://api.cdp.coinbase.com/platform/v2/x402) plus the createAuthHeaders
// callback that signs each verify/settle/supported/bazaar request with the
// CDP API key read from CDP_API_KEY_ID / CDP_API_KEY_SECRET. The
// HTTPFacilitatorClient then talks to that hosted facilitator.
const facilitator = new HTTPFacilitatorClient(
  createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET),
);

// The resource server registers the EVM "exact" scheme for Base mainnet, and
// paymentMiddleware gates the matching routes below.
const resourceServer = new x402ResourceServer(facilitator).register(
  PAYMENT_NETWORK,
  new ExactEvmScheme(),
);

// Output shape advertised to Bazaar crawlers so agents know what they'll get.
const GAS_OUTPUT_EXAMPLE = {
  chain: "base-mainnet",
  chainId: 8453,
  blockNumber: "12345678",
  baseFeePerGas: "0.012",
  priorityFeePerGas: { low: "0.001", medium: "0.002", high: "0.004" },
  gasPrice: "0.014",
  estimatedTransferCost: { gasLimit: 21000, gwei: "294", eth: "0.000000294" },
  fetchedAt: "2026-06-22T00:00:00.000Z",
};

const routes = {
  "GET /gas": {
    accepts: {
      scheme: "exact",
      network: PAYMENT_NETWORK,
      price: GAS_PRICE,
      payTo: PAY_TO_ADDRESS,
    },
    // --- Bazaar discovery metadata --------------------------------------
    // description + mimeType + serviceName + tags feed the x402 Bazaar index.
    // The presence of the `bazaar` discovery extension is what makes this
    // resource discoverable; tags act as the category/search keywords
    // (here: an "infrastructure" gas/fees service on Base).
    description:
      "Live Base mainnet gas data (base fee, low/medium/high priority tiers, and an ETH transfer cost estimate) read directly from the chain.",
    mimeType: "application/json",
    serviceName: "base-gas-x402",
    tags: ["gas", "base", "fees", "infrastructure"],
    extensions: declareDiscoveryExtension({
      method: "GET",
      output: { example: GAS_OUTPUT_EXAMPLE },
    }),
  },
};

// --- Free route ---------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    name: "base-gas-x402",
    description:
      "Pay-per-call API for live Base mainnet gas data, gated with x402.",
    endpoints: {
      "GET /": "This service description (free).",
      "GET /gas": `Live Base mainnet gas data. Costs ${GAS_PRICE} per call via x402 on Base mainnet (${PAYMENT_NETWORK}).`,
    },
    payment: {
      protocol: "x402",
      price: GAS_PRICE,
      network: PAYMENT_NETWORK,
      facilitator: FACILITATOR_URL,
    },
  });
});

// --- Paywall: applies only to the routes declared above -----------------
// This middleware runs BEFORE the /gas handler, so any request without a
// valid payment — including the empty requests a Bazaar crawler sends — gets
// a 402 with the payment requirements and discovery metadata, and no gas
// data is fetched.
app.use(paymentMiddleware(routes, resourceServer));

// --- Paid route ---------------------------------------------------------
app.get("/gas", async (_req, res) => {
  try {
    const data = await getGasData();
    res.json(data);
  } catch (error) {
    console.error("[/gas] failed to fetch gas data:", error);
    res.status(502).json({
      error: "Failed to fetch Base mainnet gas data",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(PORT, () => {
  console.log(`base-gas-x402 listening on http://localhost:${PORT}`);
  console.log(`  free:  GET /`);
  console.log(`  paid:  GET /gas  (${GAS_PRICE} via x402, ${PAYMENT_NETWORK})`);
});
