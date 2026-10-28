import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";

import { getGasData, MIN_GAS_LIMIT, MAX_GAS_LIMIT } from "./gas.js";
import { getGasComparison } from "./compare.js";
import {
  startSampler,
  coverage,
  getHistory,
  getCheapestWindow,
} from "./history.js";
import { isAddress } from "viem";
import { getEthUsd } from "./price.js";
import { paidRateLimit, PAID_PER_MINUTE } from "./ratelimit.js";
import {
  PAYMENT_NETWORK,
  FACILITATOR_URL,
  GAS_PRICE,
  COMPARE_PRICE,
  HISTORY_PRICE,
  WINDOW_PRICE,
  MIN_HOURS,
  MAX_HOURS,
} from "./pricing.js";
import { buildRoutes } from "./routes.js";
import { OPENAPI_DOCUMENT } from "./openapi.js";
import { LANDING_PAGE_HTML, FAVICON_SVG } from "./landing.js";

// Common gas limits, surfaced in the discovery docs so agents know what to pass.
const GAS_LIMIT_PRESETS = {
  "ETH transfer": 21000,
  "ERC-20 transfer": 65000,
  "NFT mint": 85000,
  "Uniswap swap": 180000,
  "contract deploy": 1500000,
};

const PORT = process.env.PORT || 4021;
const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS;
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

if (!PAY_TO_ADDRESS || !isAddress(PAY_TO_ADDRESS, { strict: false })) {
  // Fail fast: without a valid payTo address every payment would be rejected
  // or, worse, settle to the wrong place. Refuse to start instead.
  throw new Error(
    `PAY_TO_ADDRESS must be a valid EVM address, got "${PAY_TO_ADDRESS ?? ""}". Set it in .env or the host's variables.`,
  );
}

if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  // The CDP mainnet facilitator requires signed requests.
  console.warn(
    "[warn] CDP_API_KEY_ID / CDP_API_KEY_SECRET are not set. The CDP facilitator will reject verify/settle calls until you set them in .env",
  );
}

const app = express();

// Railway (like most PaaS edges) terminates TLS and forwards the request to
// this process over plain HTTP. Without this, req.protocol is "http", so the
// x402 middleware advertises the resource as http://... in the 402 challenge.
// The Bazaar discovery registrar rejects that outright:
//   "discovery request validation failed: resource must start with 'https://'
//    when protocol type is http"
// which silently blocks the hourly discovery registration and leaves the
// service stale in x402scan and every index downstream of it.
// Trusting the proxy makes Express read X-Forwarded-Proto, so req.protocol
// becomes "https" and the advertised resource URL matches reality.
app.set("trust proxy", true);

// --- x402 wiring --------------------------------------------------------
// The Coinbase CDP facilitator config carries the production facilitator URL
// (https://api.cdp.coinbase.com/platform/v2/x402) plus the createAuthHeaders
// callback that signs each verify/settle/supported/bazaar request with the
// CDP API key read from CDP_API_KEY_ID / CDP_API_KEY_SECRET. The
// HTTPFacilitatorClient then talks to that hosted facilitator.
const facilitator = new HTTPFacilitatorClient(
  createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET),
);

// The resource server registers the EVM "exact" scheme for Base mainnet, and
// paymentMiddleware gates the matching routes below.
const resourceServer = new x402ResourceServer(facilitator).register(
  PAYMENT_NETWORK,
  new ExactEvmScheme(),
);

const routes = buildRoutes(PAY_TO_ADDRESS);


// --- Free routes --------------------------------------------------------
// GET / serves a one-line pointer to the public site. The marketing and
// documentation site lives at SITE_URL and is deployed separately, so this
// process stays a plain, fast API. Service metadata for JSON clients is at
// GET /info. The two verification meta tags below must stay on this origin.

app.get("/", (_req, res) => {
  res
    .type("html")
    .set("Cache-Control", "public, max-age=300")
    .send(LANDING_PAGE_HTML);
});

// --- Favicon ------------------------------------------------------------
// Directories and agent clients render an origin's favicon next to its listing.
// Serving one clears the FAVICON_MISSING discovery warning.

app.get(["/favicon.svg", "/favicon.ico"], (_req, res) => {
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400");
  res.send(FAVICON_SVG);
});


// Free, public, credential-free routes may be read from any website (the
// project site shows live /health). Paid routes stay same-origin only.
const allowAnyOrigin = (_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
};
app.use(["/health", "/info", "/openapi.json"], allowAnyOrigin);

