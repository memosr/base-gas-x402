// Static responses for the free GET / and favicon routes.

// GET / serves a one-line pointer to the public site. The marketing and
// documentation site lives at SITE_URL and is deployed separately. The two
// verification meta tags below must stay on this origin.
export const SITE_URL = "https://base-gas-x402.vercel.app";

export const LANDING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="talentapp:project_verification" content="c305bf15e9cb197df5136336c90c58273e8bb0e372e5c4a821d40e2a96ed2d7f843902f75c5ffcc0c4b3243fe26cab9d77ebe957d5487389e09e6c8804356292">
<meta name="base:app_id" content="6a39a0374c49dc5fd7753e72" />
<meta name="description" content="Pay-per-call gas oracle for Base mainnet, gated with the x402 payment protocol. Documentation at ${SITE_URL}" />
<link rel="canonical" href="${SITE_URL}" />
<title>base-gas-x402</title>
<style>
  body { margin: 0; background: #0b0e14; color: #e6e9ef;
    font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; }
  main { max-width: 620px; margin: 0 auto; padding: 4rem 1.25rem; }
  h1 { margin: 0 0 .75rem; font-size: 1.5rem; letter-spacing: -0.02em; }
  p { margin: 0 0 1rem; color: #9aa3b2; }
  a { color: #5b8cff; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; color: #e6e9ef; }
</style>
</head>
<body>
<main>
  <h1>base-gas-x402</h1>
  <p>Pay-per-call gas oracle for Base mainnet, gated with the x402 payment protocol.</p>
  <p>Documentation and setup: <a href="${SITE_URL}">${SITE_URL}</a></p>
  <p>Machine-readable: <a href="/openapi.json"><code>GET /openapi.json</code></a>,
     <a href="/info"><code>GET /info</code></a>,
     <a href="/health"><code>GET /health</code></a></p>
</main>
</body>
</html>`;

// Directories and agent clients render an origin's favicon next to its listing.
// Serving one clears the FAVICON_MISSING discovery warning.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0b0e14"/>
  <circle cx="32" cy="32" r="18" fill="none" stroke="#5b8cff" stroke-width="4"/>
  <path d="M32 20 L32 32 L41 38" fill="none" stroke="#5b8cff" stroke-width="4" stroke-linecap="round"/>
</svg>`;
