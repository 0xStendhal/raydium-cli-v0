import { Command } from "commander";
import { PoolFetchType } from "@raydium-io/raydium-sdk-v2";

import { loadRaydium } from "../../lib/raydium-client";
import { resolveMintAddress } from "../../lib/mint-resolver";
import { isJsonOutput, logError, logInfo, logJson, logTable, withSpinner } from "../../lib/output";

/** Compact USD formatting: 1.2M, 3.4K, 950. */
function formatCompactUsd(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return "—";
  const abs = Math.abs(num);
  if (abs >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

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
    .option("--mint-a <mint-or-symbol>", "Filter by mint A or Raydium APIv3 symbol")
    .option("--mint-b <mint-or-symbol>", "Filter by mint B or Raydium APIv3 symbol")
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
        try {
          if (options.mintA) options.mintA = await resolveMintAddress(options.mintA, { cluster: raydium.cluster });
          if (options.mintB) options.mintB = await resolveMintAddress(options.mintB, { cluster: raydium.cluster });
        } catch (error) {
          logError(error instanceof Error ? error.message : "Failed to resolve token symbol");
          process.exitCode = 1;
          return;
        }
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

      const rows = results.map((pool) => {
        const anyPool = pool as unknown as {
          mintA?: { symbol?: string; address: string };
          mintB?: { symbol?: string; address: string };
          tvl?: number;
          day?: { volume?: number };
        };
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

      logTable(
        [
          { header: "Pair" },
          { header: "Type" },
          { header: "TVL", align: "right" },
          { header: "Vol 24h", align: "right" },
          { header: "Pool ID" }
        ],
        rows
      );
    });
}
