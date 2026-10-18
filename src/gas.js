import { createPublicClient, http, formatGwei, formatEther } from "viem";
import { base } from "viem/chains";
import { cached, RPC_CACHE_MS } from "./cache.js";
import { getEthUsd, weiToUsd, ethUsdBlock } from "./price.js";

// A plain ETH transfer always costs exactly this much gas. Used as the default
// when the caller does not pass an explicit gasLimit.
const TRANSFER_GAS_LIMIT = 21000n;

// Bounds for a caller-supplied gasLimit: a plain transfer is the floor, and the
// Base block gas limit is a sane ceiling.
export const MIN_GAS_LIMIT = 21000n;
export const MAX_GAS_LIMIT = 30000000n;

// Percentiles used to derive low / medium / high priority fee tiers
// from the network's recent fee history.
const REWARD_PERCENTILES = [25, 50, 90];
const FEE_HISTORY_BLOCKS = 10;

/**
 * RPCs tried in order, so one provider going down does not stop paid /gas
 * calls and the history sampler at the same time. The operator's URL (often a
 * keyed provider such as Alchemy) comes first; the public endpoints are the
 * safety net. Duplicates are dropped.
 */
const DEFAULT_FALLBACK_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];

const fallbackRpcs = process.env.BASE_MAINNET_RPC_FALLBACK_URLS
  ? process.env.BASE_MAINNET_RPC_FALLBACK_URLS.split(",").map((u) => u.trim())
  : DEFAULT_FALLBACK_RPCS;

const rpcUrls = [
  ...new Set([process.env.BASE_MAINNET_RPC_URL, ...fallbackRpcs].filter(Boolean)),
];

// Fail over quickly: a paid caller should not wait out viem's default
// 10s timeout and 3 retries on a dead RPC before the next one is tried.
const RPC_TIMEOUT_MS = 4_000;
const RPC_RETRY_COUNT = 1;

/**
 * The RPC URL often carries a provider API key in its path or query string
 * (Alchemy, QuickNode, Infura all do this). Never return it verbatim: every
 * paying caller would be able to read and reuse the key. Expose only the host,
 * which is enough for callers to know where the data came from.
 */
function rpcSource(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

const rpcs = rpcUrls.map((url) => ({
  source: rpcSource(url),
  client: createPublicClient({
    chain: base,
    transport: http(url, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }),
  }),
}));

/**
 * Averages a single reward-percentile column across the returned blocks.
 * viem's feeHistory.reward is an array (per block) of arrays (per percentile),
 * each value a bigint in wei.
 */
function averageRewardColumn(reward, columnIndex) {
  const values = reward
    .map((perBlock) => perBlock?.[columnIndex])
    .filter((value) => typeof value === "bigint");

  if (values.length === 0) return 0n;

  const sum = values.reduce((total, value) => total + value, 0n);
  return sum / BigInt(values.length);
}

/**
 * Fetches live Base mainnet gas data.
 * All values are read from the chain — nothing is fabricated.
 *
 * @param {bigint} [gasLimit] Gas units to price the cost estimate against.
 *   Defaults to 21000 (a plain ETH transfer). Pass a larger value to estimate
 *   swaps, ERC-20 transfers, NFT mints, or contract deployments.
 */
/**
 * The three chain reads behind every /gas answer. They do not depend on
 * gasLimit, so one cached read serves every caller within the same block,
 * whatever gasLimit each of them asked for. See cache.js.
 */
async function loadChainState() {
  let lastError;
  // All three reads come from the same RPC, so they describe the same chain
  // view. The first RPC that answers all three wins.
  for (const { source, client } of rpcs) {
    try {
      const reads = await Promise.all([
        client.getBlock({ blockTag: "latest" }),
        client.getFeeHistory({
          blockCount: FEE_HISTORY_BLOCKS,
          rewardPercentiles: REWARD_PERCENTILES,
        }),
        client.getGasPrice(),
      ]);
      return [...reads, source];
    } catch (error) {
      lastError = error;
      // Hostname only: the full URL may carry an API key.
      console.error(`[gas] RPC ${source} failed, trying the next one:`, error?.shortMessage || "request failed");
    }
  }
  throw lastError;
}

const readChainState = cached(loadChainState, RPC_CACHE_MS);

export async function getGasData(gasLimit = TRANSFER_GAS_LIMIT) {
  // getEthUsd never throws: without a price the USD fields are null and the
  // rest of the response is unaffected.
  const [[block, feeHistory, gasPrice, source], ethUsd] = await Promise.all([
    readChainState(),
    getEthUsd(),
  ]);

  const baseFeePerGas = block.baseFeePerGas ?? 0n;
  const reward = feeHistory.reward ?? [];

  const lowPriority = averageRewardColumn(reward, 0);
  const mediumPriority = averageRewardColumn(reward, 1);
  const highPriority = averageRewardColumn(reward, 2);

  // Effective price an EIP-1559 transfer would pay at the "medium" tier.
  const effectiveGasPrice = baseFeePerGas + mediumPriority;
  const transferCostWei = effectiveGasPrice * gasLimit;

  return {
    chain: "base-mainnet",
    chainId: base.id,
    // The RPC that actually answered, which differs from the primary during a failover.
    rpcSource: source,
    blockNumber: block.number?.toString() ?? null,
    units: { fees: "gwei", cost: "gwei + ETH + USD" },
    baseFeePerGas: formatGwei(baseFeePerGas),
    priorityFeePerGas: {
      low: formatGwei(lowPriority),
      medium: formatGwei(mediumPriority),
      high: formatGwei(highPriority),
    },
    gasPrice: formatGwei(gasPrice),
    estimatedTransferCost: {
      gasLimit: Number(gasLimit),
      basis: "baseFee + medium priority fee",
      gwei: formatGwei(transferCostWei),
      eth: formatEther(transferCostWei),
      usd: weiToUsd(transferCostWei, ethUsd),
    },
    // Ready to pass to a wallet or viem's sendTransaction, in wei.
    suggestedFees: suggestFees(baseFeePerGas, { low: lowPriority, medium: mediumPriority, high: highPriority }),
    ethUsd: ethUsdBlock(ethUsd),
    fetchedAt: new Date().toISOString(),
  };
}

// maxFeePerGas = 2 x baseFee + priority, the usual EIP-1559 headroom. It is a
// ceiling, not a price: the chain charges baseFee + priority and refunds the
// rest. On Base the base fee moves at most about 2% per block, so 2x covers a
// long run of full blocks before a transaction would get stuck.
export const MAX_FEE_BASE_MULTIPLIER = 2n;

export function suggestFees(baseFeePerGas, tiers) {
  const out = {
    unit: "wei",
    basis: "maxFeePerGas = 2 x baseFee + maxPriorityFeePerGas; you pay baseFee + priority, the rest is a ceiling",
  };
  for (const [tier, priority] of Object.entries(tiers)) {
    out[tier] = {
      maxFeePerGas: (baseFeePerGas * MAX_FEE_BASE_MULTIPLIER + priority).toString(),
      maxPriorityFeePerGas: priority.toString(),
    };
  }
  return out;
}
