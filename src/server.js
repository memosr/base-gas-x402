import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  BUILDER_CODE,
  declareBuilderCodeExtension,
} from "@x402/extensions/builder-code";

import { getGasData, MIN_GAS_LIMIT, MAX_GAS_LIMIT } from "./gas.js";
import { getGasComparison } from "./compare.js";
import {
  startSampler,
  coverage,
  getHistory,
  getCheapestWindow,
} from "./history.js";

// Common gas limits, surfaced in the discovery docs so agents know what to pass.
const GAS_LIMIT_PRESETS = {
  "ETH transfer": 21000,
  "ERC-20 transfer": 65000,
  "NFT mint": 85000,
  "Uniswap swap": 180000,
  "contract deploy": 1500000,
};

const PORT = process.env.PORT || 4021;
const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS;
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

// Payment is verified and settled on Base mainnet (eip155:8453) through the
// Coinbase CDP production facilitator. The gas data itself also comes from
// Base mainnet (see gas.js).
const PAYMENT_NETWORK = "eip155:8453";
const FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

// Price per /gas call, in USD. Overridable via GAS_PRICE_USD so pricing can be
// tuned from the host env without a code change. Comparable Base gas endpoints
// on x402 sit between $0.01 and $0.10, so $0.005 still undercuts the market.
const GAS_PRICE_USD = process.env.GAS_PRICE_USD || "0.005";

if (!/^\d+(\.\d+)?$/.test(GAS_PRICE_USD) || Number(GAS_PRICE_USD) <= 0) {
  throw new Error(
    `GAS_PRICE_USD must be a positive decimal number, got "${GAS_PRICE_USD}"`,
  );
}

// Price per /gas/compare call. Higher than /gas because it reads four chains.
const COMPARE_PRICE_USD = process.env.COMPARE_PRICE_USD || "0.01";

if (!/^\d+(\.\d+)?$/.test(COMPARE_PRICE_USD) || Number(COMPARE_PRICE_USD) <= 0) {
  throw new Error(
    `COMPARE_PRICE_USD must be a positive decimal number, got "${COMPARE_PRICE_USD}"`,
  );
}

// Price per /gas/history call. Higher than /gas because the value comes from
// data collected over time, not from a single RPC read anyone can do for free.
const HISTORY_PRICE_USD = process.env.HISTORY_PRICE_USD || "0.01";

// Price per /gas/cheapest-window call. The most derived answer on the service:
// it turns raw history into a scheduling decision.
const WINDOW_PRICE_USD = process.env.WINDOW_PRICE_USD || "0.02";

