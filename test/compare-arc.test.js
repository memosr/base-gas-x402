import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { encodeFunctionResult, decodeFunctionData, parseAbi } from "viem";

// One fake JSON-RPC node per chain, told apart by URL path. Gas prices mirror
// what each chain really looked like on 2026-10-18; Arc's 20.5 gwei is from
// its mainnet RPC (base fee on the 20 gwei floor). The Chainlink feed answers
// on /base when priceMode is "ok" (ETH at $2,650.12).
const abi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const GAS_PRICE = { base: 6_000_000n, optimism: 1_000_000n, arbitrum: 10_000_000n, ethereum: 500_000_000n, arc: 20_500_000_000n };
let priceMode = "fail";

const server = http.createServer((req, res) => {
  const chain = req.url.slice(1);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reqs = JSON.parse(body);
    const answer = (r) => {
      const ok = (result) => ({ jsonrpc: "2.0", id: r.id, result });
      switch (r.method) {
        case "eth_getBlockByNumber":
          return ok({
            number: hex(1_000), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`,
            timestamp: hex(Math.floor(Date.now() / 1000)), baseFeePerGas: hex(GAS_PRICE[chain] - GAS_PRICE[chain] / 41n),
            gasLimit: hex(30_000_000), gasUsed: hex(1), transactions: [], logsBloom: null, nonce: null,
            miner: `0x${"00".repeat(20)}`, difficulty: "0x0", extraData: "0x", size: "0x1",
            stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"44".repeat(32)}`,
            transactionsRoot: `0x${"55".repeat(32)}`, sha3Uncles: `0x${"66".repeat(32)}`, uncles: [],
            mixHash: `0x${"77".repeat(32)}`, totalDifficulty: "0x0",
          });
        case "eth_gasPrice":
          return ok(hex(GAS_PRICE[chain]));
        case "eth_call": {
          if (chain !== "base" || priceMode === "fail")
            return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "execution reverted" } };
          const { functionName } = decodeFunctionData({ abi, data: r.params[0].data ?? r.params[0].input });
          return ok(functionName === "decimals"
            ? encodeFunctionResult({ abi, functionName, result: 8 })
            : encodeFunctionResult({ abi, functionName,
                result: [1n, 265012000000n, 0n, BigInt(Math.floor(Date.now() / 1000) - 30), 1n] }));
        }
        default:
          return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unsupported ${r.method}` } };
      }
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(reqs) ? reqs.map(answer) : answer(reqs)));
  });
});

let compare;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.BASE_MAINNET_RPC_URL = `${origin}/base`;
  process.env.BASE_MAINNET_RPC_FALLBACK_URLS = `${origin}/base`;
  process.env.OPTIMISM_RPC_URL = `${origin}/optimism`;
  process.env.ARBITRUM_RPC_URL = `${origin}/arbitrum`;
  process.env.ETHEREUM_RPC_URL = `${origin}/ethereum`;
  process.env.ARC_RPC_URL = `${origin}/arc`;
  process.env.RPC_CACHE_MS = "0";
  process.env.PRICE_BACKOFF_MS = "0";
  compare = await import("../src/compare.js");
});
after(() => server.close());

test("Arc is quoted in USDC and USD, never in ETH, even without an ETH price", async () => {
  const data = await compare.getGasComparison(21000n);
  const arc = data.chains.find((c) => c.chain === "arc");
  assert.ok(arc, JSON.stringify(data.unavailable));
  assert.equal(arc.chainId, 5042);
  assert.equal(arc.gasToken, "USDC");
  assert.equal(arc.estimatedCost.eth, null);
  // 21000 gas x 20.5 gwei = 0.0004305 USDC, and a USDC amount is a dollar amount.
  assert.equal(arc.estimatedCost.usdc, "0.0004305");
  assert.equal(arc.estimatedCost.usd, "0.0004305");
  // No ETH/USD price: the ETH chains cannot be ranked against Arc, so it goes last.
  assert.equal(data.chains.at(-1).chain, "arc");
  assert.equal(data.chains.length, 5);
});

test("with an ETH price every chain ranks together by dollar cost", async () => {
  priceMode = "ok";
  const data = await compare.getGasComparison(21000n);
  const order = data.chains.map((c) => c.chain);
  // At $2,650.12/ETH: OP $0.00006, Base $0.0003, Arc $0.00043, Arbitrum $0.00056, Ethereum $0.028.
  assert.deepEqual(order, ["optimism", "base", "arc", "arbitrum", "ethereum"]);
  assert.equal(data.cheapest, "optimism");
  assert.equal(data.baseRank, 2);
});

test("rank: usd when every chain has one, ETH first then the rest otherwise", () => {
  const c = (chain, eth, usd) => ({ chain, estimatedCost: { eth, usd } });
  assert.deepEqual(
    compare.rank([c("a", "2", "5"), c("arc", null, "1"), c("b", "1", "3")]).map((x) => x.chain),
    ["arc", "b", "a"],
  );
  assert.deepEqual(
    compare.rank([c("a", "2", null), c("arc", null, "1"), c("b", "1", null)]).map((x) => x.chain),
    ["b", "a", "arc"],
  );
});
