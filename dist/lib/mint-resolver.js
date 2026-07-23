"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRaydiumMintMetadata = exports.resolveMintPublicKey = exports.resolveMintAddress = exports.WRAPPED_SOL_MINT = void 0;
const web3_js_1 = require("@solana/web3.js");
const api_urls_1 = require("./api-urls");
const config_manager_1 = require("./config-manager");
exports.WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const mintListCache = new Map();
const blockListCache = new Map();
function tryParsePublicKey(value) {
    try {
        return new web3_js_1.PublicKey(value).toBase58();
    }
    catch {
        return undefined;
    }
}
function formatCandidate(token) {
    const name = token.name ? ` ${token.name}` : "";
    return `${token.symbol}${name} (${token.address})`;
}
async function fetchRaydiumMintList(cluster, fetcher) {
    if (fetcher === fetch && mintListCache.has(cluster)) {
        return {
            mintList: mintListCache.get(cluster),
            blockList: blockListCache.get(cluster) ?? new Set()
        };
    }
    const api = (0, api_urls_1.getApiUrlsForCluster)(cluster);
    const response = await fetcher(`${api.BASE_HOST}${api.TOKEN_LIST}`);
    if (!response.ok) {
        const status = response.status ? ` ${response.status}` : "";
        throw new Error(`Raydium mint list request failed with HTTP${status}`);
    }
    const json = await response.json();
    const mintList = json?.data?.mintList;
    if (!json?.success || !Array.isArray(mintList)) {
        throw new Error("Raydium mint list response did not include data.mintList");
    }
    const rawBlockList = json.data?.blockList ?? json.data?.blacklist ?? [];
    const blockList = new Set(rawBlockList.filter((mint) => typeof mint === "string"));
    if (fetcher === fetch) {
        mintListCache.set(cluster, mintList);
        blockListCache.set(cluster, blockList);
    }
    return { mintList, blockList };
}
async function resolveMintAddress(value, options = {}) {
    const token = value.trim();
    if (!token)
        throw new Error("Token mint or symbol is required");
    const mint = tryParsePublicKey(token);
    if (mint)
        return mint;
    const symbol = token.toUpperCase();
    if (symbol === "SOL" || symbol === "WSOL")
        return exports.WRAPPED_SOL_MINT;
    const cluster = options.cluster ?? (await (0, config_manager_1.loadConfig)({ createIfMissing: true })).cluster;
    const { mintList, blockList } = await fetchRaydiumMintList(cluster, options.fetcher ?? fetch);
    const matches = mintList.filter((entry) => typeof entry.address === "string" &&
        typeof entry.symbol === "string" &&
        entry.symbol.toUpperCase() === symbol &&
        !blockList.has(entry.address));
    if (matches.length === 1)
        return matches[0].address;
    if (matches.length > 1) {
        const candidates = matches.slice(0, 5).map(formatCandidate).join(", ");
        const suffix = matches.length > 5 ? `, and ${matches.length - 5} more` : "";
        throw new Error(`Token symbol "${token}" is ambiguous on Raydium APIv3 /mint/list: ${candidates}${suffix}. Use a mint address.`);
    }
    throw new Error(`Unknown token symbol "${token}". Use a mint address or a symbol from Raydium APIv3 /mint/list.`);
}
exports.resolveMintAddress = resolveMintAddress;
async function resolveMintPublicKey(value, options = {}) {
    return new web3_js_1.PublicKey(await resolveMintAddress(value, options));
}
exports.resolveMintPublicKey = resolveMintPublicKey;
async function getRaydiumMintMetadata(mintAddresses, options = {}) {
    const result = new Map();
    const requested = new Set(mintAddresses
        .map((mint) => tryParsePublicKey(mint) ?? (mint.toUpperCase() === "SOL" ? exports.WRAPPED_SOL_MINT : mint))
        .filter(Boolean));
    if (requested.size === 0)
        return result;
    const cluster = options.cluster ?? (await (0, config_manager_1.loadConfig)({ createIfMissing: true })).cluster;
    const { mintList, blockList } = await fetchRaydiumMintList(cluster, options.fetcher ?? fetch);
    for (const token of mintList) {
        if (requested.has(token.address) && !blockList.has(token.address)) {
            result.set(token.address, token);
        }
    }
    return result;
}
exports.getRaydiumMintMetadata = getRaydiumMintMetadata;
