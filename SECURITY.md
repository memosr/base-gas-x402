# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
report instead: **Security → Report a vulnerability** on
[memosr/base-gas-x402](https://github.com/memosr/base-gas-x402/security/advisories/new).

Include the route, the request you sent and what you saw. You will get a reply
within 3 days. Fixes are released as soon as they are verified, and reporters
are credited in the commit unless they ask not to be.

## Scope

- The live API at `base-gas-x402-production.up.railway.app`
- This repository, `base-gas-mcp`, `base-gas-skill` and `@memosr/plugin-base-gas`

Especially welcome: anything that gets paid data without paying, charges a
caller for a failed request, leaks a key or RPC URL, or lets a client be made
to pay a different address or amount.

## How payments are protected

- **Server:** HEAD and case or trailing-slash variants of paid routes cannot
  bypass the paywall; requests carrying a payment are rate limited before
  verification; error responses never include internal details.
- **Clients we ship:** the MCP server, the elizaOS plugin and the example
  bridge pay one fixed origin, never a URL taken from a prompt, and refuse any
  payment above a per-call cap before signing.

## Past fixes

| Date | Issue | Fix |
|---|---|---|
| 2026-10 | HEAD requests to paid routes ran the handler unpaid (x402 SDK bug, reported by Frits / x402 Doctor) | 405 on HEAD for paid routes, including case and slash variants |
| 2026-10 | MCP server loaded `.env` from the working directory, so a cloned repo could repoint the wallet | `.env` loading removed in base-gas-mcp 0.3.1 |
| 2026-10 | 502 responses included the upstream RPC error, which could carry an API key | Error details are logged, never returned |
