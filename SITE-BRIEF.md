# base-gas-x402: Website Brief

A build brief for whoever implements the marketing/documentation site. Everything in this document is verified against the running service. Do not invent numbers, benchmarks, testimonials, or claims that are not here.

---

## 1. What already exists

| Thing | Where |
|---|---|
| Live API | https://base-gas-x402-production.up.railway.app |
| API source | https://github.com/memosr/base-gas-x402 |
| Agent skill | https://github.com/memosr/base-gas-skill |
| MCP server | https://www.npmjs.com/package/base-gas-mcp |
| OpenAPI spec | https://base-gas-x402-production.up.railway.app/openapi.json |
| Free health route | https://base-gas-x402-production.up.railway.app/health |

There is already a minimal dark landing page served at `/` by the API itself. It is out of date: it only mentions one endpoint. The new site replaces it as the public face. **Do not host the new site on the API process.** Deploy it separately (Vercel or similar) so the API stays a plain, fast Node service. The `/` route on the API should later be reduced to a redirect or a one-line pointer.

---

## 2. What the product is, in one sentence

A pay-per-call gas oracle for Base mainnet that AI agents can use without an API key, a signup, or a subscription: they pay a fraction of a cent in USDC per request over the x402 protocol.

**Audience, in priority order:**

1. Developers building AI agents that transact on Base and need gas awareness
2. Developers evaluating x402 as a way to sell their own APIs, who will read this as a reference implementation
3. Agents themselves, arriving via discovery indexes

Point 3 matters for the build: the site must be readable without JavaScript and must expose plain, crawlable text.

---

## 3. Site structure

Single page is fine. Long scroll, anchored nav. Three required sections, in this order.

### Section A: Introduction

Answer three questions above the fold:

- What is this? A gas oracle for Base.
- Who is it for? AI agents and the developers building them.
- Why is it different from calling an RPC? Because it answers questions an RPC cannot: whether gas is high or low, how Base compares to other chains, and whether waiting would help.

Include a live element if practical: fetch `/health` (free, no auth, CORS permitting) and show real coverage, e.g. "currently tracking Base gas, 191 samples over the last 15.8 hours". If CORS blocks it, fall back to static text rather than faking it.

The `402` status code is a good hook. Most developers have never seen one used for its intended purpose. A short explainer earns attention:

> HTTP 402 Payment Required has been reserved and unused since 1997. x402 finally uses it. Your agent requests data, the server answers 402 with a price, the agent pays in USDC, and the data comes back. One round trip, no account.

### Section B: Setup

Three install paths. Show all three; they serve different readers.

**1. Agent skill (recommended)**

```bash
npx skills add memosr/base-gas-skill --all --yes
```

Then, in the agent: "What is gas on Base right now?"

Note that this requires a funded AgentCash wallet:

```bash
npx agentcash@latest onboard
npx agentcash@latest balance
```

**2. MCP server**

```bash
npx agentcash@latest install -y
npx skills add memosr/base-gas-skill/mcp --all --yes
```

**3. Direct HTTP**

```bash
# Free, no wallet needed
curl -s https://base-gas-x402-production.up.railway.app/health

# Paid
npx agentcash@latest fetch "https://base-gas-x402-production.up.railway.app/gas?gasLimit=180000"
```

Include a "see the 402 for yourself" snippet, because it makes the protocol concrete:

```bash
curl -i https://base-gas-x402-production.up.railway.app/gas
```

### Section C: Advantages and differences

See section 5 below for exactly what may and may not be claimed here. This section must be honest or it undermines the whole product.

---

## 4. The API, verified

Prices are read from `/openapi.json` at build time if possible, so the site cannot drift. If hardcoding, use these and add a line saying the OpenAPI document is the source of truth.

| Route | Price | Returns |
|---|---|---|
| `GET /gas` | $0.005 | Base fee, low/medium/high priority tiers, gas price, cost estimate for any `gasLimit` |
| `GET /gas/compare` | $0.01 | Base, OP Mainnet, Arbitrum One, Ethereum ranked cheapest first |
| `GET /gas/history` | $0.012 | Time series, min/max/avg/median, `verdict`, `verdictNote`, `spreadPercent` |
| `GET /gas/cheapest-window` | $0.02 | `hasDailyCycle`, `recommendation`, hourly averages, `savingsPercent` |
| `GET /health` | free | Sample count, hours covered, sampling interval, retention |

