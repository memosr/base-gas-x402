# base-gas-x402

Pay-per-call API serving **live Base mainnet gas data**, gated with the
[x402](https://x402.org) payment protocol (x402 v2). Each `/gas` call costs
**$0.001**, settled in USDC on **Base mainnet** (`eip155:8453`) via the
**Coinbase CDP production facilitator**.

The `/gas` resource is also published to the [x402 Bazaar](https://x402.org)
discovery index, so x402-aware agents can find it and pay for it automatically.

## Endpoints

| Method | Path   | Price   | Description                                              |
| ------ | ------ | ------- | -------------------------------------------------------- |
| GET    | `/`    | free    | Service description and pricing.                         |
| GET    | `/gas` | $0.001  | Live Base mainnet gas data (paywalled with x402).        |

`GET /gas` returns the current base fee, low/medium/high priority fee tiers
(gwei), the current gas price (gwei), and the estimated cost of a 21,000-gas
ETH transfer (in gwei and ETH). All values are read live from Base mainnet.

The paywall middleware runs **before** the handler, so an unpaid request —
including the empty request a Bazaar crawler sends — gets a `402` with the
payment requirements and discovery metadata, and no gas data is fetched.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values below
```

Environment variables (`.env`) — loaded automatically via `dotenv`. `.env` is
git-ignored; never commit it.

| Variable               | Default                     | Notes                                                          |
| ---------------------- | --------------------------- | -------------------------------------------------------------- |
| `PAY_TO_ADDRESS`       | _(required)_                | Base mainnet address that receives x402 payments.             |
| `CDP_API_KEY_ID`       | _(required)_                | Coinbase CDP API key ID for the mainnet facilitator.          |
| `CDP_API_KEY_SECRET`   | _(required)_                | Coinbase CDP API key secret for the mainnet facilitator.      |
| `BASE_MAINNET_RPC_URL` | `https://mainnet.base.org`  | RPC endpoint used to read mainnet gas data.                   |
| `PORT`                 | `4021`                      | HTTP port.                                                     |

Create a CDP **Secret API Key** at <https://portal.cdp.coinbase.com/>. The
production facilitator (`https://api.cdp.coinbase.com/platform/v2/x402`) requires
every verify/settle request to be signed with this key — that's what
`@coinbase/x402`'s `createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)`
wires up.

## Run

```bash
npm start
# base-gas-x402 listening on http://localhost:4021
```

## Test

The free root endpoint works without payment:

```bash
curl http://localhost:4021/
```

A request to `/gas` **without** an x402 payment returns **HTTP 402 Payment
Required**, along with the payment requirements the client must satisfy:

```bash
curl -i http://localhost:4021/gas
# HTTP/1.1 402 Payment Required
```

The 402 body / `accepts` entry advertises payment on Base mainnet
(`network: eip155:8453`) in USDC
(`asset: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `amount: 1000` = $0.001 at
6 decimals) to your `payTo` address.

To actually retrieve the gas data, use an x402-aware client (e.g. an `x402`
fetch wrapper or an agent wallet) that reads the 402 challenge, pays $0.001 on
Base mainnet, and retries with the `X-PAYMENT` header. The Coinbase CDP
facilitator verifies and settles the payment.

## Mainnet / CDP facilitator notes

- Network: `eip155:8453` (Base mainnet). The EVM `exact` scheme is registered
  for this network.
- Facilitator: Coinbase CDP production facilitator via `@coinbase/x402`
  (`createFacilitatorConfig`), composed into `HTTPFacilitatorClient` from
  `@x402/core/server`. Follows Coinbase's "x402 — Running on Mainnet" guide.
- Discovery: the `/gas` route declares a Bazaar discovery extension
  (`@x402/extensions/bazaar` `declareDiscoveryExtension`) plus `description`,
  `mimeType: application/json`, `serviceName`, and `tags`
  (`["gas", "base", "fees", "infrastructure"]`).