for (const [name, value] of [
  ["HISTORY_PRICE_USD", HISTORY_PRICE_USD],
  ["WINDOW_PRICE_USD", WINDOW_PRICE_USD],
]) {
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive decimal number, got "${value}"`);
  }
}

// Display form ("$0.005") for the x402 accepts block and the landing page.
const GAS_PRICE = `$${GAS_PRICE_USD}`;
const COMPARE_PRICE = `$${COMPARE_PRICE_USD}`;
const HISTORY_PRICE = `$${HISTORY_PRICE_USD}`;
const WINDOW_PRICE = `$${WINDOW_PRICE_USD}`;
// OpenAPI x-payment-info wants decimal USD with fixed precision.
const GAS_PRICE_AMOUNT = Number(GAS_PRICE_USD).toFixed(6);
const COMPARE_PRICE_AMOUNT = Number(COMPARE_PRICE_USD).toFixed(6);
const HISTORY_PRICE_AMOUNT = Number(HISTORY_PRICE_USD).toFixed(6);
const WINDOW_PRICE_AMOUNT = Number(WINDOW_PRICE_USD).toFixed(6);

// Bounds for the shared `hours` lookback parameter.
const MIN_HOURS = 1;
const MAX_HOURS = Number(process.env.HISTORY_RETENTION_HOURS || 168);

// Base Builder Code attribution (ERC-8021 Schema 2 "a" / app code). Advertised
// in the /gas 402 PAYMENT-REQUIRED extensions so settlement calldata can be
// attributed to this service. Override via BUILDER_CODE env if needed.
const BUILDER_CODE_VALUE = process.env.BUILDER_CODE || "bc_lhfd8zad";

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

// Railway (like most PaaS edges) terminates TLS and forwards the request to
// this process over plain HTTP. Without this, req.protocol is "http", so the
// x402 middleware advertises the resource as http://... in the 402 challenge.
// The Bazaar discovery registrar rejects that outright:
//   "discovery request validation failed: resource must start with 'https://'
//    when protocol type is http"
// which silently blocks the hourly discovery registration and leaves the
// service stale in x402scan and every index downstream of it.
// Trusting the proxy makes Express read X-Forwarded-Proto, so req.protocol
// becomes "https" and the advertised resource URL matches reality.
app.set("trust proxy", true);
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

const COMPARE_OUTPUT_EXAMPLE = {
  gasLimit: 21000,
  basis: "current gas price x gasLimit",
  chains: [
    {
      chain: "base",
      label: "Base",
      chainId: 8453,
      blockNumber: "49106604",
      baseFeePerGas: "0.005",
      gasPrice: "0.006",
      estimatedCost: { gasLimit: 21000, gwei: "126", eth: "0.000000126" },
    },
  ],
  cheapest: "base",
  baseRank: 1,
  baseVsEthereum: "Base is 240.5x cheaper than Ethereum",
  unavailable: [],
  fetchedAt: "2026-07-25T18:02:36.639Z",
};

// Kept deliberately small: this example is embedded in the 402 challenge and
// echoed back inside the payment payload, which the facilitator size-limits.
const HISTORY_OUTPUT_EXAMPLE = {
  requestedHours: 24,
  units: "gwei",
  currentGasPrice: 0.006,
  verdict: "cheap",
  summary: { min: 0.005, max: 0.031, avg: 0.009, median: 0.007 },
  samples: [{ t: "2026-07-26T06:00:00.000Z", gasPrice: 0.006 }],
};

const WINDOW_OUTPUT_EXAMPLE = {
  chain: "base-mainnet",
  chainId: 8453,
  requestedHours: 168,
  units: "gwei",
  hourlyAverages: [
    { hourUtc: 6, samples: 84, avgGasPrice: 0.005 },
    { hourUtc: 14, samples: 84, avgGasPrice: 0.019 },
  ],
  cheapestHourUtc: 6,
  priciestHourUtc: 14,
  savingsPercent: 73.7,
  hoursObserved: 24,
  coverage: { samples: 2016, hoursCovered: 168, retentionHours: 168 },
  fetchedAt: "2026-07-26T06:08:54.972Z",
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
      "Live Base mainnet (Base L2, Coinbase Base) gas prices read directly from the chain: EIP-1559 base fee per gas, low/medium/high priority fee tiers in gwei, current gas price, and an estimated ETH transfer cost. Use it to check gas fees before sending a transaction on Base, estimate transaction cost, budget agent spending, find cheap windows to transact, monitor network congestion, or compare Base L2 fees to other chains.",
    mimeType: "application/json",
    serviceName: "base-gas-x402",
    tags: [
      "gas",
      "gas price",
      "gas oracle",
      "base",
      "base-l2",
      "coinbase-base",
      "base mainnet",
      "fees",
      "l2 fees",
      "eip-1559",
      "base fee",
      "priority fee",
      "gwei",
      "transaction cost",
      "onchain-data",
      "infrastructure",
    ],
    // Bazaar discovery extension (preserved) + Base Builder Code attribution.
    extensions: {
      ...declareDiscoveryExtension({
        method: "GET",
        // Optional query input. Declaring it is what clears the
        // L3_INPUT_SCHEMA_MISSING discovery warning and lets agents invoke the
        // route reliably instead of guessing.
        input: { gasLimit: 21000 },
        inputSchema: {
          properties: {
            gasLimit: {
              type: "integer",
              minimum: Number(MIN_GAS_LIMIT),
              maximum: Number(MAX_GAS_LIMIT),
              default: 21000,
              description:
                "Gas units to price the cost estimate against. Defaults to 21000 (a plain ETH transfer). Use ~65000 for an ERC-20 transfer, ~85000 for an NFT mint, ~180000 for a Uniswap swap, or ~1500000 for a contract deploy.",
            },
          },
          required: [],
        },
        output: { example: GAS_OUTPUT_EXAMPLE },
      }),
      [BUILDER_CODE]: declareBuilderCodeExtension(BUILDER_CODE_VALUE),
    },
  },

  "GET /gas/compare": {
    accepts: {
      scheme: "exact",
      network: PAYMENT_NETWORK,
      price: COMPARE_PRICE,
      payTo: PAY_TO_ADDRESS,
    },
    description:
      "Compares live gas costs across Base, OP Mainnet, Arbitrum One, and Ethereum in a single call, ranked cheapest first. Returns each chain's base fee, gas price, and estimated cost for a given gas limit, plus which chain is cheapest right now and how many times cheaper Base is than Ethereum. Use it to pick the cheapest chain for a transaction, decide whether to bridge, compare L2 fees, or route agent transactions to the lowest-cost network.",
    mimeType: "application/json",
    serviceName: "base-gas-x402",
    tags: [
      "gas",
      "gas comparison",
      "compare chains",
      "cross-chain",
      "multi-chain",
      "l2 fees",
      "base",
      "optimism",
      "arbitrum",
      "ethereum",
      "cheapest chain",
      "transaction cost",
      "bridge decision",
      "onchain-data",
    ],
    extensions: {
      ...declareDiscoveryExtension({
        method: "GET",
        input: { gasLimit: 21000 },
        inputSchema: {
          properties: {
            gasLimit: {
              type: "integer",
              minimum: Number(MIN_GAS_LIMIT),
              maximum: Number(MAX_GAS_LIMIT),
              default: 21000,
              description:
                "Gas units to price each chain against. Defaults to 21000 (a plain ETH transfer).",
            },
          },
          required: [],
        },
        output: { example: COMPARE_OUTPUT_EXAMPLE },
      }),
      [BUILDER_CODE]: declareBuilderCodeExtension(BUILDER_CODE_VALUE),
    },
  },

  "GET /gas/history": {
    accepts: {
      scheme: "exact",
      network: PAYMENT_NETWORK,
      price: HISTORY_PRICE,
      payTo: PAY_TO_ADDRESS,
    },
    // NOTE: this bazaar description is echoed verbatim into the x402 payment
    // payload, and the CDP facilitator rejects payloads past a size threshold
    // ("'paymentPayload' is invalid"). Measured: a 4260-byte payload is
    // rejected, 4188 is accepted. Keep this short. The long, keyword-rich copy
    // that actually drives discovery lives in the OpenAPI document, which is
    // not part of the payment payload.
    description:
      "Historical Base mainnet gas prices over a lookback window: time series, min/max/average/median, and a cheap/normal/expensive verdict for the current price.",
    mimeType: "application/json",
    serviceName: "base-gas-x402",
    tags: ["gas history", "gas trend", "base", "base-l2", "onchain-data"],
    extensions: {
      ...declareDiscoveryExtension({
        method: "GET",
        input: { hours: 24 },
        inputSchema: {
          properties: {
            hours: {
              type: "integer",
              minimum: MIN_HOURS,
              maximum: MAX_HOURS,
              default: 24,
              description:
                "Lookback window in hours. Defaults to 24. Check the free GET /health route first to see how much history has been collected.",
            },
          },
          required: [],
        },
        output: { example: HISTORY_OUTPUT_EXAMPLE },
      }),
      [BUILDER_CODE]: declareBuilderCodeExtension(BUILDER_CODE_VALUE),
    },
  },

  "GET /gas/cheapest-window": {
    accepts: {
      scheme: "exact",
      network: PAYMENT_NETWORK,
      price: WINDOW_PRICE,
      payTo: PAY_TO_ADDRESS,
    },
    description:
      "Identifies the cheapest hours of day to transact on Base, computed from continuously collected gas history. Returns average gas price bucketed by hour of day in UTC, ranked cheapest first, plus the cheapest hour, the priciest hour, and the percentage saved by waiting for the cheap window. Use it to schedule batch transactions, time an airdrop or mint, plan agent workloads around cheap gas, or answer when should I send this transaction.",
    mimeType: "application/json",
    serviceName: "base-gas-x402",
    tags: [
      "cheapest time to transact",
      "gas timing",
      "gas schedule",
      "best time to send transaction",
      "gas savings",
      "hourly gas",
      "base",
      "base-l2",
      "batch transactions",
      "onchain-data",
    ],
    extensions: {
      ...declareDiscoveryExtension({
        method: "GET",
        input: { hours: 168 },
        inputSchema: {
          properties: {
            hours: {
              type: "integer",
              minimum: MIN_HOURS,
              maximum: MAX_HOURS,
              default: 168,
              description:
                "Lookback window in hours used to compute hourly averages. Defaults to 168 (7 days). Check the free GET /health route first to see how much history has been collected.",
            },
          },
          required: [],
        },
        output: { example: WINDOW_OUTPUT_EXAMPLE },
      }),
      [BUILDER_CODE]: declareBuilderCodeExtension(BUILDER_CODE_VALUE),
    },
  },
};

// --- Free routes --------------------------------------------------------
// GET / serves a small dark-themed HTML landing page. The service metadata
// that used to live here (for JSON clients) now lives at GET /info below.
const LANDING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="talentapp:project_verification" content="c305bf15e9cb197df5136336c90c58273e8bb0e372e5c4a821d40e2a96ed2d7f843902f75c5ffcc0c4b3243fe26cab9d77ebe957d5487389e09e6c8804356292">
<meta name="base:app_id" content="6a39a0374c49dc5fd7753e72" />
<title>base-gas-x402</title>
<style>
  :root {
    --bg: #0b0e14;
    --surface: #141925;
    --border: #232a3a;
    --text: #e6e9ef;
    --muted: #9aa3b2;
    --accent: #5b8cff;
    --code-bg: #0d1018;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 3rem 1.25rem 4rem;
  }
  h1 {
    margin: 0 0 .5rem;
    font-size: clamp(1.9rem, 1.2rem + 3vw, 2.6rem);
    letter-spacing: -0.02em;
  }
  .lead {
    color: var(--muted);
    font-size: 1.05rem;
    margin: 0 0 .75rem;
  }
  .lead a { color: var(--accent); }
  .price {
    display: inline-block;
    margin-bottom: 2rem;
    padding: .2rem .6rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: .85rem;
    color: var(--accent);
    background: var(--surface);
  }
  h2 {
    font-size: 1.1rem;
    margin: 2rem 0 .75rem;
    letter-spacing: -0.01em;
  }
  ol { padding-left: 1.2rem; margin: 0; color: var(--muted); }
  ol li { margin: .25rem 0; }
  ol code { color: var(--text); }
  pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem;
    overflow-x: auto;
    margin: .5rem 0 0;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: .9em;
  }
  pre code { color: #b9c7ff; }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: .75rem;
    margin-top: 1rem;
  }
  .links a {
    color: var(--text);
    text-decoration: none;
    padding: .55rem .9rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    transition: border-color .15s ease, color .15s ease;
  }
  .links a:hover { border-color: var(--accent); color: var(--accent); }
  footer {
    margin-top: 3rem;
    color: var(--muted);
    font-size: .85rem;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
  }
  footer code { color: var(--text); }
</style>
</head>
<body>
<main>
  <h1>base-gas-x402</h1>
  <p class="lead">
    A pay-per-call, live Base mainnet gas API gated with
    <a href="https://x402.org">x402</a>.
    Each call costs ${GAS_PRICE} USDC, settled on Base mainnet (${PAYMENT_NETWORK}).
  </p>
  <span class="price">${GAS_PRICE} USDC / call &middot; ${PAYMENT_NETWORK}</span>

  <h2>How it works</h2>
  <ol>
    <li>Request <code>GET /gas</code></li>
    <li>Server replies <code>402 Payment Required</code> with payment details</li>
    <li>Pay ${GAS_PRICE} USDC over x402</li>
    <li>Retry and receive the live gas JSON</li>
  </ol>

  <h2>Try it (no payment, see the 402)</h2>
  <pre><code>curl -i https://base-gas-x402-production.up.railway.app/gas</code></pre>

  <h2>Links</h2>
  <div class="links">
    <a href="https://github.com/memosr/base-gas-x402">API repo</a>
    <a href="https://github.com/memosr/base-gas-mcp">MCP repo</a>
  </div>

  <footer>
    Machine-readable service info: <code>GET /info</code>
  </footer>
</main>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.type("html").send(LANDING_PAGE_HTML);
});

// --- Favicon ------------------------------------------------------------
// Directories and agent clients render an origin's favicon next to its listing.
// Serving one clears the FAVICON_MISSING discovery warning.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0b0e14"/>
  <circle cx="32" cy="32" r="18" fill="none" stroke="#5b8cff" stroke-width="4"/>
  <path d="M32 20 L32 32 L41 38" fill="none" stroke="#5b8cff" stroke-width="4" stroke-linecap="round"/>
</svg>`;

app.get(["/favicon.svg", "/favicon.ico"], (_req, res) => {
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400");
  res.send(FAVICON_SVG);
});

// --- OpenAPI 3.1 discovery document --------------------------------------
// Served free at GET /openapi.json so agents and directories (e.g. x402scan)
// can machine-read what this service offers and how it's priced. This mirrors
// the runtime 402 contract (Base mainnet eip155:8453, USDC via x402)
// but is purely descriptive — it does not affect the paywall below.
const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "base-gas-x402",
    version: "1.0.0",
    description:
      `Pay-per-call gas oracle for Base mainnet (Base L2, Coinbase Base, chain id 8453), gated with the x402 payment protocol. Returns EIP-1559 base fee, low/medium/high priority fee tiers, current gas price in gwei, and an estimated transaction cost, all read live from the chain. No API keys and no subscription: agents pay ${GAS_PRICE_USD} USDC per call over x402.`,
    "x-guidance":
      `Call GET /gas to fetch live Base mainnet gas data. All parameters are optional. Each call costs ${GAS_PRICE_USD} USDC, settled on Base mainnet (eip155:8453) via x402. Use it to check gas fees before sending a transaction on Base, estimate transaction cost, budget agent gas spending, monitor Base L2 network congestion, or compare Base fees against other chains. Fees are returned in gwei. Pass the optional gasLimit query parameter to price a specific operation: 21000 for a plain ETH transfer (the default), ~65000 for an ERC-20 transfer, ~85000 for an NFT mint, ~180000 for a Uniswap swap, ~1500000 for a contract deploy. estimatedTransferCost is priced at base fee plus the medium priority tier.`,
    contact: { email: "mehmet.sr35@gmail.com" },
  },
  servers: [{ url: "https://base-gas-x402-production.up.railway.app" }],
  paths: {
    "/gas": {
      get: {
        summary:
          "Live Base mainnet gas price: base fee, priority fee tiers, and transfer cost estimate (paid via x402)",
        description:
          `Returns live Base mainnet (Base L2, Coinbase Base) gas data read directly from the chain: EIP-1559 base fee per gas, low/medium/high priority fee tiers, current gas price in gwei, and an estimated transaction cost for any gas limit. Common uses: check current gas fees on Base, get the Base network gas price before sending a transaction, estimate transaction cost on Base mainnet, price a Uniswap swap or NFT mint on Base, find a cheap time to transact on Base L2, monitor Base network congestion, budget gas spending for an on-chain agent, and compare Base gas costs to other L2 networks. Each call costs ${GAS_PRICE_USD} USDC settled on Base mainnet (eip155:8453) via x402. No API key or subscription required.`,
        operationId: "getGas",
        parameters: [
          {
            name: "gasLimit",
            in: "query",
            required: false,
            description:
              "Gas units to price the cost estimate against. Defaults to 21000 (a plain ETH transfer). Use ~65000 for an ERC-20 transfer, ~85000 for an NFT mint, ~180000 for a Uniswap swap, or ~1500000 for a contract deploy.",
            schema: {
              type: "integer",
              minimum: Number(MIN_GAS_LIMIT),
              maximum: Number(MAX_GAS_LIMIT),
              default: 21000,
              example: 180000,
            },
          },
        ],
        "x-payment-info": {
          price: { mode: "fixed", currency: "USD", amount: GAS_PRICE_AMOUNT },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: {
            description: "Live Base mainnet gas data (payment accepted).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    chain: { type: "string", example: "base-mainnet" },
                    chainId: { type: "integer", example: 8453 },
                    blockNumber: { type: "string", example: "12345678" },
                    baseFeePerGas: {
                      type: "string",
                      description: "Base fee per gas, in gwei.",
                      example: "0.012",
                    },
                    priorityFeePerGas: {
                      type: "object",
                      description: "Priority fee tiers, in gwei.",
                      properties: {
                        low: { type: "string", example: "0.001" },
                        medium: { type: "string", example: "0.002" },
                        high: { type: "string", example: "0.004" },
                      },
                    },
                    gasPrice: {
                      type: "string",
                      description: "Network gas price, in gwei.",
                      example: "0.014",
                    },
                    estimatedTransferCost: {
                      type: "object",
                      description: "Estimated cost of a plain ETH transfer.",
                      properties: {
                        gasLimit: { type: "integer", example: 21000 },
                        gwei: { type: "string", example: "294" },
                        eth: { type: "string", example: "0.000000294" },
                      },
                    },
                    fetchedAt: {
                      type: "string",
                      format: "date-time",
                      example: "2026-06-22T00:00:00.000Z",
                    },
                  },
                },
              },
            },
          },
          402: { description: "Payment Required" },
        },
      },
    },
    "/gas/compare": {
      get: {
        summary:
          "Compare live gas costs across Base, OP Mainnet, Arbitrum, and Ethereum (paid via x402)",
        description:
          `Compares live gas costs across Base, OP Mainnet, Arbitrum One, and Ethereum in a single call, ranked cheapest first. Returns each chain's EIP-1559 base fee, current gas price in gwei, and estimated cost for a given gas limit, plus which chain is cheapest right now and how many times cheaper Base is than Ethereum. Common uses: pick the cheapest chain for a transaction, decide whether bridging to Base is worth it, compare L2 fees across networks, route agent transactions to the lowest-cost chain, and monitor relative congestion between L2s. Chains that fail to respond are listed under "unavailable" rather than failing the whole request. Each call costs ${COMPARE_PRICE_USD} USDC settled on Base mainnet (eip155:8453) via x402.`,
        operationId: "compareGas",
        parameters: [
          {
            name: "gasLimit",
            in: "query",
            required: false,
            description:
              "Gas units to price each chain against. Defaults to 21000 (a plain ETH transfer).",
            schema: {
              type: "integer",
              minimum: Number(MIN_GAS_LIMIT),
              maximum: Number(MAX_GAS_LIMIT),
              default: 21000,
              example: 180000,
            },
          },
        ],
        "x-payment-info": {
          price: {
            mode: "fixed",
            currency: "USD",
            amount: COMPARE_PRICE_AMOUNT,
          },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: {
            description: "Multi-chain gas comparison (payment accepted).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    gasLimit: { type: "integer", example: 21000 },
                    basis: {
                      type: "string",
                      example: "current gas price x gasLimit",
                    },
                    chains: {
                      type: "array",
                      description: "Per-chain gas data, cheapest first.",
                      items: {
                        type: "object",
                        properties: {
                          chain: { type: "string", example: "base" },
                          label: { type: "string", example: "Base" },
                          chainId: { type: "integer", example: 8453 },
                          blockNumber: { type: "string", example: "49106604" },
                          baseFeePerGas: { type: "string", example: "0.005" },
                          gasPrice: { type: "string", example: "0.006" },
                          estimatedCost: {
                            type: "object",
                            properties: {
                              gasLimit: { type: "integer", example: 21000 },
                              gwei: { type: "string", example: "126" },
                              eth: {
                                type: "string",
                                example: "0.000000126",
                              },
                            },
                          },
                        },
                      },
                    },
                    cheapest: {
                      type: "string",
                      description: "Key of the cheapest chain.",
                      example: "base",
                    },
                    baseRank: {
                      type: "integer",
                      description: "Base's position in the ranking, 1 = cheapest.",
                      example: 1,
                    },
                    baseVsEthereum: {
                      type: "string",
                      example: "Base is 240.5x cheaper than Ethereum",
                    },
                    unavailable: {
                      type: "array",
                      description: "Chains whose RPC did not respond.",
                      items: {
                        type: "object",
                        properties: {
                          chain: { type: "string" },
                          reason: { type: "string" },
                        },
                      },
                    },
                    fetchedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          402: { description: "Payment Required" },
        },
      },
    },
    "/gas/history": {
      get: {
        summary:
          "Historical Base gas prices with trend statistics and a cheap/normal/expensive verdict (paid via x402)",
        description:
          `Returns historical Base mainnet gas prices over a lookback window, sampled continuously from the chain, together with min, max, average, and median gas price for that window and a verdict on whether gas is currently cheap, normal, or expensive relative to it. A live RPC call reports the current price but cannot say whether it is high or low; this endpoint can, because it has been watching. Common uses: decide whether to transact now or wait, detect congestion spikes on Base, chart Base gas trends over time, set gas budgets from real observed data, and backtest agent transaction timing. Every response includes a coverage object stating exactly how much history backs it. Check the free GET /health route first to see current coverage. Each call costs ${HISTORY_PRICE_USD} USDC settled on Base mainnet (eip155:8453) via x402.`,
        operationId: "getGasHistory",
        parameters: [
          {
            name: "hours",
            in: "query",
            required: false,
            description:
              "Lookback window in hours. Defaults to 24.",
            schema: {
              type: "integer",
              minimum: MIN_HOURS,
              maximum: MAX_HOURS,
              default: 24,
              example: 24,
            },
          },
        ],
        "x-payment-info": {
          price: {
            mode: "fixed",
            currency: "USD",
            amount: HISTORY_PRICE_AMOUNT,
          },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: {
            description: "Gas history for the window (payment accepted).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    chain: { type: "string", example: "base-mainnet" },
                    chainId: { type: "integer", example: 8453 },
                    requestedHours: { type: "integer", example: 24 },
                    units: { type: "string", example: "gwei" },
                    currentGasPrice: { type: "number", example: 0.006 },
                    verdict: {
                      type: "string",
                      enum: ["cheap", "normal", "expensive", "flat"],
                      description:
                        "Where the current gas price sits within the window's range.",
                      example: "cheap",
                    },
                    summary: {
                      type: "object",
                      properties: {
                        min: { type: "number", example: 0.005 },
                        max: { type: "number", example: 0.031 },
                        avg: { type: "number", example: 0.009 },
                        median: { type: "number", example: 0.007 },
                      },
                    },
                    samples: {
                      type: "array",
                      description: "Time series, oldest first.",
                      items: {
                        type: "object",
                        properties: {
                          t: { type: "string", format: "date-time" },
                          baseFee: { type: "number", example: 0.005 },
                          gasPrice: { type: "number", example: 0.006 },
                          priorityMedium: { type: "number", example: 0.001 },
                        },
                      },
                    },
                    coverage: {
                      type: "object",
                      description:
                        "How much history actually backs this response.",
                      properties: {
                        samples: { type: "integer", example: 288 },
                        hoursCovered: { type: "number", example: 24 },
                        retentionHours: { type: "integer", example: 168 },
                      },
                    },
                    fetchedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          402: { description: "Payment Required" },
        },
      },
    },
    "/gas/cheapest-window": {
      get: {
        summary:
          "Cheapest hours of day to transact on Base, from observed gas history (paid via x402)",
        description:
          `Identifies the cheapest hours of day to transact on Base, computed from continuously collected gas history. Returns average gas price bucketed by hour of day in UTC and ranked cheapest first, plus the cheapest hour, the priciest hour, and the percentage saved by waiting for the cheap window. Common uses: schedule batch transactions for cheap gas, time an NFT mint or airdrop, plan agent workloads around low-fee hours, cut gas spend on recurring on-chain jobs, and answer when should I send this transaction. This cannot be derived from a single RPC call at any price, because it requires historical observation. Every response includes a coverage object; with less than a full day of history the hourly ranking is provisional. Check the free GET /health route first. Each call costs ${WINDOW_PRICE_USD} USDC settled on Base mainnet (eip155:8453) via x402.`,
        operationId: "getCheapestWindow",
        parameters: [
          {
            name: "hours",
            in: "query",
            required: false,
            description:
              "Lookback window in hours used to compute hourly averages. Defaults to 168 (7 days).",
            schema: {
              type: "integer",
              minimum: MIN_HOURS,
              maximum: MAX_HOURS,
              default: 168,
              example: 168,
            },
          },
        ],
        "x-payment-info": {
          price: {
            mode: "fixed",
            currency: "USD",
            amount: WINDOW_PRICE_AMOUNT,
          },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: {
            description: "Hourly gas ranking (payment accepted).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    chain: { type: "string", example: "base-mainnet" },
                    chainId: { type: "integer", example: 8453 },
                    requestedHours: { type: "integer", example: 168 },
                    units: { type: "string", example: "gwei" },
                    hourlyAverages: {
                      type: "array",
                      description: "Hour-of-day averages, cheapest first.",
                      items: {
                        type: "object",
                        properties: {
                          hourUtc: { type: "integer", example: 6 },
                          samples: { type: "integer", example: 84 },
                          avgGasPrice: { type: "number", example: 0.005 },
                        },
                      },
                    },
                    cheapestHourUtc: { type: "integer", example: 6 },
                    priciestHourUtc: { type: "integer", example: 14 },
                    savingsPercent: {
                      type: "number",
                      description:
                        "Percent saved by transacting in the cheapest hour instead of the priciest.",
                      example: 73.7,
                    },
                    hoursObserved: { type: "integer", example: 24 },
                    coverage: {
                      type: "object",
                      properties: {
                        samples: { type: "integer", example: 2016 },
                        hoursCovered: { type: "number", example: 168 },
                        retentionHours: { type: "integer", example: 168 },
                      },
                    },
                    fetchedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          402: { description: "Payment Required" },
        },
      },
    },
    "/health": {
      get: {
        summary: "Service health and gas history coverage (free)",
        description:
          "Free health check. Reports service uptime and, more usefully, exactly how much gas history has been collected so far: sample count, hours covered, sampling interval, and retention. Call this before paying for /gas/history or /gas/cheapest-window to confirm the coverage is deep enough for your use case. No payment required.",
        operationId: "getHealth",
        // An empty security array is how OpenAPI declares an operation as
        // explicitly public. Without it, discovery cannot tell "free" apart
        // from "auth mode forgotten" and warns on both L2 and L3.
        security: [],
        responses: {
          200: {
            description: "Service status and history coverage.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    uptimeSeconds: { type: "number", example: 3600 },
                    history: {
                      type: "object",
                      properties: {
                        samples: { type: "integer", example: 288 },
                        hoursCovered: { type: "number", example: 24 },
                        oldestSample: { type: "string", format: "date-time" },
                        newestSample: { type: "string", format: "date-time" },
                        sampleIntervalSeconds: { type: "integer", example: 300 },
                        retentionHours: { type: "integer", example: 168 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

app.get("/openapi.json", (_req, res) => {
  res.json(OPENAPI_DOCUMENT);
});

// --- Free health route --------------------------------------------------
// Declared BEFORE the paywall so it stays free. Its real job is disclosure:
// history coverage is visible here so agents never pay for /gas/history or
// /gas/cheapest-window only to find the buffer is still warming up.
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Number(process.uptime().toFixed(0)),
    history: coverage(),
  });
});

// JSON service description for programmatic clients (was previously at GET /).
app.get("/info", (_req, res) => {
  res.json({
    name: "base-gas-x402",
    description:
      "Pay-per-call API for live Base mainnet gas data, gated with x402.",
    endpoints: {
      "GET /": "HTML landing page (free).",
      "GET /info": "This service description as JSON (free).",
      "GET /gas": `Live Base mainnet gas data. Costs ${GAS_PRICE} per call via x402 on Base mainnet (${PAYMENT_NETWORK}).`,
      "GET /gas/compare": `Live gas comparison across Base, OP Mainnet, Arbitrum One, and Ethereum. Costs ${COMPARE_PRICE} per call via x402 on Base mainnet (${PAYMENT_NETWORK}).`,
      "GET /gas/history": `Historical Base gas prices with trend statistics and a cheap/normal/expensive verdict. Costs ${HISTORY_PRICE} per call.`,
      "GET /gas/cheapest-window": `Cheapest hours of day to transact on Base, from observed history. Costs ${WINDOW_PRICE} per call.`,
      "GET /health": "Service status and gas history coverage (free).",
    },
    payment: {
      protocol: "x402",
      network: PAYMENT_NETWORK,
      facilitator: FACILITATOR_URL,
      prices: {
        "GET /gas": GAS_PRICE,
        "GET /gas/compare": COMPARE_PRICE,
        "GET /gas/history": HISTORY_PRICE,
        "GET /gas/cheapest-window": WINDOW_PRICE,
      },
    },
  });
});

// --- Paywall: applies only to the routes declared above -----------------
// This middleware runs BEFORE the /gas handler, so any request without a
// valid payment — including the empty requests a Bazaar crawler sends — gets
// a 402 with the payment requirements and discovery metadata, and no gas
// data is fetched.
// --- 402 diagnostics -----------------------------------------------------
// When the x402 middleware rejects a payment it answers with an empty JSON body
// and puts the reason in the response headers, which never reaches the operator.
// This logs the decoded reason for any 402 that carries a payment header, so a
// rejected payment is debuggable from the deploy logs instead of invisible.
app.use((req, res, next) => {
  const hadPaymentHeader = Boolean(
    req.get("x-payment") || req.get("payment-signature"),
  );

  res.on("finish", () => {
    if (!hadPaymentHeader) return;

    // Log a compact fingerprint for BOTH accepted and rejected payments. A
    // rejected payload only means something next to an accepted one from the
    // same client, so both are needed to spot the difference.
    const rawPayload = req.get("x-payment") || req.get("payment-signature");
    if (rawPayload) {
      try {
        const payload = JSON.parse(
          Buffer.from(rawPayload, "base64").toString("utf8"),
        );
        console.error(
          `[pay ${res.statusCode}] ${req.path} keys=[${Object.keys(payload).sort().join(",")}] bytes=${rawPayload.length}`,
        );
      } catch {
        console.error(`[pay ${res.statusCode}] ${req.path} payload undecodable`);
      }
    }

    if (res.statusCode !== 402) return;

    const header = res.getHeader("payment-required");
    let reason = "(no payment-required header on the response)";

    if (header) {
      try {
        const decoded = JSON.parse(
          Buffer.from(String(header), "base64").toString("utf8"),
        );
        reason = JSON.stringify({
          error: decoded.error,
          errorMessage: decoded.errorMessage,
          resource: decoded.resource?.url,
        });
      } catch (error) {
        reason = `(could not decode: ${error.message})`;
      }
    }

    console.error(`[402] paid request rejected on ${req.method} ${req.path}: ${reason}`);

    // The facilitator rejects the *client-supplied* payload, so log its shape.
    // Signature material is deliberately not logged: field names and types are
    // enough to tell a malformed payload from a well-formed one.
    const raw = req.get("x-payment") || req.get("payment-signature");
    if (raw) {
      try {
        const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
        const shape = (value) => {
          if (value === null) return "null";
          if (Array.isArray(value)) return `array(${value.length})`;
          if (typeof value !== "object") return typeof value;
          return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, shape(v)]),
          );
        };
        console.error(`[402] client payload shape: ${JSON.stringify(shape(payload))}`);
        console.error(
          `[402] client payload scalars: ${JSON.stringify({
            x402Version: payload.x402Version,
            scheme: payload.scheme,
            network: payload.network,
            resource: payload.resource ?? payload.payload?.resource,
          })}`,
        );
      } catch (error) {
        console.error(`[402] client payload undecodable: ${error.message}`);
      }
    } else {
      console.error("[402] no x-payment header on the request");
    }
  });

  next();
});

app.use(paymentMiddleware(routes, resourceServer));

// --- Paid route ---------------------------------------------------------
// gasLimit is validated HERE, inside the handler, not in middleware. The
// paywall runs first, so unauthenticated probes still reach a clean 402 instead
// of a 400 (see the "Expected 402, got 400" discovery failure mode).
/**
 * Parses the shared optional `gasLimit` query parameter.
 * Returns `{ gasLimit }` on success or `{ error }` describing what was wrong.
 * `gasLimit` is undefined when the caller omitted it, letting each data module
 * apply its own default.
 */
function parseGasLimit(raw) {
  if (raw === undefined) return { gasLimit: undefined };

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return {
      error: { error: "gasLimit must be an integer", received: raw },
    };
  }

  const gasLimit = BigInt(parsed);
  if (gasLimit < MIN_GAS_LIMIT || gasLimit > MAX_GAS_LIMIT) {
    return {
      error: {
        error: `gasLimit must be between ${MIN_GAS_LIMIT} and ${MAX_GAS_LIMIT}`,
        received: parsed,
        presets: GAS_LIMIT_PRESETS,
      },
    };
  }

  return { gasLimit };
}

app.get("/gas", async (req, res) => {
  const { gasLimit, error: invalid } = parseGasLimit(req.query.gasLimit);
  if (invalid) return res.status(400).json(invalid);

  try {
    const data = await getGasData(gasLimit);
    res.json(data);
  } catch (error) {
    console.error("[/gas] failed to fetch gas data:", error);
    res.status(502).json({
      error: "Failed to fetch Base mainnet gas data",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/gas/compare", async (req, res) => {
  const { gasLimit, error: invalid } = parseGasLimit(req.query.gasLimit);
  if (invalid) return res.status(400).json(invalid);

  try {
    const data = await getGasComparison(gasLimit);

    // Every chain failing means the comparison is meaningless, so surface it as
    // an upstream error instead of returning an empty ranking to a paying caller.
    if (data.chains.length === 0) {
      return res.status(502).json({
        error: "No chain RPC responded",
        unavailable: data.unavailable,
      });
    }

    res.json(data);
  } catch (error) {
    console.error("[/gas/compare] failed to compare gas:", error);
    res.status(502).json({
      error: "Failed to compare gas across chains",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Parses the shared optional `hours` lookback parameter.
 */
function parseHours(raw, fallback) {
  if (raw === undefined) return { hours: fallback };

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_HOURS || parsed > MAX_HOURS) {
    return {
      error: {
        error: `hours must be an integer between ${MIN_HOURS} and ${MAX_HOURS}`,
        received: raw,
      },
    };
  }

  return { hours: parsed };
}

app.get("/gas/history", (req, res) => {
  const { hours, error: invalid } = parseHours(req.query.hours, 24);
  if (invalid) return res.status(400).json(invalid);

  try {
    res.json(getHistory(hours));
  } catch (error) {
    console.error("[/gas/history] failed:", error);
    res.status(502).json({
      error: "Failed to build gas history",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/gas/cheapest-window", (req, res) => {
  const { hours, error: invalid } = parseHours(req.query.hours, 168);
  if (invalid) return res.status(400).json(invalid);

  try {
    res.json(getCheapestWindow(hours));
  } catch (error) {
    console.error("[/gas/cheapest-window] failed:", error);
    res.status(502).json({
      error: "Failed to compute cheapest window",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(PORT, () => {
  console.log(`base-gas-x402 listening on http://localhost:${PORT}`);
  console.log(`  free:  GET /`);
  console.log(`  free:  GET /health`);
  console.log(`  paid:  GET /gas                  (${GAS_PRICE} via x402, ${PAYMENT_NETWORK})`);
  console.log(`  paid:  GET /gas/compare          (${COMPARE_PRICE} via x402, ${PAYMENT_NETWORK})`);
  console.log(`  paid:  GET /gas/history          (${HISTORY_PRICE} via x402, ${PAYMENT_NETWORK})`);
  console.log(`  paid:  GET /gas/cheapest-window  (${WINDOW_PRICE} via x402, ${PAYMENT_NETWORK})`);

  // Start collecting only once the server is actually up, so a boot failure
  // does not leave a sampler running against a half-initialised process.
  startSampler();
});
