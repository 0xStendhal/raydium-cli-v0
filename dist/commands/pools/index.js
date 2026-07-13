"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPoolCommands = void 0;
const raydium_sdk_v2_1 = require("@raydium-io/raydium-sdk-v2");
const raydium_client_1 = require("../../lib/raydium-client");
const output_1 = require("../../lib/output");
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
        results.forEach((pool) => {
            (0, output_1.logInfo)(`${pool.id} (${pool.type})`);
            (0, output_1.logInfo)(`  mintA: ${pool.mintA.address}`);
            (0, output_1.logInfo)(`  mintB: ${pool.mintB.address}`);
            if ("lpMint" in pool && pool.lpMint) {
                (0, output_1.logInfo)(`  lpMint: ${pool.lpMint.address}`);
            }
        });
    });
}
exports.registerPoolCommands = registerPoolCommands;