app.get("/openapi.json", (_req, res) => {
  res.json(OPENAPI_DOCUMENT);
});

// --- Free health route --------------------------------------------------
// Declared BEFORE the paywall so it stays free. Its real job is disclosure:
// history coverage is visible here so agents never pay for /gas/history or
// /gas/cheapest-window only to find the buffer is still warming up.
app.get("/health", (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;

  res.json({
    status: "ok",
    uptimeSeconds: Number(process.uptime().toFixed(0)),

    // A first-time caller reported this response as an error: it is valid JSON
    // with no failure in it, but it also gave them nothing to do next. `/health`
    // is the entry point advertised everywhere, so it has to answer "what now?"
    // as well as "is it up?".
    whatIsThis:
      "Free status endpoint. It reports how much gas history has been collected so far, so you can decide whether the paid history routes are worth calling. It returns no gas data itself and requires no payment or wallet.",

    history: coverage(),

    nextSteps: {
      website: "https://base-gas-x402.vercel.app",
      seeThe402ChallengeForFree: `curl -i ${origin}/gas`,
      getGasData: `npx agentcash@latest fetch "${origin}/gas"`,
      needAWallet: "npx agentcash@latest onboard",
      allRoutesAndPrices: `${origin}/info`,
      machineReadableSpec: `${origin}/openapi.json`,
    },
  });
});

// JSON service description for programmatic clients (was previously at GET /).
app.get("/info", (_req, res) => {
  res.json({
    name: "base-gas-x402",
    description:
      "Pay-per-call API for live Base mainnet gas data, gated with x402.",
    endpoints: {
      "GET /": "HTML landing page (free).",
      "GET /info": "This service description as JSON (free).",
      "GET /gas": `Live Base mainnet gas data. Costs ${GAS_PRICE} per call via x402 on Base mainnet (${PAYMENT_NETWORK}).`,
      "GET /gas/compare": `Live gas comparison across Base, OP Mainnet, Arbitrum One, and Ethereum. Costs ${COMPARE_PRICE} per call via x402 on Base mainnet (${PAYMENT_NETWORK}).`,
      "GET /gas/history": `Historical Base gas prices with trend statistics and a cheap/normal/expensive verdict. Costs ${HISTORY_PRICE} per call.`,
      "GET /gas/cheapest-window": `Cheapest hours of day to transact on Base, from observed history. Costs ${WINDOW_PRICE} per call.`,
      "GET /health": "Service status and gas history coverage (free).",
    },
    payment: {
      protocol: "x402",
      network: PAYMENT_NETWORK,
      facilitator: FACILITATOR_URL,
      prices: {
        "GET /gas": GAS_PRICE,
        "GET /gas/compare": COMPARE_PRICE,
        "GET /gas/history": HISTORY_PRICE,
        "GET /gas/cheapest-window": WINDOW_PRICE,
      },
    },
  });
});

