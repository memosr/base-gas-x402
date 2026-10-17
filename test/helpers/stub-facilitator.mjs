// Preloaded with --import in tests. Answers the CDP facilitator's /supported
// call locally so the server can boot with no network and no CDP keys.
// Everything else goes to the real fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url?.url ?? url);
  if (u.includes("api.cdp.coinbase.com") && u.endsWith("/supported")) {
    return new Response(
      JSON.stringify({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
        extensions: [],
        signers: {},
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  return realFetch(url, init);
};
