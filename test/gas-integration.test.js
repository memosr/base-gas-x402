import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { encodeFunctionResult, decodeFunctionData, parseAbi } from "viem";

// A fake Base JSON-RPC node, so /gas logic can be exercised end to end without
// network access. `priceMode` switches the Chainlink feed between answering
// and failing, to prove a price outage never breaks the gas response.
const abi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
let priceMode = "fail";
let rpcCalls = 0;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reqs = JSON.parse(body);
    const answer = (r) => {
      rpcCalls += 1;
      const ok = (result) => ({ jsonrpc: "2.0", id: r.id, result });
      switch (r.method) {
        case "eth_getBlockByNumber":
          return ok({
            number: hex(20_000_000), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`,
            timestamp: hex(Math.floor(Date.now() / 1000)), baseFeePerGas: hex(5_000_000),
            gasLimit: hex(30_000_000), gasUsed: hex(1), transactions: [], logsBloom: null, nonce: null,
            miner: `0x${"00".repeat(20)}`, difficulty: "0x0", extraData: "0x", size: "0x1",
            stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"44".repeat(32)}`,
            transactionsRoot: `0x${"55".repeat(32)}`, sha3Uncles: `0x${"66".repeat(32)}`, uncles: [],
            mixHash: `0x${"77".repeat(32)}`, totalDifficulty: "0x0",
          });
        case "eth_feeHistory":
          return ok({ oldestBlock: hex(19_999_990), baseFeePerGas: [hex(5_000_000)], gasUsedRatio: [0.5],
            reward: [[hex(1_000_000), hex(1_000_000), hex(2_000_000)]] });
        case "eth_gasPrice":
          return ok(hex(6_000_000));
        case "eth_call": {
          if (priceMode === "fail")
            return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "execution reverted" } };
          const { functionName } = decodeFunctionData({ abi, data: r.params[0].data ?? r.params[0].input });
          const result = functionName === "decimals"
            ? encodeFunctionResult({ abi, functionName, result: 8 })
            : encodeFunctionResult({ abi, functionName,
                result: [1n, 265012000000n, 0n, BigInt(Math.floor(Date.now() / 1000) - 30), 1n] });
          return ok(result);
        }
        default:
          return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unsupported ${r.method}` } };
      }
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(reqs) ? reqs.map(answer) : answer(reqs)));
  });
});

let gas;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.BASE_MAINNET_RPC_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.RPC_CACHE_MS = "2000";
  process.env.PRICE_BACKOFF_MS = "0";
  gas = await import("../src/gas.js");
});
after(() => server.close());

test("price outage: /gas data is still complete, USD fields are null", async () => {
  const data = await gas.getGasData();
  assert.equal(data.blockNumber, "20000000");
  assert.equal(data.baseFeePerGas, "0.005");
  assert.equal(data.estimatedTransferCost.gasLimit, 21000);
  assert.equal(data.estimatedTransferCost.usd, null);
  assert.equal(data.ethUsd, null);
});

test("cache: repeated calls within 2s reuse the chain reads, gasLimit still applied", async () => {
  const before = rpcCalls;
  const a = await gas.getGasData(21000n);
  const b = await gas.getGasData(180000n);
  const chainReads = rpcCalls - before;
  assert.equal(a.blockNumber, b.blockNumber);
  assert.equal(b.estimatedTransferCost.gasLimit, 180000);
  assert.notEqual(a.estimatedTransferCost.gwei, b.estimatedTransferCost.gwei);
  // Only the (uncached, failing) price reads may hit the node; the 3 gas reads must not.
  const priceReadsOnly = chainReads <= 6;
  assert.ok(priceReadsOnly, `expected no fresh gas reads, saw ${chainReads} RPC calls`);
});

test("price available: USD figures appear", async () => {
  priceMode = "ok";
  await new Promise((r) => setTimeout(r, 2100)); // let the gas cache expire too
  const data = await gas.getGasData(21000n);
  // (5_000_000 + 1_000_000) wei/gas * 21000 = 1.26e11 wei = 1.26e-7 ETH * 2650.12
  assert.equal(data.estimatedTransferCost.usd, "0.0003339");
  assert.deepEqual(data.ethUsd.price, "2650.12");
  assert.equal(data.ethUsd.source, "chainlink-eth-usd-base");
});