Payment settles in USDC on Base mainnet (`eip155:8453`) through the Coinbase CDP production facilitator.

**Optional parameters:**

- `/gas` and `/gas/compare` accept `gasLimit` (21000 to 30000000, default 21000)
- `/gas/history` and `/gas/cheapest-window` accept `hours` (1 to 168)

**Common gas limits worth showing in a table:** ETH transfer 21000, ERC-20 transfer 65000, NFT mint 85000, Uniswap swap 180000, contract deploy 1500000.

### Real response, `GET /gas/compare`

Use this verbatim as the example. It is an actual response.

```json
{
  "gasLimit": 21000,
  "chains": [
    { "chain": "optimism", "label": "OP Mainnet", "gasPrice": "0.001000371",
      "estimatedCost": { "eth": "0.000000021007791" } },
    { "chain": "base", "label": "Base", "gasPrice": "0.006",
      "estimatedCost": { "eth": "0.000000126" } },
    { "chain": "arbitrum", "label": "Arbitrum One", "gasPrice": "0.02",
      "estimatedCost": { "eth": "0.00000042" } },
    { "chain": "ethereum", "label": "Ethereum", "gasPrice": "0.046909277",
      "estimatedCost": { "eth": "0.000000985094817" } }
  ],
  "cheapest": "optimism",
  "baseRank": 2,
  "baseVsEthereum": "Base is 7.8x cheaper than Ethereum",
  "unavailable": []
}
```

Note that Base is ranked **second**, not first. Keep it that way. Showing a comparison where our own chain loses is a credibility signal, and faking a win would be caught in thirty seconds by anyone who calls the endpoint.

### Real response, `GET /gas/cheapest-window`

```json
{
  "hasDailyCycle": false,
  "recommendation": "No meaningful daily gas cycle on this chain: the gap between the cheapest and priciest hour is 0%. Timing a transaction by hour of day will not save anything. Transact whenever you need to.",
  "savingsPercent": 0
}
```

This is the honest output and it should be shown. See section 5.

---

## 5. Positioning: what may and may not be claimed

This is the most important section of this brief. The market has at least five competing Base gas endpoints. Overclaiming is both dishonest and easily disproved.

### Claims that are true and defensible

**Focused, not a dumping ground.** Five routes that each answer a specific question. Competitors ship 67, 307, and 353 endpoints. The AgentCash discovery validator warns above 40 routes because large surfaces blow past agent token budgets. Fewer, better-documented routes is a real design position, not a limitation.

**Honest about its own data.** `/health` is free and reports exactly how much history exists, so an agent can decide whether paying for a history route is worth it. Every paid response also embeds a `coverage` object. No competitor does this.

**It tells you when the answer is "nothing to do".** When Base sits on its fee floor, `/gas/history` returns `flat` and `/gas/cheapest-window` returns `hasDailyCycle: false` with a plain-language recommendation. Endpoints that always produce a confident "cheapest hour" are selling a decision that cannot be made.

**Priced per operation, not per lookup.** Pass `gasLimit` and get the cost of the actual thing you are about to do, instead of a raw gwei figure you then have to multiply.

**Fails partially rather than totally.** `/gas/compare` reads four chains independently. One unreachable RPC is reported under `unavailable`; it does not take down the response you already paid for.

**Open source, end to end.** API, MCP server, and agent skill are all public and MIT licensed. The skill even includes rules that steer agents away from spending more than they need to.

**Cheapest current-gas endpoint in the category.** `/gas` at $0.005 against competitors at $0.01, $0.013, $0.05, and $0.10. Only claim this for `/gas`; `/gas/history` at $0.012 is *not* the cheapest, there is a $0.001 competitor.

### Claims that must not be made

