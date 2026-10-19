import { RETENTION_HOURS } from "./history.js";

// Payment terms and request bounds, shared by the paywall, the OpenAPI
// document and the free /info route so the three can never disagree.

// Payment is verified and settled on Base mainnet (eip155:8453) through the
// Coinbase CDP production facilitator. The gas data itself also comes from
// Base mainnet (see gas.js).
export const PAYMENT_NETWORK = "eip155:8453";
export const FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

// Price per /gas call, in USD. Overridable via GAS_PRICE_USD so pricing can be
// tuned from the host env without a code change. Comparable Base gas endpoints
// on x402 sit between $0.001 and $0.10. The default matches the live price, so
// removing the env variable never silently changes what callers pay.
export const GAS_PRICE_USD = process.env.GAS_PRICE_USD || "0.002";

if (!/^\d+(\.\d+)?$/.test(GAS_PRICE_USD) || Number(GAS_PRICE_USD) <= 0) {
  throw new Error(
    `GAS_PRICE_USD must be a positive decimal number, got "${GAS_PRICE_USD}"`,
  );
}

// Price per /gas/compare call. Higher than /gas because it reads four chains.
export const COMPARE_PRICE_USD = process.env.COMPARE_PRICE_USD || "0.01";

if (!/^\d+(\.\d+)?$/.test(COMPARE_PRICE_USD) || Number(COMPARE_PRICE_USD) <= 0) {
  throw new Error(
    `COMPARE_PRICE_USD must be a positive decimal number, got "${COMPARE_PRICE_USD}"`,
  );
}

// Price per /gas/history call. Higher than /gas because the value comes from
// data collected over time, not from a single RPC read anyone can do for free.
export const HISTORY_PRICE_USD = process.env.HISTORY_PRICE_USD || "0.01";

// Price per /gas/cheapest-window call. The most derived answer on the service:
// it turns raw history into a scheduling decision.
export const WINDOW_PRICE_USD = process.env.WINDOW_PRICE_USD || "0.02";

for (const [name, value] of [
  ["HISTORY_PRICE_USD", HISTORY_PRICE_USD],
  ["WINDOW_PRICE_USD", WINDOW_PRICE_USD],
]) {
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive decimal number, got "${value}"`);
  }
}

// Display form ("$0.002") for the x402 accepts block and the landing page.
export const GAS_PRICE = `$${GAS_PRICE_USD}`;
export const COMPARE_PRICE = `$${COMPARE_PRICE_USD}`;
export const HISTORY_PRICE = `$${HISTORY_PRICE_USD}`;
export const WINDOW_PRICE = `$${WINDOW_PRICE_USD}`;
// OpenAPI x-payment-info wants decimal USD with fixed precision.
export const GAS_PRICE_AMOUNT = Number(GAS_PRICE_USD).toFixed(6);
export const COMPARE_PRICE_AMOUNT = Number(COMPARE_PRICE_USD).toFixed(6);
export const HISTORY_PRICE_AMOUNT = Number(HISTORY_PRICE_USD).toFixed(6);
export const WINDOW_PRICE_AMOUNT = Number(WINDOW_PRICE_USD).toFixed(6);

// Bounds for the shared `hours` lookback parameter.
export const MIN_HOURS = 1;
// Same validated value the sampler uses, so the two can never disagree.
export const MAX_HOURS = RETENTION_HOURS;
