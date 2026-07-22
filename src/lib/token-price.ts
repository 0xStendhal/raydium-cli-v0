import { loadConfig } from "./config-manager";
import { getApiUrlsForCluster } from "./api-urls";

/**
 * Fetch token USD prices. Primary source is the Raydium price API, which works
 * over plain HTTP on any setup; the DAS getAssetBatch RPC (Helius-compatible)
 * is used as a fallback for any mints Raydium doesn't price. Returns a Map of
 * mint address -> price (USD). On errors, returns whatever was gathered.
 */
export async function getTokenPrices(
  mintAddresses: string[]
): Promise<Map<string, number | null>> {
  const prices = new Map<string, number | null>();
  const uniqueMints = Array.from(new Set(mintAddresses)).filter(Boolean);
  if (uniqueMints.length === 0) return prices;

  // Pricing is always best-effort: any failure (including config load) yields
  // an empty/partial map rather than throwing, so callers can render without it.
  try {
    const config = await loadConfig({ createIfMissing: true });

    await fetchRaydiumPrices(uniqueMints, config.cluster, prices);

    const missing = uniqueMints.filter((mint) => prices.get(mint) == null);
    if (missing.length > 0) {
      await fetchDasPrices(missing, config["rpc-url"], prices);
    }
  } catch {
    // Leave whatever prices were gathered.
  }

  return prices;
}

async function fetchRaydiumPrices(
  mints: string[],
  cluster: "mainnet" | "devnet",
  prices: Map<string, number | null>
): Promise<void> {
  try {
    const api = getApiUrlsForCluster(cluster);
    const url = `${api.BASE_HOST}${api.MINT_PRICE}?mints=${mints.join(",")}`;
    const response = await fetch(url);
    if (!response.ok) return;
    const json = (await response.json()) as {
      success?: boolean;
      data?: Record<string, string | number | null>;
    };
    if (!json?.success || !json.data) return;
    for (const [mint, raw] of Object.entries(json.data)) {
      const price = typeof raw === "string" ? Number(raw) : raw;
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        prices.set(mint, price);
      }
    }
  } catch {
    // Network error or unexpected shape — leave these mints for the fallback.
  }
}

async function fetchDasPrices(
  mints: string[],
  rpcUrl: string,
  prices: Map<string, number | null>
): Promise<void> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "token-prices",
        method: "getAssetBatch",
        params: { ids: mints }
      })
    });

    const json = await response.json();
    const results = json?.result;
    if (!Array.isArray(results)) return;

    for (const asset of results) {
      const mint = asset?.id;
      const pricePerToken = asset?.token_info?.price_info?.price_per_token;
      if (mint && typeof pricePerToken === "number" && Number.isFinite(pricePerToken)) {
        prices.set(mint, pricePerToken);
      }
    }
  } catch {
    // RPC doesn't support DAS or network error — leave as-is.
  }
}