// --- Paywall: applies only to the routes declared above -----------------
// This middleware runs BEFORE the /gas handler, so any request without a
// valid payment — including the empty requests a Bazaar crawler sends — gets
// a 402 with the payment requirements and discovery metadata, and no gas
// data is fetched.
// --- 402 diagnostics -----------------------------------------------------
// When the x402 middleware rejects a payment it answers with an empty JSON body
// and puts the reason in the response headers, which never reaches the operator.
// This logs the decoded reason for any 402 that carries a payment header, so a
// rejected payment is debuggable from the deploy logs instead of invisible.
app.use((req, res, next) => {
  const hadPaymentHeader = Boolean(
    req.get("x-payment") || req.get("payment-signature"),
  );

  res.on("finish", () => {
    if (!hadPaymentHeader) return;

    // Log a compact fingerprint for BOTH accepted and rejected payments. A
    // rejected payload only means something next to an accepted one from the
    // same client, so both are needed to spot the difference.
    const rawPayload = req.get("x-payment") || req.get("payment-signature");
    if (rawPayload) {
      try {
        const payload = JSON.parse(
          Buffer.from(rawPayload, "base64").toString("utf8"),
        );
        // The CDP facilitator rejects oversized payment payloads and reports it
        // as a schema error, which is close to undebuggable in production.
        // Measured on Base: 4188 bytes accepted, 4260 rejected. Warn well before
        // that so a future description edit does not silently break a route.
        const PAYLOAD_WARN_BYTES = 3800;
        if (res.statusCode !== 200 || rawPayload.length > PAYLOAD_WARN_BYTES) {
          console.error(
            `[pay ${res.statusCode}] ${req.path} bytes=${rawPayload.length}` +
              (rawPayload.length > PAYLOAD_WARN_BYTES
                ? ` WARNING: approaching the facilitator payload size limit (~4200). Shorten this route's bazaar description, tags, or output example.`
                : ""),
          );
        }
      } catch {
        console.error(`[pay ${res.statusCode}] ${req.path} payload undecodable`);
      }
    }

    if (res.statusCode !== 402) return;

    const header = res.getHeader("payment-required");
    let reason = "(no payment-required header on the response)";

    if (header) {
      try {
        const decoded = JSON.parse(
          Buffer.from(String(header), "base64").toString("utf8"),
        );
        reason = JSON.stringify({
          error: decoded.error,
          errorMessage: decoded.errorMessage,
          resource: decoded.resource?.url,
        });
      } catch (error) {
        reason = `(could not decode: ${error.message})`;
      }
    }

    console.error(`[402] paid request rejected on ${req.method} ${req.path}: ${reason}`);

    // The facilitator rejects the *client-supplied* payload, so log its shape.
    // Signature material is deliberately not logged: field names and types are
    // enough to tell a malformed payload from a well-formed one.
    const raw = req.get("x-payment") || req.get("payment-signature");
    if (raw) {
      try {
        const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
        const shape = (value) => {
          if (value === null) return "null";
          if (Array.isArray(value)) return `array(${value.length})`;
          if (typeof value !== "object") return typeof value;
          return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, shape(v)]),
          );
        };
        console.error(`[402] client payload shape: ${JSON.stringify(shape(payload))}`);
        console.error(
          `[402] client payload scalars: ${JSON.stringify({
            x402Version: payload.x402Version,
            scheme: payload.scheme,
            network: payload.network,
            resource: payload.resource ?? payload.payload?.resource,
          })}`,
        );
      } catch (error) {
        console.error(`[402] client payload undecodable: ${error.message}`);
      }
    } else {
      console.error("[402] no x-payment header on the request");
    }
  });

  next();
});

// HEAD on a paid route must not run the handler for free. The x402 payment
// middleware (up to @x402/core 2.28.0) matches "GET /gas" only for GET, while
// Express answers HEAD with the GET handler, so HEAD skipped the paywall and
// still triggered the RPC reads behind it. Fixed upstream in
// x402-foundation/x402#3796 but not released yet; refuse HEAD here meanwhile.
// Reported by Frits (x402 Doctor, Fizzl).
// Express routing ignores case and a trailing slash, so /GAS and /gas/ reach the
// /gas handler too: normalize the same way before checking.
const normalizePath = (path) => path.toLowerCase().replace(/\/+$/, "") || "/";
const PAID_PATHS = new Set(Object.keys(routes).map((key) => normalizePath(key.split(" ")[1])));
app.use((req, res, next) => {
  if (req.method === "HEAD" && PAID_PATHS.has(normalizePath(req.path))) {
    return res.set("Allow", "GET").status(405).end();
  }
  next();
});

// Before the paywall, so a limited request gets 429 and is never charged.
// Only requests carrying a payment header count (see ratelimit.js).
app.use(paidRateLimit());

app.use(paymentMiddleware(routes, resourceServer));

// --- Paid route ---------------------------------------------------------
// gasLimit is validated HERE, inside the handler, not in middleware. The
// paywall runs first, so unauthenticated probes still reach a clean 402 instead
// of a 400 (see the "Expected 402, got 400" discovery failure mode).
/**
 * Parses the shared optional `gasLimit` query parameter.
 * Returns `{ gasLimit }` on success or `{ error }` describing what was wrong.
 * `gasLimit` is undefined when the caller omitted it, letting each data module
 * apply its own default.
 */
function parseGasLimit(raw) {
  if (raw === undefined) return { gasLimit: undefined };

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return {
      error: { error: "gasLimit must be an integer", received: raw },
    };
  }

  const gasLimit = BigInt(parsed);
  if (gasLimit < MIN_GAS_LIMIT || gasLimit > MAX_GAS_LIMIT) {
    return {
      error: {
        error: `gasLimit must be between ${MIN_GAS_LIMIT} and ${MAX_GAS_LIMIT}`,
        received: parsed,
        presets: GAS_LIMIT_PRESETS,
      },
    };
  }

  return { gasLimit };
}

