# base-gas-x402

A pay-per-call HTTP API that serves **live Base mainnet gas data**, gated with
the [x402](https://x402.org) payment protocol. Each call to the gas endpoint
costs **$0.001 USDC** on Base mainnet, settled through the Coinbase CDP
production facilitator — no API keys, accounts, or subscriptions for callers,
just an on-chain micropayment per request.

## How it works

The service exposes two routes:

- **`GET /`** — Free service description. Returns the endpoint list and payment
  metadata as JSON. No payment required.
- **`GET /gas`** — Paid. Returns live Base mainnet gas data for **$0.001 USDC**
  on Base mainnet (`eip155:8453`).

`GET /gas` follows the standard x402 flow:

1. A request without payment receives **HTTP 402 Payment Required** with a
   `payment-required` header describing the price, network, asset, and
   `payTo` address.
2. The client signs an EIP-712 payment authorization and retries with an
   `X-PAYMENT` header.
3. Payment is verified and settled on Base mainnet through the **Coinbase CDP
   production facilitator** (`https://api.cdp.coinbase.com/platform/v2/x402`).
   On success, the server returns **HTTP 200** with the gas data and an
   `X-PAYMENT-RESPONSE` settlement receipt header.

The paywall middleware runs before the handler, so gas data is only fetched
after a valid payment clears. The resource also publishes x402 Bazaar
discovery metadata so agents can find and consume it automatically.

## Live demo

A live instance is deployed at:

**https://base-gas-x402-production.up.railway.app**

```bash
# Free service description
curl https://base-gas-x402-production.up.railway.app/

# Paid gas endpoint (returns HTTP 402 without payment)
curl -i https://base-gas-x402-production.up.railway.app/gas
```

## curl example: the 402 challenge

Calling the paid endpoint without payment returns a `402` and the payment
requirements in the `payment-required` header (base64-encoded, truncated below):

```bash
curl -i https://base-gas-x402-production.up.railway.app/gas
```

```http
HTTP/2 402
content-type: application/json; charset=utf-8
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVk... (truncated)
x-powered-by: Express

{}
```

Decoding the `payment-required` header reveals the accepted payment terms:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "1000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x0D083590c048A243e24a75E3a7C968145DE25B44",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USD Coin", "version": "2" }
    }
  ]
}
```

`amount` is in atomic USDC units (USDC has 6 decimals), so `1000` = $0.001.

## Response: `GET /gas`

After a successful payment, `/gas` returns live, on-chain Base mainnet gas
data read directly from the network (nothing is fabricated):

```json
{
  "chain": "base-mainnet",
  "chainId": 8453,
  "rpcUrl": "https://mainnet.base.org",
  "blockNumber": "12345678",
  "units": { "fees": "gwei", "cost": "gwei + ETH" },
  "baseFeePerGas": "0.012",
  "priorityFeePerGas": {
    "low": "0.001",
    "medium": "0.002",
    "high": "0.004"
  },
  "gasPrice": "0.014",
  "estimatedTransferCost": {
    "gasLimit": 21000,
    "basis": "baseFee + medium priority fee",
    "gwei": "294",
    "eth": "0.000000294"
  },
  "fetchedAt": "2026-06-22T00:00:00.000Z"
}
```

### Field reference

| Field | Description |
| --- | --- |
| `chain` | Chain name (`base-mainnet`). |
| `chainId` | EVM chain ID (`8453`). |
| `rpcUrl` | RPC endpoint the data was read from. |
| `blockNumber` | Latest block number used for the reading. |
| `units` | Unit hints — fees are in **gwei**; cost is in gwei and ETH. |
| `baseFeePerGas` | Current block base fee, in gwei. |
| `priorityFeePerGas.low` / `.medium` / `.high` | Priority fee tiers in gwei, derived from the 25th / 50th / 90th reward percentiles averaged over the last 10 blocks. |
| `gasPrice` | Network gas price (`eth_gasPrice`), in gwei. |
| `estimatedTransferCost.gasLimit` | Gas units for a plain ETH transfer (`21000`). |
| `estimatedTransferCost.basis` | How the estimate is computed (`baseFee + medium priority fee`). |
| `estimatedTransferCost.gwei` | Estimated transfer cost in gwei. |
| `estimatedTransferCost.eth` | Estimated transfer cost in ETH. |
| `fetchedAt` | ISO-8601 timestamp of the reading. |

## Buyer example

`src/buyer.js` is a complete x402 client that pays the live `/gas` endpoint and
prints the result. Run it with:

```bash
npm run buyer
```

It performs the full payment flow:

1. **Probe** — `GET /gas` without payment and shows the `402` challenge and the
   advertised payment requirements.
2. **Pay** — wraps `fetch` with x402, transparently signs an EIP-712
   authorization with the buyer's key, retries with the `X-PAYMENT` header, and
   prints the `200` gas data plus the settlement receipt (tx hash, payer,
   settled amount) from the `X-PAYMENT-RESPONSE` header.

> [!WARNING]
> The buyer requires `BUYER_PRIVATE_KEY` — a **funded Base mainnet private key
> holding USDC**. **Every run spends a real $0.001 USDC on-chain.** The key is
> read only from the environment and is never logged or printed; only the
> derived public address is shown. Never commit a real key.

By default the buyer targets the live deployment. Override it with `TARGET_URL`
(e.g. point it at your local server).

## Run locally

### 1. Install

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values:

| Variable | Required | Description |
| --- | --- | --- |
| `PAY_TO_ADDRESS` | Yes | Base mainnet address that receives payments. |
| `CDP_API_KEY_ID` | Yes | Coinbase CDP API key ID (production facilitator). |
| `CDP_API_KEY_SECRET` | Yes | Coinbase CDP API key secret. |
| `BASE_MAINNET_RPC_URL` | No | Base mainnet RPC (defaults to `https://mainnet.base.org`). |
| `PORT` | No | Server port (defaults to `4021`). |

The CDP API key is required because the production (mainnet) facilitator signs
each verify/settle request. Create a **Secret API Key** at
[portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/).

### 3. Start

```bash
npm start
# base-gas-x402 listening on http://localhost:4021
```

The server logs the free and paid routes once it's listening.

## Environment & security

- `.env` is **never committed** — it is listed in `.gitignore`.
- The **CDP API key secret** and the **buyer private key** are secrets. Keep
  them out of source control and out of logs.
- The buyer reads `BUYER_PRIVATE_KEY` from the environment only and never echoes
  the key value.

## Tech

- **Runtime:** Node.js (ESM)
- **Server:** [Express](https://expressjs.com/) 5
- **Payments:** [`@x402/express`](https://www.npmjs.com/package/@x402/express),
  [`@x402/core`](https://www.npmjs.com/package/@x402/core),
  [`@x402/evm`](https://www.npmjs.com/package/@x402/evm),
  [`@x402/extensions`](https://www.npmjs.com/package/@x402/extensions) (Bazaar
  discovery), [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) (buyer),
  and the [`@coinbase/x402`](https://www.npmjs.com/package/@coinbase/x402) CDP
  facilitator config
- **Chain access:** [viem](https://viem.sh/) reading Base mainnet
- **Payment asset:** USDC on Base mainnet —
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## What is x402?

x402 is an open protocol that revives the HTTP `402 Payment Required` status
code to enable per-request payments — letting clients (including autonomous
agents) pay for API calls with stablecoins, no accounts or API keys needed.
Learn more at [x402.org](https://x402.org) and the
[Coinbase CDP docs](https://docs.cdp.coinbase.com/).

## License

[MIT](./LICENSE) © memosr
