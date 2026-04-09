import { loadConfig } from "./config-manager";

/**
 * Fetch token USD prices via DAS getAssetBatch (Helius and compatible RPCs).
 * Returns a Map of mint address -> price_per_token (USD).
 * On unsupported RPCs or errors, returns an empty map.
 */
export async function getTokenPrices(
  mintAddresses: string[]
): Promise<Map<string, number | null>> {
  const prices = new Map<string, number | null>();
  if (mintAddresses.length === 0) return prices;

  try {
    const config = await loadConfig({ createIfMissing: true });
    const rpcUrl = config["rpc-url"];

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "token-prices",
        method: "getAssetBatch",
        params: {
          ids: mintAddresses
        }
      })
    });

    const json = await response.json();
    const results = json?.result;
    if (!Array.isArray(results)) return prices;

    for (const asset of results) {
      const mint = asset?.id;
      const pricePerToken = asset?.token_info?.price_info?.price_per_token;
      if (mint && typeof pricePerToken === "number") {
        prices.set(mint, pricePerToken);
      }
    }
  } catch {
    // RPC doesn't support DAS or network error — return empty
  }

  return prices;
}
