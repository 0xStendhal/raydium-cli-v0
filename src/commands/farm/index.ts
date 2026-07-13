import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";

import { loadRaydium } from "../../lib/raydium-client";
import { isJsonOutput, logErrorWithDebug, logInfo, logJson, withSpinner } from "../../lib/output";
import { promptIfMissing } from "../../lib/prompt";

export function registerFarmCommands(program: Command): void {
  const farm = program.command("farm").description("Read-only farm discovery and diagnostics");

  farm
    .command("show")
    .description("Show a farm's LP token, rewards, APR, TVL, and schedule")
    .argument("[farm-id]", "Farm address (prompted when omitted)")
    .action(async (farmId?: string) => {
      farmId = await promptIfMissing(farmId, "Farm address");
      try {
        new PublicKey(farmId);
        const raydium = await withSpinner("Loading Raydium", () => loadRaydium({ disableLoadToken: true }));
        const farms = await withSpinner("Fetching farm info", () =>
          raydium.api.fetchFarmInfoById({ ids: farmId! })
        );
        const info = farms[0];
        if (!info) throw new Error("Farm not found");
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

        if (isJsonOutput()) {
          logJson(payload);
        } else {
          logInfo(`Farm: ${payload.farmId}`);
          logInfo(`LP mint: ${payload.lpMint.address}`);
          logInfo(`APR: ${payload.apr}%`);
          logInfo(`TVL: ${payload.tvl}`);
          logInfo(`Rewards: ${payload.rewards.length}`);
          payload.rewards.forEach((reward) =>
            logInfo(`  ${reward.mint.symbol || reward.mint.address}: ${reward.apr}% APR, ${reward.perSecond}/sec`)
          );
        }
      } catch (error) {
        logErrorWithDebug("Failed to inspect farm", error);
        process.exitCode = 1;
      }
    });
}
