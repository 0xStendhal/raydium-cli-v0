"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTokenPrices = void 0;
const config_manager_1 = require("./config-manager");
const api_urls_1 = require("./api-urls");
/**
 * Fetch token USD prices. Primary source is the Raydium price API, which works
 * over plain HTTP on any setup; the DAS getAssetBatch RPC (Helius-compatible)
 * is used as a fallback for any mints Raydium doesn't price. Returns a Map of
 * mint address -> price (USD). On errors, returns whatever was gathered.
 */
async function getTokenPrices(mintAddresses) {
    const prices = new Map();
    const uniqueMints = Array.from(new Set(mintAddresses)).filter(Boolean);
    if (uniqueMints.length === 0)
        return prices;
    // Pricing is always best-effort: any failure (including config load) yields
    // an empty/partial map rather than throwing, so callers can render without it.
    try {
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        await fetchRaydiumPrices(uniqueMints, config.cluster, prices);
        const missing = uniqueMints.filter((mint) => prices.get(mint) == null);
        if (missing.length > 0) {
            await fetchDasPrices(missing, config["rpc-url"], prices);
        }
    }
    catch {
        // Leave whatever prices were gathered.
    }
    return prices;
}
exports.getTokenPrices = getTokenPrices;
async function fetchRaydiumPrices(mints, cluster, prices) {
    try {
        const api = (0, api_urls_1.getApiUrlsForCluster)(cluster);
        const url = `${api.BASE_HOST}${api.MINT_PRICE}?mints=${mints.join(",")}`;
        const response = await fetch(url);
        if (!response.ok)
            return;
        const json = (await response.json());
        if (!json?.success || !json.data)
            return;
        for (const [mint, raw] of Object.entries(json.data)) {
            const price = typeof raw === "string" ? Number(raw) : raw;
            if (typeof price === "number" && Number.isFinite(price) && price > 0) {
                prices.set(mint, price);
            }
        }
    }
    catch {
        // Network error or unexpected shape — leave these mints for the fallback.
    }
}
async function fetchDasPrices(mints, rpcUrl, prices) {
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
        if (!Array.isArray(results))
            return;
        for (const asset of results) {
            const mint = asset?.id;
            const pricePerToken = asset?.token_info?.price_info?.price_per_token;
            if (mint && typeof pricePerToken === "number" && Number.isFinite(pricePerToken)) {
                prices.set(mint, pricePerToken);
            }
        }
    }
    catch {
        // RPC doesn't support DAS or network error — leave as-is.
    }
}