- **Do not claim to be the only or first Base gas API.** There are several, including multi-chain toolkits that cover seven chains to our one.
- **Do not claim to be the cheapest overall.** It is only true for `/gas`.
- **Do not claim users will save money on gas by timing transactions on Base.** Measured across two independent 15-hour windows, the spread between the cheapest and priciest hour was effectively zero. The product's honest value is telling you that, not promising savings.
- **Do not cite usage numbers, request volumes, or customer counts.** There are none yet. Say nothing rather than implying traction.
- **No fake testimonials, no logo walls, no "trusted by".**
- **Do not promise uptime or an SLA.** Single instance on Railway, no formal guarantee.

### The honest headline

Something in this spirit, rewritten in the site's own voice:

> Gas data for agents on Base. Five endpoints, no API key, paid per call in USDC. Including the one answer nobody else gives you: sometimes there is nothing to optimise.

---

## 6. A section worth including: the debugging writeup

Two non-obvious x402 failure modes were found and fixed while building this, and both are useful to other origin operators. A short technical page or blog post about them is likely to be the site's best traffic source, since it is genuinely novel information.

**1. Missing `trust proxy` silently blocks discovery.** Railway and most PaaS edges terminate TLS and forward plain HTTP. Express then reports `req.protocol` as `http`, x402 advertises an `http://` resource, and Bazaar registration fails hourly with `resource must start with 'https://' when protocol type is http`. Nothing surfaces it: the discovery CLI reports zero warnings and the endpoints stay live and payable, while the index quietly never updates. Fix: `app.set("trust proxy", true)`.

**2. The CDP facilitator size-limits the payment payload and reports it as a schema error.** The bazaar metadata from the 402 challenge is echoed back inside the payment payload. Past a threshold the facilitator returns `'paymentPayload' is invalid: must match one of [x402V2Pay...`. Measured on Base with the same wallet and client: 4188 bytes accepted, 4260 bytes rejected. One endpoint stopped accepting payment purely because its description was longer than the others. Writing better documentation made it unpayable.

Both are reproducible and both cost hours to find. Present them as findings, not as complaints.

---

## 7. Technical requirements

- **Static or statically generated.** Astro, plain HTML, or Next.js static export. No server runtime needed.
- **Deploy target:** Vercel or Cloudflare Pages. Not the Railway API process.
- **No JavaScript required to read the content.** Any live `/health` widget must degrade to static text.
- **Fast.** Under 100 KB of JS. No heavy frameworks, no animation libraries.
- **Accessible.** Real semantic headings, sufficient contrast, keyboard-navigable, working focus states.
- **Responsive.** Read the code blocks on a phone without horizontal scrolling.
- **Every code block copyable** with a copy button.
- **`llms.txt` at the root** summarising the service for agents that fetch it.
- **Open Graph and Twitter card metadata**, since this will mostly be shared on X.
- **Favicon** matching the API's existing one (a simple blue circle-and-clock mark on dark).

---

## 8. Design direction

The existing landing page is dark with a blue accent. Keep that lineage.

- Dark background, near-black, not pure black
- One accent colour, blue, used sparingly
- Monospace for code and all numbers
- Generous whitespace, no cards-within-cards
- The comparison table and the JSON examples are the visual centrepieces; let them breathe
- No stock illustrations, no gradient blobs, no 3D graphics

Tone: technical, plain, slightly dry. The reader is a developer who has seen a hundred crypto landing pages and distrusts all of them. Understatement is the differentiator.

---

## 9. Acceptance criteria

- [ ] All three sections present: introduction, setup, advantages
- [ ] Every command copy-pasteable and verified to run
- [ ] Prices match `/openapi.json` exactly
- [ ] The `/gas/compare` example still shows Base ranked second
- [ ] The `cheapest-window` example still shows `hasDailyCycle: false`
- [ ] No claim from the "must not be made" list appears anywhere
- [ ] Readable with JavaScript disabled
- [ ] Lighthouse performance and accessibility both above 95
- [ ] `llms.txt` present at the root
- [ ] Open Graph image renders correctly when pasted into X

---

## 10. Open questions for the implementer

1. Custom domain, or a `.vercel.app` subdomain to start?
2. Should the docs live on this site, or stay in the GitHub READMEs with the site linking out? Recommendation: link out for now, since the READMEs are already maintained and duplicating them guarantees drift.
3. Is a live `/health` widget worth the CORS work, or is static text with a "check it yourself" curl command enough?
