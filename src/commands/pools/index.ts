import { Command } from "commander";
import { PoolFetchType } from "@raydium-io/raydium-sdk-v2";

import { loadRaydium } from "../../lib/raydium-client";
import { isJsonOutput, logInfo, logJson, withSpinner } from "../../lib/output";

type PoolTypeOption = "all" | "standard" | "concentrated";

function mapPoolType(type: PoolTypeOption): PoolFetchType {
  switch (type) {
    case "standard":
      return PoolFetchType.Standard;
    case "concentrated":
      return PoolFetchType.Concentrated;
    case "all":
    default:
      return PoolFetchType.All;
  }
}

export function registerPoolCommands(program: Command): void {
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
    .action(async (options: {
      type: PoolTypeOption;
      mintA?: string;
      mintB?: string;
      limit: string;
      page: string;
      nextPageId?: string;
    }) => {
      const limit = Number(options.limit);
      const raydium = await withSpinner("Fetching pools", () => loadRaydium({ disableLoadToken: true }));
      const poolType = mapPoolType(options.type);

      let data;
      if (options.mintA || options.mintB) {
        const mintA = options.mintA ?? options.mintB;
        const mintB = options.mintA ? options.mintB : undefined;
        data = await raydium.api.fetchPoolByMints({
          mint1: mintA!,
          mint2: mintB,
          type: poolType,
          pageSize: Number.isFinite(limit) ? limit : 100,
          nextPageId: options.nextPageId
        });
      } else {
        data = await raydium.api.getPoolList({
          type: poolType,
          pageSize: Number.isFinite(limit) ? limit : 100,
          nextPageId: options.nextPageId
        });
      }

      const poolsList = data.data ?? [];
      const results = Number.isFinite(limit) ? poolsList.slice(0, limit) : poolsList;

      if (isJsonOutput()) {
        logJson({
          pools: results,
          count: data.count,
          hasNextPage: data.hasNextPage
        });
        return;
      }

      if (results.length === 0) {
        logInfo("No pools found");
        return;
      }

      logInfo(`Showing ${results.length} pools (total: ${data.count})\n`);

      results.forEach((pool) => {
        logInfo(`${pool.id} (${pool.type})`);
        logInfo(`  mintA: ${pool.mintA.address}`);
        logInfo(`  mintB: ${pool.mintB.address}`);
        if ("lpMint" in pool && pool.lpMint) {
          logInfo(`  lpMint: ${pool.lpMint.address}`);
        }
      });
    });
}
