import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { BUILDER_CODE, declareBuilderCodeExtension } from "@x402/extensions/builder-code";
import { MIN_GAS_LIMIT, MAX_GAS_LIMIT } from "./gas.js";
import {
  PAYMENT_NETWORK,
  GAS_PRICE,
  COMPARE_PRICE,
  HISTORY_PRICE,
  WINDOW_PRICE,
  MIN_HOURS,
  MAX_HOURS,
} from "./pricing.js";

// The paid routes as the x402 middleware sees them: payment terms plus the
// Bazaar discovery metadata echoed in every 402. Everything here ends up in
// the PAYMENT-REQUIRED header, which the facilitator size-limits (see
// test/server-402.test.js), so keep additions small.

// Base Builder Code attribution (ERC-8021 Schema 2 "a" / app code). Advertised
// in the /gas 402 PAYMENT-REQUIRED extensions so settlement calldata can be
// attributed to this service. Override via BUILDER_CODE env if needed.
const BUILDER_CODE_VALUE = process.env.BUILDER_CODE || "bc_lhfd8zad";

// Output shape advertised to Bazaar crawlers so agents know what they'll get.
const GAS_OUTPUT_EXAMPLE = {
  chainId: 8453,
  baseFeePerGas: "0.005",
  priorityFeePerGas: { low: "0.000486", medium: "0.00101", high: "0.0064" },
  gasPrice: "0.006",
  estimatedTransferCost: { gasLimit: 21000, gwei: "126.21", eth: "0.00000012621", usd: "0.0003069" },
  suggestedFees: { unit: "wei", medium: { maxFeePerGas: "11010000", maxPriorityFeePerGas: "1010000" } },
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
      estimatedCost: { gasLimit: 21000, gwei: "126", eth: "0.000000126", usd: "0.0003" },
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

// Mirrors a real 7-day Base window: gas sits on its floor, so timing saves
// about 1%. An earlier example showed 73.7%, which no real window produced.
const WINDOW_OUTPUT_EXAMPLE = {
  requestedHours: 168,
  hasDailyCycle: false,
  recommendation:
    "No meaningful daily gas cycle in this window. Timing a transaction by hour of day would not have saved anything here.",
  savingsVsAveragePercent: 1.1,
  avoidHoursUtc: [],
  confidence: "pattern",
  cheapestHourUtc: 6,
};

// Compact output schemas for Bazaar. Bazaar ranks search results partly on how
// complete a resource's description and output schema are, so each route
// declares the top-level shape. Kept terse: these ride in the 402 header too.
const obj = (properties) => ({ type: "object", properties });
const S = { type: "string" };
const N = { type: "number" };
const I = { type: "integer" };

const GAS_OUTPUT_SCHEMA = obj({
  chainId: I,
  baseFeePerGas: S,
  priorityFeePerGas: obj({ low: S, medium: S, high: S }),
  gasPrice: S,
  estimatedTransferCost: obj({ gasLimit: I, gwei: S, eth: S, usd: S }),
  suggestedFees: { type: ["object", "null"] },
  ethUsd: { type: ["object", "null"] },
});

const COMPARE_OUTPUT_SCHEMA = obj({
  gasLimit: I,
  chains: { type: "array" },
  cheapest: S,
  baseRank: I,
  baseVsEthereum: S,
});

const HISTORY_OUTPUT_SCHEMA = obj({
  requestedHours: I,
  currentGasPrice: N,
  verdict: { type: ["string", "null"], enum: ["cheap", "normal", "expensive", "flat", null] },
  summary: obj({ min: N, max: N, avg: N, median: N }),
  samples: { type: "array" },
});

const WINDOW_OUTPUT_SCHEMA = obj({
  hasDailyCycle: { type: "boolean" },
  recommendation: S,
  savingsVsAveragePercent: N,
  avoidHoursUtc: { type: "array" },
  cheapestHourUtc: I,
  confidence: { type: "string", enum: ["single-day", "provisional", "pattern"] },
});

// Shown next to the listing in Bazaar-backed directories.
const ICON_URL = "https://base-gas-x402.vercel.app/icon-512.png";

/**
 * @param {string} PAY_TO_ADDRESS Where every payment settles.
 */
export function buildRoutes(PAY_TO_ADDRESS) {
  return {
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
      // Short on purpose: see the size note on /gas/history below. The
      // discovery-driving copy lives in the OpenAPI document instead.
      description:
        "Current gas price on Base and what a transaction costs in USD right now: base fee, priority tiers, ready-to-sign maxFeePerGas.",
      mimeType: "application/json",
      serviceName: "base-gas-x402",
      iconUrl: ICON_URL,
      tags: ["gas", "gas price", "gas oracle", "base", "base-l2", "onchain-data"],
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
                  "Gas units to price. 21000 ETH transfer (default), 65000 ERC-20, 85000 NFT mint, 180000 swap, 1500000 deploy.",
              },
            },
            required: [],
          },
          output: { example: GAS_OUTPUT_EXAMPLE, schema: GAS_OUTPUT_SCHEMA },
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
        "What the same transaction costs right now on Base, Optimism, Arbitrum and Ethereum, in USD, cheapest chain first.",
      mimeType: "application/json",
      serviceName: "base-gas-x402",
      iconUrl: ICON_URL,
      tags: [
        "gas comparison",
        "cross-chain",
        "l2 fees",
        "base",
        "cheapest chain",
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
          output: { example: COMPARE_OUTPUT_EXAMPLE, schema: COMPARE_OUTPUT_SCHEMA },
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
        "Is Base gas high or low right now? Up to 7 days of history every 5 min, min/max/avg/median, cheap/normal/expensive verdict.",
      mimeType: "application/json",
      serviceName: "base-gas-x402",
      iconUrl: ICON_URL,
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
          output: { example: HISTORY_OUTPUT_EXAMPLE, schema: HISTORY_OUTPUT_SCHEMA },
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
        "Best time of day to send a transaction on Base: hours to avoid, cheapest hour (UTC), and what waiting saves in USD.",
      mimeType: "application/json",
      serviceName: "base-gas-x402",
      iconUrl: ICON_URL,
      tags: [
        "gas timing",
        "cheapest time to transact",
        "gas savings",
        "base",
        "base-l2",
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
          output: { example: WINDOW_OUTPUT_EXAMPLE, schema: WINDOW_OUTPUT_SCHEMA },
        }),
        [BUILDER_CODE]: declareBuilderCodeExtension(BUILDER_CODE_VALUE),
      },
    },
  };
}
