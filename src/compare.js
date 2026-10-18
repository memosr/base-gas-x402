import { createPublicClient, defineChain, http, formatGwei, formatEther } from "viem";
import { base, mainnet, optimism, arbitrum } from "viem/chains";
import { cached, RPC_CACHE_MS } from "./cache.js";
import { getEthUsd, weiToUsd, ethUsdBlock } from "./price.js";

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

// Circle's Arc mainnet. viem ships only the testnet definition. Gas is paid in
// USDC, which the native accounting carries with 18 decimals, so a cost in
// native units is already a dollar amount and needs no price feed.
export const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

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
  {
    key: "arc",
    label: "Arc",
    chain: arc,
    gasToken: "USDC",
    rpcUrls: rpcList(process.env.ARC_RPC_URL, [
      "https://rpc.mainnet.arc.io",
      "https://rpc.drpc.mainnet.arc.io",
      "https://rpc.quicknode.mainnet.arc.io",
    ]),
  },
];

// Clients are built once per RPC URL and reused across requests.
const clients = new Map(
  CHAINS.map((entry) => [
    entry.key,
    entry.rpcUrls.map((url) =>
      createPublicClient({
        chain: entry.chain,
        // Fail over quickly to the next RPC instead of waiting out viem's
        // default 10s timeout and 3 retries on a dead one.
        transport: http(url, { timeout: 4_000, retryCount: 1 }),
      }),
    ),
  ]),
);

const DEFAULT_GAS_LIMIT = 21000n;

/**
 * Reads one chain's latest block and gas price, trying each RPC in order; the
 * first one that answers wins. Independent of gasLimit, so it is cached per
 * chain (see cache.js) and shared by every caller within the TTL.
 */
async function loadChainState(entry) {
  const candidates = clients.get(entry.key);
  let lastError;

  for (const client of candidates) {
    try {
      return await Promise.all([
        client.getBlock({ blockTag: "latest" }),
        client.getGasPrice(),
      ]);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

const chainStateReaders = new Map(
  CHAINS.map((entry) => [
    entry.key,
    cached(() => loadChainState(entry), RPC_CACHE_MS),
  ]),
);

async function readChain(entry, gasLimit, ethUsdPromise) {
  // The price read runs in parallel with the chain reads, not before them.
  const [[block, gasPrice], ethUsd] = await Promise.all([
    chainStateReaders.get(entry.key)(),
    ethUsdPromise,
  ]);

  const baseFeePerGas = block.baseFeePerGas ?? 0n;
  const costWei = gasPrice * gasLimit;
  const paysInUsdc = entry.gasToken === "USDC";

  return {
    chain: entry.key,
    label: entry.label,
    chainId: entry.chain.id,
    gasToken: paysInUsdc ? "USDC" : "ETH",
    blockNumber: block.number?.toString() ?? null,
    baseFeePerGas: formatGwei(baseFeePerGas),
    gasPrice: formatGwei(gasPrice),
    estimatedCost: {
      gasLimit: Number(gasLimit),
      gwei: formatGwei(costWei),
      // ETH chains: cost in ETH, converted with one ETH/USD price. Arc: gas is
      // USDC, so the native amount is the dollar cost and eth is null.
      eth: paysInUsdc ? null : formatEther(costWei),
      ...(paysInUsdc ? { usdc: formatEther(costWei) } : {}),
      usd: paysInUsdc ? weiToUsd(costWei, ONE_DOLLAR) : weiToUsd(costWei, ethUsd),
    },
  };
}

// weiToUsd takes a price per native unit; 1 USDC is $1.
const ONE_DOLLAR = { usd: 1 };

/**
 * Orders chains cheapest first. With an ETH/USD price every chain has a usd
 * cost and they rank together. Without one, the ETH chains still rank by ETH
 * and USDC-gas chains go last, since the two cannot be compared.
 */
export function rank(chains) {
  const usd = (c) => (c.estimatedCost.usd === null ? null : Number(c.estimatedCost.usd));
  if (chains.every((c) => usd(c) !== null)) {
    return [...chains].sort((a, b) => usd(a) - usd(b));
  }
  const inEth = chains.filter((c) => c.estimatedCost.eth !== null);
  const other = chains.filter((c) => c.estimatedCost.eth === null);
  inEth.sort((a, b) => Number(a.estimatedCost.eth) - Number(b.estimatedCost.eth));
  return [...inEth, ...other];
}

/**
 * Compares live gas costs across Base, OP Mainnet, Arbitrum One, Ethereum and Arc.
 *
 * One slow or failing chain must not take down the whole response, so each
 * chain is read independently and failures are reported per chain rather than
 * thrown. The caller has already paid; returning partial data beats returning
 * an error.
 *
 * @param {bigint} [gasLimit] Gas units to price each chain against.
 */
export async function getGasComparison(gasLimit = DEFAULT_GAS_LIMIT) {
  // Started once and shared by every chain. getEthUsd never rejects.
  const ethUsdPromise = getEthUsd();
  const settled = await Promise.allSettled(
    CHAINS.map((entry) => readChain(entry, gasLimit, ethUsdPromise)),
  );
  const ethUsd = await ethUsdPromise;

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

  const ranked = rank(chains);

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
    ethUsd: ethUsdBlock(ethUsd),
    fetchedAt: new Date().toISOString(),
  };
}
