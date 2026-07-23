"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const mint_resolver_1 = require("./mint-resolver");
const RAY_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DUPLICATE_MINT = "A9mUUvGWRqTa4FJ1BCFE4ZZBBw3JcVkUy1LpLDKpab6q";
function mintListFetcher(tokens, blockList = []) {
    return async () => ({
        ok: true,
        json: async () => ({
            success: true,
            data: {
                mintList: tokens,
                blockList
            }
        })
    });
}
(0, node_test_1.default)("keeps valid mint addresses on the fast path", async () => {
    let called = false;
    const resolved = await (0, mint_resolver_1.resolveMintAddress)(USDC_MINT, {
        cluster: "mainnet",
        fetcher: async () => {
            called = true;
            throw new Error("fetch should not be called");
        }
    });
    strict_1.default.equal(resolved, USDC_MINT);
    strict_1.default.equal(called, false);
});
(0, node_test_1.default)("recognizes SOL aliases without fetching the Raydium list", async () => {
    const fetcher = async () => {
        throw new Error("fetch should not be called");
    };
    strict_1.default.equal(await (0, mint_resolver_1.resolveMintAddress)("SOL", { cluster: "mainnet", fetcher }), mint_resolver_1.WRAPPED_SOL_MINT);
    strict_1.default.equal(await (0, mint_resolver_1.resolveMintAddress)("wsol", { cluster: "mainnet", fetcher }), mint_resolver_1.WRAPPED_SOL_MINT);
});
(0, node_test_1.default)("resolves Raydium APIv3 mint-list symbols case-insensitively", async () => {
    const resolved = await (0, mint_resolver_1.resolveMintAddress)("ray", {
        cluster: "mainnet",
        fetcher: mintListFetcher([{ address: RAY_MINT, symbol: "RAY", name: "Raydium" }])
    });
    strict_1.default.equal(resolved, RAY_MINT);
});
(0, node_test_1.default)("does not resolve blocklisted mints", async () => {
    await strict_1.default.rejects((0, mint_resolver_1.resolveMintAddress)("RAY", {
        cluster: "mainnet",
        fetcher: mintListFetcher([{ address: RAY_MINT, symbol: "RAY" }], [RAY_MINT])
    }), /Unknown token symbol/);
});
(0, node_test_1.default)("rejects ambiguous ticker symbols instead of guessing", async () => {
    await strict_1.default.rejects((0, mint_resolver_1.resolveMintAddress)("USDC", {
        cluster: "mainnet",
        fetcher: mintListFetcher([
            { address: USDC_MINT, symbol: "USDC", name: "USD Coin" },
            { address: DUPLICATE_MINT, symbol: "USDC", name: "Duplicate USD Coin" }
        ])
    }), /ambiguous/);
});
