"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFarmCommands = void 0;
const web3_js_1 = require("@solana/web3.js");
const raydium_client_1 = require("../../lib/raydium-client");
const output_1 = require("../../lib/output");
const prompt_1 = require("../../lib/prompt");
function registerFarmCommands(program) {
    const farm = program.command("farm").description("Read-only farm discovery and diagnostics");
    farm
        .command("show")
        .description("Show a farm's LP token, rewards, APR, TVL, and schedule")
        .argument("[farm-id]", "Farm address (prompted when omitted)")
        .action(async (farmId) => {
        farmId = await (0, prompt_1.promptIfMissing)(farmId, "Farm address");
        try {
            new web3_js_1.PublicKey(farmId);
            const raydium = await (0, output_1.withSpinner)("Loading Raydium", () => (0, raydium_client_1.loadRaydium)({ disableLoadToken: true }));
            const farms = await (0, output_1.withSpinner)("Fetching farm info", () => raydium.api.fetchFarmInfoById({ ids: farmId }));
            const info = farms[0];
            if (!info)
                throw new Error("Farm not found");
            const payload = {
                farmId: info.id,
                programId: info.programId,
                lpMint: info.lpMint,
                symbolMints: info.symbolMints,
                apr: info.apr,
                tvl: info.tvl,
                lpPrice: info.lpPrice,
                tags: info.tags,
                rewards: info.rewardInfos.map((reward) => ({
                    mint: reward.mint,
                    type: reward.type,
                    apr: reward.apr,
                    perSecond: reward.perSecond,
                    openTime: "openTime" in reward ? reward.openTime : undefined,
                    endTime: "endTime" in reward ? reward.endTime : undefined
                }))
            };
            if ((0, output_1.isJsonOutput)()) {
                (0, output_1.logJson)(payload);
            }
            else {
                (0, output_1.logInfo)(`Farm: ${payload.farmId}`);
                (0, output_1.logInfo)(`LP mint: ${payload.lpMint.address}`);
                (0, output_1.logInfo)(`APR: ${payload.apr}%`);
                (0, output_1.logInfo)(`TVL: ${payload.tvl}`);
                (0, output_1.logInfo)(`Rewards: ${payload.rewards.length}`);
                payload.rewards.forEach((reward) => (0, output_1.logInfo)(`  ${reward.mint.symbol || reward.mint.address}: ${reward.apr}% APR, ${reward.perSecond}/sec`));
            }
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("Failed to inspect farm", error);
            process.exitCode = 1;
        }
    });
}
exports.registerFarmCommands = registerFarmCommands;