app.get("/gas", async (req, res) => {
  const { gasLimit, error: invalid } = parseGasLimit(req.query.gasLimit);
  if (invalid) return res.status(400).json(invalid);

  try {
    const data = await getGasData(gasLimit);
    res.json(data);
  } catch (error) {
    console.error("[/gas] failed to fetch gas data:", error);
    res.status(502).json({
      error: "Failed to fetch Base mainnet gas data",
    });
  }
});

app.get("/gas/compare", async (req, res) => {
  const { gasLimit, error: invalid } = parseGasLimit(req.query.gasLimit);
  if (invalid) return res.status(400).json(invalid);

  try {
    const data = await getGasComparison(gasLimit);

    // Every chain failing means the comparison is meaningless, so surface it as
    // an upstream error instead of returning an empty ranking to a paying caller.
    if (data.chains.length === 0) {
      return res.status(502).json({
        error: "No chain RPC responded",
        unavailable: data.unavailable,
      });
    }

    res.json(data);
  } catch (error) {
    console.error("[/gas/compare] failed to compare gas:", error);
    res.status(502).json({
      error: "Failed to compare gas across chains",
    });
  }
});

/**
 * Parses the shared optional `hours` lookback parameter.
 */
function parseHours(raw, fallback) {
  if (raw === undefined) return { hours: fallback };

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_HOURS || parsed > MAX_HOURS) {
    return {
      error: {
        error: `hours must be an integer between ${MIN_HOURS} and ${MAX_HOURS}`,
        received: raw,
      },
    };
  }

  return { hours: parsed };
}

app.get("/gas/history", (req, res) => {
  const { hours, error: invalid } = parseHours(req.query.hours, 24);
  if (invalid) return res.status(400).json(invalid);

  try {
    res.json(getHistory(hours));
  } catch (error) {
    console.error("[/gas/history] failed:", error);
    res.status(502).json({
      error: "Failed to build gas history",
    });
  }
});

app.get("/gas/cheapest-window", async (req, res) => {
  const { hours, error: invalid } = parseHours(req.query.hours, 168);
  if (invalid) return res.status(400).json(invalid);

  try {
    // getEthUsd never throws; without a price only savingsUsd is null.
    res.json(getCheapestWindow(hours, await getEthUsd()));
  } catch (error) {
    console.error("[/gas/cheapest-window] failed:", error);
    res.status(502).json({
      error: "Failed to compute cheapest window",
    });
  }
});

// Unknown routes answer in JSON, not Express's HTML page: the callers here
// are agents, and a list of what does exist is the useful reply.
app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: `No route ${req.method} ${req.path}.`,
    routes: {
      "GET /gas": GAS_PRICE,
      "GET /gas/compare": COMPARE_PRICE,
      "GET /gas/history": HISTORY_PRICE,
      "GET /gas/cheapest-window": WINDOW_PRICE,
      "GET /health": "free",
      "GET /info": "free",
      "GET /openapi.json": "free",
    },
  });
});

app.listen(PORT, () => {
  console.log(`base-gas-x402 listening on http://localhost:${PORT}`);
  console.log(`  free:  GET /`);
  console.log(`  free:  GET /health`);
  console.log(`  paid:  GET /gas                  (${GAS_PRICE} via x402, ${PAYMENT_NETWORK})`);
  console.log(`  paid:  GET /gas/compare          (${COMPARE_PRICE} via x402, ${PAYMENT_NETWORK})`);
  console.log(`  paid:  GET /gas/history          (${HISTORY_PRICE} via x402, ${PAYMENT_NETWORK})`);
  console.log(`  paid:  GET /gas/cheapest-window  (${WINDOW_PRICE} via x402, ${PAYMENT_NETWORK})`);
  console.log(
    PAID_PER_MINUTE === 0
      ? "  rate limit: off (RATE_LIMIT_PAID_PER_MIN=0)"
      : `  rate limit: ${PAID_PER_MINUTE} paid requests per client per minute`,
  );

  // Start collecting only once the server is actually up, so a boot failure
  // does not leave a sampler running against a half-initialised process.
  // Restoring from Redis makes this async; a failure there must not take down
  // an otherwise healthy server, so it is logged rather than thrown.
  startSampler().catch((error) => {
    console.error("[history] sampler failed to start:", error);
  });
});
