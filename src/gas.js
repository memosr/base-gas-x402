import { createPublicClient, http, formatGwei, formatEther } from "viem";
import { base } from "viem/chains";

// A plain ETH transfer always costs exactly this much gas.
const TRANSFER_GAS_LIMIT = 21000n;

// Percentiles used to derive low / medium / high priority fee tiers
// from the network's recent fee history.
const REWARD_PERCENTILES = [25, 50, 90];
const FEE_HISTORY_BLOCKS = 10;

const rpcUrl = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";

const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

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
 */
export async function getGasData() {
  const [block, feeHistory, gasPrice] = await Promise.all([
    client.getBlock({ blockTag: "latest" }),
    client.getFeeHistory({
      blockCount: FEE_HISTORY_BLOCKS,
      rewardPercentiles: REWARD_PERCENTILES,
    }),
    client.getGasPrice(),
  ]);

  const baseFeePerGas = block.baseFeePerGas ?? 0n;
  const reward = feeHistory.reward ?? [];

  const lowPriority = averageRewardColumn(reward, 0);
  const mediumPriority = averageRewardColumn(reward, 1);
  const highPriority = averageRewardColumn(reward, 2);

  // Effective price an EIP-1559 transfer would pay at the "medium" tier.
  const effectiveGasPrice = baseFeePerGas + mediumPriority;
  const transferCostWei = effectiveGasPrice * TRANSFER_GAS_LIMIT;

  return {
    chain: "base-mainnet",
    chainId: base.id,
    rpcUrl,
    blockNumber: block.number?.toString() ?? null,
    units: { fees: "gwei", cost: "gwei + ETH" },
    baseFeePerGas: formatGwei(baseFeePerGas),
    priorityFeePerGas: {
      low: formatGwei(lowPriority),
      medium: formatGwei(mediumPriority),
      high: formatGwei(highPriority),
    },
    gasPrice: formatGwei(gasPrice),
    estimatedTransferCost: {
      gasLimit: Number(TRANSFER_GAS_LIMIT),
      basis: "baseFee + medium priority fee",
      gwei: formatGwei(transferCostWei),
      eth: formatEther(transferCostWei),
    },
    fetchedAt: new Date().toISOString(),
  };
}
