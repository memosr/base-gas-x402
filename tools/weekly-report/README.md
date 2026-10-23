# Weekly Base gas report

Builds one chart and one post (under 280 characters) from the last 7 days of Base gas, ready to share on X.

```bash
cd tools/weekly-report
npm install
npm run report
```

It buys the data from the live API over x402: `/gas/history?hours=168` ($0.01) and `/gas?gasLimit=180000` ($0.002) for the swap cost. The wallet key comes from `BUYER_PRIVATE_KEY` in this folder's `.env` or the repo root `.env`. Payments above $0.05 are refused before signing.

Output in `out/`:

- `report-<date>.png`: 1200x675 chart, the floor and the biggest spike marked
- `report-<date>.txt`: the post
- `report-<date>.json`: the numbers behind both

Offline, from a saved `/gas/history` response:

```bash
npm run report -- --input week.json
```

This folder has its own dependencies and is not part of the deployed API.
