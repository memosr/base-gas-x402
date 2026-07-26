import { createPublicClient, http, formatGwei, formatEther } from "viem";
import { base, mainnet, optimism, arbitrum } from "viem/chains";

/**
 * Multi-chain gas comparison.
 *
 * Answers the question agents actually ask: "is Base cheaper than the
 * alternatives right now, and by how much?" A single-chain gas endpoint cannot
 * answer that, which is why this is a separate resource.
 */

/**
 * Each chain carries a list of RPC endpoints tried in order. Free public RPCs
 * rate-limit and go down without warning (llamarpc dropped Ethereum requests in
 * testing), so a single URL is not enough to keep a paid endpoint honest.
 * An operator-supplied env URL always takes priority.
 */
function rpcList(envUrl, fallbacks) {
  return envUrl ? [envUrl, ...fallbacks] : fallbacks;
}

const CHAINS = [
  {
    key: "base",
    label: "Base",
    chain: base,
    rpcUrls: rpcList(process.env.BASE_MAINNET_RPC_URL, [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
    ]),
  },
  {
    key: "optimism",
    label: "OP Mainnet",
    chain: optimism,
    rpcUrls: rpcList(process.env.OPTIMISM_RPC_URL, [
      "https://mainnet.optimism.io",
      "https://optimism-rpc.publicnode.com",
    ]),
  },
  {
    key: "arbitrum",
    label: "Arbitrum One",
    chain: arbitrum,
    rpcUrls: rpcList(process.env.ARBITRUM_RPC_URL, [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
    ]),
  },
  {
    key: "ethereum",
    label: "Ethereum",
    chain: mainnet,
    rpcUrls: rpcList(process.env.ETHEREUM_RPC_URL, [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
      "https://eth.llamarpc.com",
    ]),
  },
];

// Clients are built once per RPC URL and reused across requests.
const clients = new Map(
  CHAINS.map((entry) => [
    entry.key,
    entry.rpcUrls.map((url) =>
      createPublicClient({ chain: entry.chain, transport: http(url) }),
    ),
  ]),
);

const DEFAULT_GAS_LIMIT = 21000n;

async function readChain(entry, gasLimit) {
  const candidates = clients.get(entry.key);

  let block;
  let gasPrice;
  let lastError;

  // Try each RPC in order; the first one that answers wins.
  for (const client of candidates) {
    try {
      [block, gasPrice] = await Promise.all([
        client.getBlock({ blockTag: "latest" }),
        client.getGasPrice(),
      ]);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;

  const baseFeePerGas = block.baseFeePerGas ?? 0n;
  const costWei = gasPrice * gasLimit;

  return {
    chain: entry.key,
    label: entry.label,
    chainId: entry.chain.id,
    blockNumber: block.number?.toString() ?? null,
    baseFeePerGas: formatGwei(baseFeePerGas),
    gasPrice: formatGwei(gasPrice),
    estimatedCost: {
      gasLimit: Number(gasLimit),
      gwei: formatGwei(costWei),
      eth: formatEther(costWei),
    },
  };
}

/**
 * Compares live gas costs across Base, OP Mainnet, Arbitrum One, and Ethereum.
 *
 * One slow or failing chain must not take down the whole response, so each
 * chain is read independently and failures are reported per chain rather than
 * thrown. The caller has already paid; returning partial data beats returning
 * an error.
 *
 * @param {bigint} [gasLimit] Gas units to price each chain against.
 */
export async function getGasComparison(gasLimit = DEFAULT_GAS_LIMIT) {
  const settled = await Promise.allSettled(
    CHAINS.map((entry) => readChain(entry, gasLimit)),
  );

  const chains = [];
  const unavailable = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      chains.push(result.value);
    } else {
      unavailable.push({
        chain: CHAINS[index].key,
        reason: result.reason?.shortMessage || "RPC request failed",
      });
    }
  });

  // Rank by absolute cost in wei rather than gwei strings, to avoid float
  // comparison on formatted values.
  const ranked = [...chains].sort(
    (a, b) => Number(a.estimatedCost.eth) - Number(b.estimatedCost.eth),
  );

  const cheapest = ranked[0] ?? null;
  const baseEntry = chains.find((c) => c.chain === "base") ?? null;

  let baseVsEthereum = null;
  const ethereumEntry = chains.find((c) => c.chain === "ethereum");
  if (baseEntry && ethereumEntry) {
    const baseCost = Number(baseEntry.estimatedCost.eth);
    const ethCost = Number(ethereumEntry.estimatedCost.eth);
    if (baseCost > 0) {
      baseVsEthereum = `Base is ${(ethCost / baseCost).toFixed(1)}x cheaper than Ethereum`;
    }
  }

  return {
    gasLimit: Number(gasLimit),
    basis: "current gas price x gasLimit",
    chains: ranked,
    cheapest: cheapest ? cheapest.chain : null,
    baseRank: cheapest ? ranked.findIndex((c) => c.chain === "base") + 1 : null,
    baseVsEthereum,
    unavailable,
    fetchedAt: new Date().toISOString(),
  };
}
