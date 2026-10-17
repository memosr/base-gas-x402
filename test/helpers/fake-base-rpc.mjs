import http from "node:http";

const hex = (n) => `0x${BigInt(n).toString(16)}`;

/**
 * Starts a minimal Base JSON-RPC node that answers the reads /gas makes.
 * eth_call fails, so the Chainlink price is unavailable (USD fields null).
 * mode "dead" answers every call with HTTP 500.
 */
export async function startFakeBaseRpc({ mode = "ok" } = {}) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls += 1;
      if (mode === "dead") {
        res.statusCode = 500;
        return res.end("down");
      }
      const reqs = JSON.parse(body);
      const answer = (r) => {
        const ok = (result) => ({ jsonrpc: "2.0", id: r.id, result });
        switch (r.method) {
          case "eth_getBlockByNumber":
            return ok({
              number: hex(30_000_000), hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`,
              timestamp: hex(Math.floor(Date.now() / 1000)), baseFeePerGas: hex(5_000_000),
              gasLimit: hex(30_000_000), gasUsed: hex(1), transactions: [], logsBloom: null, nonce: null,
              miner: `0x${"00".repeat(20)}`, difficulty: "0x0", extraData: "0x", size: "0x1",
              stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"44".repeat(32)}`,
              transactionsRoot: `0x${"55".repeat(32)}`, sha3Uncles: `0x${"66".repeat(32)}`, uncles: [],
              mixHash: `0x${"77".repeat(32)}`, totalDifficulty: "0x0",
            });
          case "eth_feeHistory":
            return ok({ oldestBlock: hex(29_999_990), baseFeePerGas: [hex(5_000_000)], gasUsedRatio: [0.5],
              reward: [[hex(1_000_000), hex(1_000_000), hex(2_000_000)]] });
          case "eth_gasPrice":
            return ok(hex(6_000_000));
          default:
            return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "unsupported" } };
        }
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(reqs) ? reqs.map(answer) : answer(reqs)));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, calls: () => calls, close: () => server.close() };
}
