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
  chain: "base-mainnet",
  chainId: 8453,
  blockNumber: "37012345",
  baseFeePerGas: "0.005",
  priorityFeePerGas: { low: "0.000486", medium: "0.00101", high: "0.0064" },
  gasPrice: "0.006",
  estimatedTransferCost: { gasLimit: 21000, gwei: "126.21", eth: "0.00000012621", usd: "0.0003069" },
  suggestedFees: { unit: "wei", medium: { maxFeePerGas: "11010000", maxPriorityFeePerGas: "1010000" } },
  ethUsd: { price: "2431.78", source: "chainlink-eth-usd-base" },
  fetchedAt: "2026-10-17T12:00:00.000Z",
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
  chain: "base-mainnet",
  chainId: 8453,
  requestedHours: 168,
  units: "gwei",
  hasDailyCycle: false,
  recommendation:
    "No meaningful daily gas cycle in this window. Timing a transaction by hour of day would not have saved anything here.",
  savingsVsAveragePercent: 1.1,
  avoidHoursUtc: [],
  savingsUsd: { gasLimit: 21000, vsPriciestHour: "0.000066", vsAverageHour: "0.000004" },
  confidence: "pattern",
  hourlyAverages: [
    { hourUtc: 6, samples: 84, avgGasPrice: 0.006 },
    { hourUtc: 2, samples: 84, avgGasPrice: 0.0073 },
  ],
  cheapestHourUtc: 6,
  priciestHourUtc: 2,
  coverage: { samples: 2016, hoursCovered: 168, retentionHours: 168 },
  fetchedAt: "2026-10-18T12:00:00.000Z",
};

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
        "Live Base mainnet gas oracle: EIP-1559 base fee, low/medium/high priority tiers, ready-to-sign maxFeePerGas, and the cost of any transaction in USD and ETH.",
      mimeType: "application/json",
      serviceName: "base-gas-x402",
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
        "Live gas cost across Base, OP Mainnet, Arbitrum One and Ethereum in one call, in USD and ETH, ranked cheapest first.",
      mimeType: "application/json",
      serviceName: "base-gas-x402",
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
        "Base gas history sampled every 5 minutes: time series, min/max/average/median, and whether gas is cheap, normal, expensive or flat right now.",
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
        "When to transact on Base, from 7 days of gas history: the hours to avoid, the cheapest hour in UTC, and the saving in percent and USD.",
      mimeType: "application/json",
      serviceName: "base-gas-x402",
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
          output: { example: WINDOW_OUTPUT_EXAMPLE },
        }),
        [BUILDER_CODE]: declareBuilderCodeExtension(BUILDER_CODE_VALUE),
      },
    },
  };
}
