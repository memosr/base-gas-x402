import { MIN_GAS_LIMIT, MAX_GAS_LIMIT } from "./gas.js";
import {
  GAS_PRICE_USD,
  COMPARE_PRICE_USD,
  HISTORY_PRICE_USD,
  WINDOW_PRICE_USD,
  GAS_PRICE_AMOUNT,
  COMPARE_PRICE_AMOUNT,
  HISTORY_PRICE_AMOUNT,
  WINDOW_PRICE_AMOUNT,
  MIN_HOURS,
  MAX_HOURS,
} from "./pricing.js";

// --- OpenAPI 3.1 discovery document --------------------------------------
// Served free at GET /openapi.json so agents and directories (e.g. x402scan)
// can machine-read what this service offers and how it's priced. This mirrors
// the runtime 402 contract (Base mainnet eip155:8453, USDC via x402)
// but is purely descriptive — it does not affect the paywall below.
export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "base-gas-x402",
    version: "1.1.0",
    description:
      `Base gas oracle for agents that budget in dollars. Live Base mainnet (chain id 8453) gas: EIP-1559 base fee, low/medium/high priority tiers, and what any transaction costs in USD, ETH and gwei (ETH/USD read on-chain from Chainlink). Also: live gas cost compared across Base, OP Mainnet, Arbitrum and Ethereum in one call; 7 days of Base gas history sampled every 5 minutes with a cheap/normal/expensive/flat verdict; and the hours of day to avoid. Paid per call over x402 in USDC, from $${GAS_PRICE_USD}. No API key, no signup. Free: GET /health.`,
    "x-guidance":
      `Call GET /gas to fetch live Base mainnet gas data. All parameters are optional. Each call costs ${GAS_PRICE_USD} USDC, settled on Base mainnet (eip155:8453) via x402. Use it to check gas fees before sending a transaction on Base, estimate transaction cost in US dollars, budget agent gas spending, or monitor Base L2 network congestion. Fees are returned in gwei; estimatedTransferCost also carries usd and eth, and suggestedFees gives maxFeePerGas / maxPriorityFeePerGas in wei, ready to sign. For "which chain is cheapest right now" call GET /gas/compare once instead of four chains separately. For "is gas high or low right now, should I wait" call GET /gas/history (verdict). For "when should I schedule this" call GET /gas/cheapest-window (avoidHoursUtc). Check the free GET /health first for history coverage. Pass the optional gasLimit query parameter to price a specific operation: 21000 for a plain ETH transfer (the default), ~65000 for an ERC-20 transfer, ~85000 for an NFT mint, ~180000 for a Uniswap swap, ~1500000 for a contract deploy. estimatedTransferCost is priced at base fee plus the medium priority tier.`,
    contact: { email: "mehmet.sr35@gmail.com" },
  },
  servers: [{ url: "https://base-gas-x402-production.up.railway.app" }],
  paths: {
    "/gas": {
      get: {
        summary:
          "Live Base gas oracle: base fee, priority fee tiers, and transaction cost in USD (paid via x402)",
        description:
          `Returns live Base mainnet (Base L2, Coinbase Base) gas data read directly from the chain: EIP-1559 base fee per gas, low/medium/high priority fee tiers, current gas price in gwei, and an estimated transaction cost for any gas limit in gwei, ETH and US dollars (ETH/USD from the Chainlink feed on Base). Common uses: check current gas fees on Base, get the Base network gas price before sending a transaction, estimate transaction cost on Base mainnet, price a Uniswap swap or NFT mint on Base, find a cheap time to transact on Base L2, monitor Base network congestion, budget gas spending for an on-chain agent, and compare Base gas costs to other L2 networks. Each call costs ${GAS_PRICE_USD} USDC settled on Base mainnet (eip155:8453) via x402. No API key or subscription required.`,
        operationId: "getGas",
        parameters: [
          {
            name: "gasLimit",
            in: "query",
            required: false,
            description:
              "Gas units to price the cost estimate against. Defaults to 21000 (a plain ETH transfer). Use ~65000 for an ERC-20 transfer, ~85000 for an NFT mint, ~180000 for a Uniswap swap, or ~1500000 for a contract deploy.",
            schema: {
              type: "integer",
              minimum: Number(MIN_GAS_LIMIT),
              maximum: Number(MAX_GAS_LIMIT),
              default: 21000,
              example: 180000,
            },
          },
        ],
        "x-payment-info": {
          price: { mode: "fixed", currency: "USD", amount: GAS_PRICE_AMOUNT },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: {
            description: "Live Base mainnet gas data (payment accepted).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    chain: { type: "string", example: "base-mainnet" },
                    rpcSource: {
                      type: "string",
                      description: "Hostname of the RPC that answered. Never the full URL.",
                      example: "mainnet.base.org",
                    },
                    chainId: { type: "integer", example: 8453 },
                    blockNumber: { type: "string", example: "12345678" },
                    baseFeePerGas: {
                      type: "string",
                      description: "Base fee per gas, in gwei.",
                      example: "0.012",
                    },
                    units: {
                      type: "object",
                      properties: {
                        fees: { type: "string", example: "gwei" },
                        cost: { type: "string", example: "gwei + ETH + USD" },
                      },
                    },
                    priorityFeePerGas: {
                      type: "object",
                      description: "Priority fee tiers, in gwei.",
                      properties: {
                        low: { type: "string", example: "0.001" },
                        medium: { type: "string", example: "0.002" },
                        high: { type: "string", example: "0.004" },
                      },
                    },
                    gasPrice: {
                      type: "string",
                      description: "Network gas price, in gwei.",
                      example: "0.014",
                    },
                    estimatedTransferCost: {
                      type: "object",
                      description: "Estimated cost for the requested gasLimit (default 21000, a plain ETH transfer).",
                      properties: {
                        gasLimit: { type: "integer", example: 21000 },
                        basis: { type: "string", example: "baseFee + medium priority fee" },
                        gwei: { type: "string", example: "294" },
                        eth: { type: "string", example: "0.000000294" },
                        usd: {
                          type: ["string", "null"],
                          description:
                            "Estimated cost in US dollars, 4 significant digits. Null if the ETH/USD price is unavailable.",
                          example: "0.0007791",
                        },
                      },
                    },
                    suggestedFees: {
                      type: ["object", "null"],
                      description:
                        "EIP-1559 fee fields ready to pass to a wallet or viem sendTransaction, as wei strings. Null only if the latest block carries no base fee. maxFeePerGas is 2 x baseFee + priority: a ceiling, not the price; the chain charges baseFee + priority and refunds the rest. Pick medium unless the transaction is urgent (high) or can wait (low).",
                      properties: {
                        unit: { type: "string", example: "wei" },
                        basis: { type: "string" },
                        low: {
                          type: "object",
                          properties: {
                            maxFeePerGas: { type: "string", example: "11010000" },
                            maxPriorityFeePerGas: { type: "string", example: "1010000" },
                          },
                        },
                        medium: {
                          type: "object",
                          properties: {
                            maxFeePerGas: { type: "string", example: "11010000" },
                            maxPriorityFeePerGas: { type: "string", example: "1010000" },
                          },
                        },
                        high: {
                          type: "object",
                          properties: {
                            maxFeePerGas: { type: "string", example: "11010000" },
                            maxPriorityFeePerGas: { type: "string", example: "1010000" },
                          },
                        },
                      },
                    },
                    ethUsd: {
                      type: ["object", "null"],
                      description:
                        "ETH/USD price used for the usd figures, read on-chain from the Chainlink ETH/USD feed on Base. Null when the feed cannot be read or is stale, in which case every usd field is null too.",
                      properties: {
                        price: { type: "string", example: "2650.12" },
                        source: { type: "string", example: "chainlink-eth-usd-base" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                    fetchedAt: {
                      type: "string",
                      format: "date-time",
                      example: "2026-06-22T00:00:00.000Z",
                    },
                  },
                },
              },
            },
          },
          402: { description: "Payment Required" },
        },
      },
    },
    "/gas/compare": {
      get: {
        summary:
          "Compare live gas costs across Base, OP Mainnet, Arbitrum, and Ethereum (paid via x402)",
        description:
          `Compares live gas costs across Base, OP Mainnet, Arbitrum One, and Ethereum in a single call, ranked cheapest first. Returns each chain's EIP-1559 base fee, current gas price in gwei, and estimated cost for a given gas limit in ETH and US dollars, plus which chain is cheapest right now and how many times cheaper Base is than Ethereum. Common uses: pick the cheapest chain for a transaction, decide whether bridging to Base is worth it, compare L2 fees across networks, route agent transactions to the lowest-cost chain, and monitor relative congestion between L2s. Chains that fail to respond are listed under "unavailable" rather than failing the whole request. Each call costs ${COMPARE_PRICE_USD} USDC settled on Base mainnet (eip155:8453) via x402.`,
        operationId: "compareGas",
        parameters: [
          {
            name: "gasLimit",
            in: "query",
            required: false,
            description:
              "Gas units to price each chain against. Defaults to 21000 (a plain ETH transfer).",
            schema: {
              type: "integer",
              minimum: Number(MIN_GAS_LIMIT),
              maximum: Number(MAX_GAS_LIMIT),
              default: 21000,
              example: 180000,
            },
          },
        ],
        "x-payment-info": {
          price: {
            mode: "fixed",
            currency: "USD",
            amount: COMPARE_PRICE_AMOUNT,
          },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: {
            description: "Multi-chain gas comparison (payment accepted).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    gasLimit: { type: "integer", example: 21000 },
                    basis: {
                      type: "string",
                      example: "current gas price x gasLimit",
                    },
                    chains: {
                      type: "array",
                      description: "Per-chain gas data, cheapest first.",
                      items: {
                        type: "object",
                        properties: {
                          chain: { type: "string", example: "base" },
                          label: { type: "string", example: "Base" },
                          chainId: { type: "integer", example: 8453 },
                          blockNumber: { type: "string", example: "49106604" },
                          baseFeePerGas: { type: "string", example: "0.005" },
                          gasPrice: { type: "string", example: "0.006" },
                          estimatedCost: {
                            type: "object",
                            properties: {
                              gasLimit: { type: "integer", example: 21000 },
                              gwei: { type: "string", example: "126" },
                              eth: {
                                type: "string",
                                example: "0.000000126",
                              },
                              usd: {
                                type: ["string", "null"],
                                description:
                                  "Estimated cost in US dollars. All four chains pay gas in ETH, so one ETH/USD price covers them. Null if the price is unavailable.",
                                example: "0.0003339",
                              },
                            },
                          },
                        },
                      },
                    },
                    cheapest: {
                      type: "string",
                      description: "Key of the cheapest chain.",
                      example: "base",
                    },
                    baseRank: {
                      type: "integer",
                      description: "Base's position in the ranking, 1 = cheapest.",
                      example: 1,
                    },
                    baseVsEthereum: {
                      type: "string",
                      example: "Base is 240.5x cheaper than Ethereum",
                    },
                    ethUsd: {
                      type: ["object", "null"],
                      description:
                        "ETH/USD price used for the usd figures, read on-chain from the Chainlink ETH/USD feed on Base. Null when the feed cannot be read or is stale, in which case every usd field is null too.",
                      properties: {
                        price: { type: "string", example: "2650.12" },
                        source: { type: "string", example: "chainlink-eth-usd-base" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                    unavailable: {
                      type: "array",
                      description: "Chains whose RPC did not respond.",
                      items: {
                        type: "object",
                        properties: {
                          chain: { type: "string" },
                          reason: { type: "string" },
                        },
                      },
                    },
                    fetchedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          402: { description: "Payment Required" },
        },
      },
    },
    "/gas/history": {
      get: {
        summary:
          "Historical Base gas prices with trend statistics and a cheap/normal/expensive verdict (paid via x402)",
        description:
          `Returns historical Base mainnet gas prices over a lookback window, sampled continuously from the chain, together with min, max, average, and median gas price for that window and a verdict on whether gas is currently cheap, normal, or expensive relative to it. A live RPC call reports the current price but cannot say whether it is high or low; this endpoint can, because it has been watching. Common uses: decide whether to transact now or wait, detect congestion spikes on Base, chart Base gas trends over time, set gas budgets from real observed data, and backtest agent transaction timing. Every response includes a coverage object stating exactly how much history backs it. Check the free GET /health route first to see current coverage. Each call costs ${HISTORY_PRICE_USD} USDC settled on Base mainnet (eip155:8453) via x402.`,
        operationId: "getGasHistory",
        parameters: [
          {
            name: "hours",
            in: "query",
            required: false,
            description:
              "Lookback window in hours. Defaults to 24.",
            schema: {
              type: "integer",
              minimum: MIN_HOURS,
              maximum: MAX_HOURS,
              default: 24,
              example: 24,
            },
          },
        ],
        "x-payment-info": {
          price: {
            mode: "fixed",
            currency: "USD",
            amount: HISTORY_PRICE_AMOUNT,
          },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: {
            description: "Gas history for the window (payment accepted).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    chain: { type: "string", example: "base-mainnet" },
                    chainId: { type: "integer", example: 8453 },
                    requestedHours: { type: "integer", example: 24 },
                    units: { type: "string", example: "gwei" },
                    currentGasPrice: { type: "number", example: 0.006 },
                    verdict: {
                      type: "string",
                      enum: ["cheap", "normal", "expensive", "flat"],
                      description:
                        "Where the current gas price sits within the window's range. Returns `flat` when the window's spread is under 1%, which on Base is common: the chain sits on its fee floor for hours and there is nothing to time.",
                      example: "flat",
                    },
                    verdictNote: {
                      type: "string",
                      description:
                        "Plain-language explanation of the verdict, including the observed spread.",
                      example:
                        "Gas has not moved meaningfully in this window (spread 0.0067%, below the 1% threshold). There is nothing to wait for.",
                    },
                    spreadPercent: {
                      type: "number",
                      description:
                        "Width of the window's range as a percentage of its minimum. Below 1% the verdict is reported as `flat`.",
                      example: 0.0067,
                    },
                    summary: {
                      type: "object",
                      properties: {
                        min: { type: "number", example: 0.005 },
                        max: { type: "number", example: 0.031 },
                        avg: { type: "number", example: 0.009 },
                        median: { type: "number", example: 0.007 },
                      },
                    },
                    samples: {
                      type: "array",
                      description: "Time series, oldest first.",
                      items: {
                        type: "object",
                        properties: {
                          t: { type: "string", format: "date-time" },
                          baseFee: { type: "number", example: 0.005 },
                          gasPrice: { type: "number", example: 0.006 },
                          priorityMedium: { type: "number", example: 0.001 },
                        },
                      },
                    },
                    coverage: {
                      type: "object",
                      description:
                        "How much history actually backs this response.",
                      properties: {
                        samples: { type: "integer", example: 288 },
                        hoursCovered: { type: "number", example: 24 },
                        retentionHours: { type: "integer", example: 168 },
                      },
                    },
                    fetchedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          402: { description: "Payment Required" },
        },
      },
    },
    "/gas/cheapest-window": {
      get: {
        summary:
          "Cheapest hours of day to transact on Base, from observed gas history (paid via x402)",
        description:
          `Identifies the cheapest hours of day to transact on Base, computed from continuously collected gas history. Returns average gas price bucketed by hour of day in UTC and ranked cheapest first, plus the cheapest hour, the priciest hour, and the percentage saved by waiting for the cheap window. Common uses: schedule batch transactions for cheap gas, time an NFT mint or airdrop, plan agent workloads around low-fee hours, cut gas spend on recurring on-chain jobs, and answer when should I send this transaction. This cannot be derived from a single RPC call at any price, because it requires historical observation. Every response includes a coverage object; with less than a full day of history the hourly ranking is provisional. Check the free GET /health route first. Each call costs ${WINDOW_PRICE_USD} USDC settled on Base mainnet (eip155:8453) via x402.`,
        operationId: "getCheapestWindow",
        parameters: [
          {
            name: "hours",
            in: "query",
            required: false,
            description:
              "Lookback window in hours used to compute hourly averages. Defaults to 168 (7 days).",
            schema: {
              type: "integer",
              minimum: MIN_HOURS,
              maximum: MAX_HOURS,
              default: 168,
              example: 168,
            },
          },
        ],
        "x-payment-info": {
          price: {
            mode: "fixed",
            currency: "USD",
            amount: WINDOW_PRICE_AMOUNT,
          },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: {
            description: "Hourly gas ranking (payment accepted).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    chain: { type: "string", example: "base-mainnet" },
                    chainId: { type: "integer", example: 8453 },
                    requestedHours: { type: "integer", example: 168 },
                    units: { type: "string", example: "gwei" },
                    hasDailyCycle: {
                      type: "boolean",
                      description:
                        "Whether the chain actually has a usable daily gas cycle in this window. False means timing by hour of day saves nothing, and the ranking below is not actionable.",
                      example: false,
                    },
                    recommendation: {
                      type: "string",
                      description:
                        "The headline answer in plain language, so the caller does not have to infer it from the ranking.",
                      example:
                        "No meaningful daily gas cycle on this chain: the gap between the cheapest and priciest hour is 0%. Timing a transaction by hour of day will not save anything.",
                    },
                    hourlyAverages: {
                      type: "array",
                      description:
                        "Hour-of-day averages, cheapest first. Only actionable when hasDailyCycle is true.",
                      items: {
                        type: "object",
                        properties: {
                          hourUtc: { type: "integer", example: 6 },
                          samples: { type: "integer", example: 84 },
                          avgGasPrice: { type: "number", example: 0.005 },
                        },
                      },
                    },
                    savingsVsAveragePercent: {
                      type: ["number", "null"],
                      description:
                        "Percent saved by transacting in the cheapest hour instead of the average hour. The everyday figure: savingsPercent compares with the single worst hour and can be dominated by one spike.",
                      example: 1.02,
                    },
                    avoidHoursUtc: {
                      type: "array",
                      items: { type: "integer" },
                      description:
                        "Hours of day (UTC) whose average gas is at least 5% above the median hour, worst first. Empty when there is no daily cycle.",
                      example: [8, 14],
                    },
                    savingsUsd: {
                      type: ["object", "null"],
                      description:
                        "The savings in US dollars for one plain transfer (21000 gas), using the Chainlink ETH/USD feed on Base. Null if the price is unavailable.",
                      properties: {
                        gasLimit: { type: "integer", example: 21000 },
                        vsPriciestHour: { type: "string", example: "0.00006236" },
                        vsAverageHour: { type: "string", example: "0.000003488" },
                      },
                    },
                    cheapestHourUtc: { type: "integer", example: 6 },
                    priciestHourUtc: { type: "integer", example: 14 },
                    savingsPercent: {
                      type: "number",
                      description:
                        "Percent saved by transacting in the cheapest hour instead of the priciest. Read it together with daysObserved and confidence: a large figure from a single day is one spike, not a rhythm.",
                      example: 79.1,
                    },
                    daysObserved: {
                      type: "number",
                      description:
                        "How many times the hour driving savingsPercent has actually been observed. 1 means the window covers a single day.",
                      example: 1,
                    },
                    confidence: {
                      type: "string",
                      enum: ["single-day", "provisional", "pattern"],
                      description:
                        "How much weight savingsPercent deserves. `single-day` is one observed spike, `provisional` is two days, `pattern` is three or more.",
                      example: "single-day",
                    },
                    hoursObserved: { type: "integer", example: 24 },
                    coverage: {
                      type: "object",
                      properties: {
                        samples: { type: "integer", example: 2016 },
                        hoursCovered: { type: "number", example: 168 },
                        retentionHours: { type: "integer", example: 168 },
                      },
                    },
                    fetchedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          402: { description: "Payment Required" },
        },
      },
    },
    "/health": {
      get: {
        summary: "Service health and gas history coverage (free)",
        description:
          "Free health check. Reports service uptime and, more usefully, exactly how much gas history has been collected so far: sample count, hours covered, sampling interval, and retention. Call this before paying for /gas/history or /gas/cheapest-window to confirm the coverage is deep enough for your use case. No payment or wallet required. The response also carries a nextSteps object with ready-to-run commands, so a first-time caller is not left holding raw JSON with nowhere to go.",
        operationId: "getHealth",
        // An empty security array is how OpenAPI declares an operation as
        // explicitly public. Without it, discovery cannot tell "free" apart
        // from "auth mode forgotten" and warns on both L2 and L3.
        security: [],
        responses: {
          200: {
            description: "Service status and history coverage.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    uptimeSeconds: { type: "number", example: 3600 },
                    whatIsThis: {
                      type: "string",
                      description:
                        "Plain-language explanation of this route, for callers who reach it first.",
                    },
                    nextSteps: {
                      type: "object",
                      description:
                        "Ready-to-run commands and links for going from this status check to actual gas data.",
                      properties: {
                        website: { type: "string" },
                        seeThe402ChallengeForFree: { type: "string" },
                        getGasData: { type: "string" },
                        needAWallet: { type: "string" },
                        allRoutesAndPrices: { type: "string" },
                        machineReadableSpec: { type: "string" },
                      },
                    },
                    history: {
                      type: "object",
                      properties: {
                        samples: { type: "integer", example: 288 },
                        hoursCovered: { type: "number", example: 24 },
                        oldestSample: { type: "string", format: "date-time" },
                        newestSample: { type: "string", format: "date-time" },
                        sampleIntervalSeconds: { type: "integer", example: 300 },
                        retentionHours: { type: "integer", example: 168 },
                        totalSamplesTaken: { type: "integer", description: "Samples taken since this process started.", example: 12 },
                        durable: { type: "boolean", description: "Whether history survives a redeploy (Redis backing configured).", example: true },
                        lastError: { type: ["string", "null"], description: "Last sampling error, null when the latest sample succeeded.", example: null },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
