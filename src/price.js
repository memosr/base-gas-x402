import { createPublicClient, http, formatEther } from "viem";
import { base } from "viem/chains";
import { cached } from "./cache.js";

/**
 * ETH/USD price from the Chainlink data feed on Base mainnet.
 *
 * Agents budget in dollars, not gwei, so every cost estimate also carries a USD
 * figure. The price is read on-chain from Chainlink's ETH/USD proxy over the
 * same Base RPC the gas data uses: no extra provider, no extra API key.
 *
 * This module is deliberately fail-soft. The gas sampler shares getGasData
 * with the paid /gas route, so a price failure that threw would lose history
 * samples and fail paid calls. Instead, any problem (RPC error, timeout, stale
 * or non-positive answer) yields `null`, and callers simply omit the USD value.
 */

// Chainlink ETH / USD proxy on Base mainnet (EACAggregatorProxy, 8 decimals).
// https://basescan.org/address/0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70
const DEFAULT_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const FEED_ADDRESS = process.env.ETH_USD_FEED_ADDRESS || DEFAULT_FEED;

// ETH moves slowly relative to a gas quote; one read per minute is plenty.
const PRICE_CACHE_MS = 60_000;

// Chainlink updates this feed on a heartbeat or on a price deviation. An answer
// older than this is treated as stale and not used.
const MAX_PRICE_AGE_SECONDS = 2 * 60 * 60;

// A price read must never hold up a paid response for long.
const PRICE_RPC_TIMEOUT_MS = 3_000;

const AGGREGATOR_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
];

const client = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org", {
    timeout: PRICE_RPC_TIMEOUT_MS,
    retryCount: 1,
  }),
});

let decimalsPromise = null;

function readDecimals() {
  // Decimals never change for a feed; read once, but retry if that read failed.
  if (!decimalsPromise) {
    decimalsPromise = client
      .readContract({ address: FEED_ADDRESS, abi: AGGREGATOR_ABI, functionName: "decimals" })
      .catch((error) => {
        decimalsPromise = null;
        throw error;
      });
  }
  return decimalsPromise;
}

/**
 * Pure validation step, exported for tests. Turns a raw latestRoundData result
 * into a usable price, or null if it should not be trusted.
 */
export function parseRound([, answer, , updatedAt], decimals, nowSeconds) {
  if (typeof answer !== "bigint" || answer <= 0n) return null;
  const age = nowSeconds - Number(updatedAt);
  if (!(age >= 0 && age <= MAX_PRICE_AGE_SECONDS)) return null;

  return {
    usd: Number(answer) / 10 ** Number(decimals),
    updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
  };
}

let lastLoggedError = null;

const loadPrice = cached(async () => {
  const [round, decimals] = await Promise.all([
    client.readContract({
      address: FEED_ADDRESS,
      abi: AGGREGATOR_ABI,
      functionName: "latestRoundData",
    }),
    readDecimals(),
  ]);

  const price = parseRound(round, decimals, Math.floor(Date.now() / 1000));
  // Throwing keeps a rejected answer out of the cache, so the next call retries.
  if (!price) throw new Error("Chainlink ETH/USD answer is stale or invalid");
  return price;
}, PRICE_CACHE_MS);

/**
 * Current ETH/USD price, or null when it cannot be read or trusted.
 * Never throws.
 * @returns {Promise<{ usd: number, updatedAt: string } | null>}
 */
export async function getEthUsd() {
  try {
    const price = await loadPrice();
    lastLoggedError = null;
    return price;
  } catch (error) {
    const message = error?.shortMessage || error?.message || String(error);
    // Log a failure once, not on every request, until it recovers.
    if (message !== lastLoggedError) {
      console.error("[price] ETH/USD unavailable, USD fields will be null:", message);
      lastLoggedError = message;
    }
    return null;
  }
}

/**
 * Converts a wei amount to a USD string with 4 significant digits and no
 * exponent notation (e.g. "0.0003281"), or null without a price.
 * @param {bigint} wei
 * @param {{ usd: number } | null} price
 */
export function weiToUsd(wei, price) {
  if (!price) return null;
  const value = Number(formatEther(wei)) * price.usd;
  if (!Number.isFinite(value)) return null;
  if (value === 0) return "0";
  return value.toLocaleString("en-US", {
    maximumSignificantDigits: 4,
    useGrouping: false,
  });
}

/**
 * The `ethUsd` block attached to responses, or null without a price.
 * @param {{ usd: number, updatedAt: string } | null} price
 */
export function ethUsdBlock(price) {
  if (!price) return null;
  return {
    price: price.usd.toFixed(2),
    source: "chainlink-eth-usd-base",
    updatedAt: price.updatedAt,
  };
}
