#!/usr/bin/env node
/**
 * Weekly Base gas report: one chart and one post, ready for X.
 *
 *   npm run report                      # buys the data from the live API (about $0.012)
 *   npm run report -- --input week.json # offline, from a saved /gas/history response
 *
 * The wallet key is read from BUYER_PRIVATE_KEY (this folder's .env, or the
 * repo root .env). Payments above $0.05 are refused before signing.
 * Output lands in ./out: report-<date>.png, report-<date>.txt, report-<date>.json.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://base-gas-x402-production.up.railway.app";
const SWAP_GAS = 180_000;
// A reading counts as a spike when gas sits this far above the week's floor.
const SPIKE_PERCENT = 5;
const SAMPLE_MINUTES = 5;

// --- Analysis (pure) ------------------------------------------------------

/**
 * @param {{t: string, gasPrice: number}[]} samples chronological readings, gwei
 */
export function analyze(samples) {
  if (samples.length < 12) throw new Error(`Not enough history for a weekly report (${samples.length} readings).`);
  const prices = samples.map((s) => s.gasPrice);
  const floor = Math.min(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const onFloor = prices.filter((p) => p <= floor * 1.001).length;
  const threshold = floor * (1 + SPIKE_PERCENT / 100);

  // Contiguous runs above the threshold are one spike each.
  const spikes = [];
  let run = null;
  samples.forEach((s, i) => {
    if (s.gasPrice > threshold) {
      if (!run) run = { start: s.t, peak: s.gasPrice, peakAt: s.t, readings: 0 };
      run.readings += 1;
      if (s.gasPrice > run.peak) Object.assign(run, { peak: s.gasPrice, peakAt: s.t });
    }
    if (run && (s.gasPrice <= threshold || i === samples.length - 1)) {
      spikes.push({ ...run, minutes: run.readings * SAMPLE_MINUTES, multiple: run.peak / floor });
      run = null;
    }
  });
  spikes.sort((a, b) => b.peak - a.peak);

  return {
    from: samples[0].t,
    to: samples.at(-1).t,
    readings: samples.length,
    floor,
    avg,
    onFloorPercent: (onFloor / samples.length) * 100,
    aboveFloorPercent: (avg / floor - 1) * 100,
    spikeCount: spikes.length,
    biggest: spikes[0] ?? null,
  };
}

const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const hm = (iso) => new Date(iso).toISOString().slice(11, 16);
const pct = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

/** The post, kept under X's 280 characters. */
export function postText(a, swapUsd) {
  const lines = [
    `Base gas, ${day(a.from)} to ${day(a.to)} (UTC):`,
    "",
    `• ${pct(a.onFloorPercent)}% of ${a.readings.toLocaleString("en-US")} readings sat on the ${a.floor} gwei floor`,
    `• Average week ran ${pct(a.aboveFloorPercent)}% above the floor`,
  ];
  if (a.biggest) {
    lines.push(`• Biggest spike: ${a.biggest.multiple.toFixed(1)}x on ${day(a.biggest.peakAt)} ${hm(a.biggest.peakAt)}, ~${a.biggest.minutes} min`);
  } else {
    lines.push("• No spike above 5% all week");
  }
  if (swapUsd) lines.push(`• A swap costs about $${swapUsd}`);
  lines.push("", "Data: base-gas-x402.vercel.app");
  let text = lines.join("\n");
  if (text.length > 280) text = text.replace(/\n\nData: .*$/, "");
  return text;
}

// --- Chart (SVG -> PNG) -------------------------------------------------------

const C = { bg: "#0b0e14", grid: "#1c2230", text: "#e6e9ef", muted: "#9aa3b2", line: "#5b8cff", floor: "#3ecf8e", spike: "#ff8a5b" };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

export function renderSvg(samples, a) {
  const W = 1200, H = 675, L = 90, R = 40, T = 130, B = 80;
  const t0 = Date.parse(samples[0].t), t1 = Date.parse(samples.at(-1).t);
  // Round axis: 4 equal steps of a "nice" size (1, 1.5, 2, 2.5, 3, 4 or 5 x 10^k) covering the peak.
  const peak = Math.max(...samples.map((s) => s.gasPrice));
  const raw = peak / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 10].map((m) => m * mag).find((v) => v >= raw);
  const yMax = step * 4;
  const yMin = 0;
  const x = (t) => L + ((Date.parse(t) - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  const path = samples.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(s.gasPrice).toFixed(1)}`).join("");

  const yTicks = Array.from({ length: 5 }, (_, i) => step * i);
  const days = [];
  for (let d = new Date(t0); d.getTime() <= t1; d = new Date(d.getTime() + 86_400_000)) {
    const mid = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
    if (mid.getTime() >= t0 && mid.getTime() <= t1) days.push(mid.toISOString());
  }

  const b = a.biggest;
  const callout = b
    ? `<circle cx="${x(b.peakAt).toFixed(1)}" cy="${y(b.peak).toFixed(1)}" r="7" fill="${C.spike}"/>
       <text x="${Math.min(x(b.peakAt) + 14, W - 330).toFixed(1)}" y="${(y(b.peak) + 6).toFixed(1)}" fill="${C.spike}" font-size="22">${esc(`${b.multiple.toFixed(1)}x spike, ${day(b.peakAt)} ${hm(b.peakAt)} UTC`)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, 'DejaVu Sans', sans-serif">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <text x="${L}" y="58" fill="${C.text}" font-size="34" font-weight="bold">Base gas this week</text>
  <text x="${L}" y="96" fill="${C.muted}" font-size="22">${esc(`${day(a.from)} to ${day(a.to)} UTC · ${pct(a.onFloorPercent)}% of readings on the ${a.floor} gwei floor · ${a.spikeCount} spikes above 5%`)}</text>
  ${yTicks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${C.grid}"/>
  <text x="${L - 12}" y="${(y(v) + 7).toFixed(1)}" fill="${C.muted}" font-size="18" text-anchor="end">${+v.toPrecision(6)}</text>`).join("\n  ")}
  ${days.map((d) => `<text x="${x(d).toFixed(1)}" y="${H - B + 34}" fill="${C.muted}" font-size="18" text-anchor="middle">${esc(day(d))}</text>`).join("\n  ")}
  <line x1="${L}" x2="${W - R}" y1="${y(a.floor).toFixed(1)}" y2="${y(a.floor).toFixed(1)}" stroke="${C.floor}" stroke-width="2" stroke-dasharray="8 6"/>
  <text x="${W - R}" y="${(y(a.floor) - 10).toFixed(1)}" fill="${C.floor}" font-size="18" text-anchor="end">floor ${a.floor} gwei</text>
  <path d="${path}" fill="none" stroke="${C.line}" stroke-width="2.5" stroke-linejoin="round"/>
  ${callout}
  <text x="${L - 12}" y="${T - 30}" fill="${C.muted}" font-size="16" text-anchor="end">gwei</text>
  <text x="${W - R}" y="${H - 18}" fill="${C.muted}" font-size="16" text-anchor="end">Sampled every 5 min from Base mainnet · base-gas-x402.vercel.app</text>
</svg>`;
}

// --- Data ----------------------------------------------------------------------

async function buy() {
  const dotenv = await import("dotenv");
  for (const p of [join(HERE, ".env"), join(HERE, "..", "..", ".env")]) if (existsSync(p)) dotenv.config({ path: p, quiet: true });
  const raw = process.env.BUYER_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("BUYER_PRIVATE_KEY is not set (looked in this folder's .env and the repo root .env).");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;

  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm");
  const { privateKeyToAccount } = await import("viem/accounts");
  const client = new x402Client()
    .register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(key)))
    .setSpendControls({ maxAmountPerPayment: "$0.05" });
  const pay = wrapFetchWithPayment(fetch, client);
  const get = async (path) => {
    const res = await pay(`${ORIGIN}${path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return res.json();
  };
  const history = await get("/gas/history?hours=168");
  const gas = await get(`/gas?gasLimit=${SWAP_GAS}`).catch(() => null);
  return { history, swapUsd: gas?.estimatedTransferCost?.usd ?? null };
}

async function main() {
  const i = process.argv.indexOf("--input");
  const { history, swapUsd } =
    i > 0 ? { history: JSON.parse(readFileSync(process.argv[i + 1], "utf8")), swapUsd: null } : await buy();

  const samples = (history.samples ?? []).filter((s) => Number.isFinite(s.gasPrice));
  const a = analyze(samples);
  const svg = renderSvg(samples, a);
  const text = postText(a, swapUsd);

  const { Resvg } = await import("@resvg/resvg-js");
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng();

  const out = join(HERE, "out");
  mkdirSync(out, { recursive: true });
  const stamp = a.to.slice(0, 10);
  writeFileSync(join(out, `report-${stamp}.png`), png);
  writeFileSync(join(out, `report-${stamp}.txt`), `${text}\n`);
  writeFileSync(join(out, `report-${stamp}.json`), `${JSON.stringify({ ...a, swapUsd }, null, 2)}\n`);

  console.log(`${text}\n\n(${text.length} chars)\nSaved to ${join(out, `report-${stamp}.png`)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Report failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
