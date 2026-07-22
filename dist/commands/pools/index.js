"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPoolCommands = void 0;
const raydium_sdk_v2_1 = require("@raydium-io/raydium-sdk-v2");
const raydium_client_1 = require("../../lib/raydium-client");
const output_1 = require("../../lib/output");
/** Compact USD formatting: 1.2M, 3.4K, 950. */
function formatCompactUsd(value) {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num))
        return "—";
    const abs = Math.abs(num);
    if (abs >= 1e9)
        return `$${(num / 1e9).toFixed(1)}B`;
    if (abs >= 1e6)
        return `$${(num / 1e6).toFixed(1)}M`;
    if (abs >= 1e3)
        return `$${(num / 1e3).toFixed(1)}K`;
    return `$${num.toFixed(0)}`;
}
function mapPoolType(type) {
    switch (type) {
        case "standard":
            return raydium_sdk_v2_1.PoolFetchType.Standard;
        case "concentrated":
            return raydium_sdk_v2_1.PoolFetchType.Concentrated;
        case "all":
        default:
            return raydium_sdk_v2_1.PoolFetchType.All;
    }
}
function registerPoolCommands(program) {
    const pools = program.command("pools").description("Pool utilities");
    pools
        .command("list")
        .description("List pools")
        .option("--type <type>", "all|standard|concentrated", "all")
        .option("--mint-a <mint>", "Filter by mint A")
        .option("--mint-b <mint>", "Filter by mint B")
        .option("--limit <number>", "Limit results", "100")
        .option("--page <number>", "Deprecated numeric page option; ignored by current Raydium API", "1")
        .option("--next-page-id <id>", "Raydium API cursor for the next page")
        .action(async (options) => {
        const limit = Number(options.limit);
        const raydium = await (0, output_1.withSpinner)("Fetching pools", () => (0, raydium_client_1.loadRaydium)({ disableLoadToken: true }));
        const poolType = mapPoolType(options.type);
        let data;
        if (options.mintA || options.mintB) {
            const mintA = options.mintA ?? options.mintB;
            const mintB = options.mintA ? options.mintB : undefined;
            data = await raydium.api.fetchPoolByMints({
                mint1: mintA,
                mint2: mintB,
                type: poolType,
                pageSize: Number.isFinite(limit) ? limit : 100,
                nextPageId: options.nextPageId
            });
        }
        else {
            data = await raydium.api.getPoolList({
                type: poolType,
                pageSize: Number.isFinite(limit) ? limit : 100,
                nextPageId: options.nextPageId
            });
        }
        const poolsList = data.data ?? [];
        const results = Number.isFinite(limit) ? poolsList.slice(0, limit) : poolsList;
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({
                pools: results,
                count: data.count,
                hasNextPage: data.hasNextPage
            });
            return;
        }
        if (results.length === 0) {
            (0, output_1.logInfo)("No pools found");
            return;
        }
        (0, output_1.logInfo)(`Showing ${results.length} pools (total: ${data.count})\n`);
        const rows = results.map((pool) => {
            const anyPool = pool;
            const symA = anyPool.mintA?.symbol || `${pool.mintA.address.slice(0, 4)}…`;
            const symB = anyPool.mintB?.symbol || `${pool.mintB.address.slice(0, 4)}…`;
            return [
                `${symA}/${symB}`,
                pool.type,
                formatCompactUsd(anyPool.tvl),
                formatCompactUsd(anyPool.day?.volume),
                pool.id
            ];
        });
        (0, output_1.logTable)([
            { header: "Pair" },
            { header: "Type" },
            { header: "TVL", align: "right" },
            { header: "Vol 24h", align: "right" },
            { header: "Pool ID" }
        ], rows);
    });
}
exports.registerPoolCommands = registerPoolCommands;
