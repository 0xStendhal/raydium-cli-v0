import { Command } from "commander";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TxVersion,
  CREATE_CPMM_POOL_PROGRAM,
  LOCK_CPMM_PROGRAM,
  LOCK_CPMM_AUTH,
  ApiV3PoolInfoStandardItemCpmm
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";

import { getApiUrlsForCluster } from "../../lib/api-urls";
import { loadConfig } from "../../lib/config-manager";
import { getConfiguredCluster, loadRaydium } from "../../lib/raydium-client";
import { decryptWallet, resolveWalletIdentifier } from "../../lib/wallet-manager";
import { promptConfirm, promptPassword } from "../../lib/prompt";
import { isJsonOutput, logError, logErrorWithDebug, logInfo, logJson, logSuccess, withSpinner } from "../../lib/output";
import { Cluster } from "../../types/config";
import { addRichHelp, NON_INTERACTIVE_HELP, PASSWORD_AUTH_HELP } from "../../lib/help";

// CPMM Lock position API response types
interface CpmmLockPositionInfo {
  positionInfo: {
    percentage: number;
    usdValue: number;
    unclaimedFee: {
      lp: number;
      amountA: number;
      amountB: number;
      useValue: number;
    };
  };
}

// Fetch lock position info from Raydium API
async function fetchCpmmLockPositionInfo(
  nftMint: string,
  cluster: Cluster = "mainnet"
): Promise<CpmmLockPositionInfo | null> {
  const url = `${getApiUrlsForCluster(cluster).CPMM_LOCK}/${nftMint}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.json() as CpmmLockPositionInfo;
  } catch {
    return null;
  }
}

const DEFAULT_COMPUTE_UNITS = 600_000;
const FEE_RATE_DENOMINATOR = 1_000_000;

// API response type for CPMM configs
interface CpmmConfigResponse {
  id: string;
  success: boolean;
  data: Array<{
    id: string;
    index: number;
    protocolFeeRate: number;
    tradeFeeRate: number;
    fundFeeRate: number;
    createPoolFee: string;
    creatorFeeRate: number;
  }>;
}

export function registerCpmmCommands(program: Command): void {
  const cpmm = program.command("cpmm").description("CPMM (constant product) pool commands");

  // List available CPMM configs
  addRichHelp(
    cpmm
      .command("configs")
      .description("List available CPMM pool fee configurations")
      .option("--devnet", "Use devnet API instead of the configured cluster"),
    {
      summary: "Shows the Raydium CPMM fee configs available for pool creation.",
      defaults: [
        "Uses the configured cluster unless --devnet is provided.",
        "The output explains how trade fees split across LPs, protocol, fund, and creator fees."
      ],
      nonInteractive: NON_INTERACTIVE_HELP,
      examples: [
        "raydium cpmm configs",
        "raydium cpmm configs --devnet",
        "raydium --json cpmm configs"
      ],
      notes: "--devnet is a command-local override and does not modify the saved cluster config."
    }
  )
    .action(async (options: { devnet?: boolean }) => {
      const configuredCluster = await getConfiguredCluster();
      const cluster = options.devnet ? "devnet" : configuredCluster;
      const baseUrl = cluster === "devnet"
        ? "https://api-v3.raydium.io/devnet/cpmm-config"
        : "https://api-v3.raydium.io/main/cpmm-config";

      let configData: CpmmConfigResponse;
      try {
        configData = await withSpinner("Fetching CPMM configs", async () => {
          const response = await fetch(baseUrl);
          if (!response.ok) {
            throw new Error(`API request failed: ${response.status}`);
          }
          return response.json() as Promise<CpmmConfigResponse>;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("Failed to fetch CPMM configs", message);
        process.exitCode = 1;
        return;
      }

      if (!configData.success || !configData.data) {
        logError("Invalid API response");
        process.exitCode = 1;
        return;
      }

      // Sort by index
      const configs = configData.data.sort((a, b) => a.index - b.index);

      if (isJsonOutput()) {
        // Add calculated bps values for JSON output
        const enrichedConfigs = configs.map(c => ({
          ...c,
          tradeFeeRateBps: (c.tradeFeeRate / FEE_RATE_DENOMINATOR) * 10000,
          creatorFeeRateBps: (c.creatorFeeRate / FEE_RATE_DENOMINATOR) * 10000,
          totalFeeBps: ((c.tradeFeeRate + c.creatorFeeRate) / FEE_RATE_DENOMINATOR) * 10000,
          protocolFeePercent: (c.protocolFeeRate / FEE_RATE_DENOMINATOR) * 100,
          fundFeePercent: (c.fundFeeRate / FEE_RATE_DENOMINATOR) * 100,
          lpFeePercent: 100 - ((c.protocolFeeRate + c.fundFeeRate) / FEE_RATE_DENOMINATOR) * 100,
          createPoolFeeSol: Number(c.createPoolFee) / 1e9,
        }));
        logJson({ configs: enrichedConfigs });
        return;
      }

      logInfo("");
      logInfo("Available CPMM Fee Configurations");
      logInfo("══════════════════════════════════════════════════════════════════════════════");
      logInfo("");
      logInfo("Fee Structure Explanation:");
      logInfo("  • tradeFeeRate: Fee charged on each swap (in bps)");
      logInfo("    └─ Split between: LP (compounds) + Protocol (Raydium) + Fund");
      logInfo("  • creatorFeeRate: Additional fee to pool creator (in bps)");
      logInfo("  • Total Fee = tradeFeeRate + creatorFeeRate");
      logInfo("");

      for (const config of configs) {
        const tradeBps = (config.tradeFeeRate / FEE_RATE_DENOMINATOR) * 10000;
        const creatorBps = (config.creatorFeeRate / FEE_RATE_DENOMINATOR) * 10000;
        const totalBps = tradeBps + creatorBps;
        const protocolPct = (config.protocolFeeRate / FEE_RATE_DENOMINATOR) * 100;
        const fundPct = (config.fundFeeRate / FEE_RATE_DENOMINATOR) * 100;
        const lpPct = 100 - protocolPct - fundPct;
        const createPoolSol = Number(config.createPoolFee) / 1e9;

        logInfo(`Config #${config.index}`);
        logInfo(`  ID: ${config.id}`);
        logInfo(`  Trade Fee: ${tradeBps} bps (${tradeBps / 100}%)`);
        logInfo(`    ├─ LP Fee: ~${(tradeBps * lpPct / 100).toFixed(1)} bps (${lpPct.toFixed(0)}% of trade fee → compounds into pool)`);
        logInfo(`    ├─ Protocol: ~${(tradeBps * protocolPct / 100).toFixed(1)} bps (${protocolPct.toFixed(0)}% of trade fee → Raydium)`);
        logInfo(`    └─ Fund: ~${(tradeBps * fundPct / 100).toFixed(1)} bps (${fundPct.toFixed(0)}% of trade fee)`);
        logInfo(`  Creator Fee: ${creatorBps} bps (${creatorBps / 100}%) → pool creator`);
        logInfo(`  Total Fee: ${totalBps} bps (${totalBps / 100}%)`);
        logInfo(`  Pool Creation Fee: ${createPoolSol} SOL`);
        logInfo("");
      }

      logInfo("──────────────────────────────────────────────────────────────────────────────");
      logInfo("Note: These are the only available configs. Custom configs require Raydium.");
    });

  // Collect creator fees command
  addRichHelp(
    cpmm
      .command("collect-creator-fees")
      .description("Collect creator fees from a CPMM pool you created")
      .requiredOption("--pool-id <address>", "Pool ID to collect from")
      .option("--priority-fee <sol>", "Priority fee in SOL")
      .option("--debug", "Print full error on failure"),
    {
      auth: PASSWORD_AUTH_HELP,
      units: "--priority-fee is in SOL.",
      defaults: "Uses the active wallet unless --keystore overrides it.",
      nonInteractive: NON_INTERACTIVE_HELP,
      examples: [
        "raydium cpmm collect-creator-fees --pool-id <pool-id>",
        "printf '%s' 'wallet-password' | raydium --json --yes --password-stdin cpmm collect-creator-fees --pool-id <pool-id>"
      ]
    }
  )
    .action(async (options: {
      poolId: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

      // Validate pool ID
      let poolId: PublicKey;
      try {
        poolId = new PublicKey(options.poolId);
      } catch {
        logError("Invalid pool ID address");
        process.exitCode = 1;
        return;
      }

      // Validate priority fee
      const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
      if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
        logError("Invalid priority fee");
        process.exitCode = 1;
        return;
      }
      const priorityFeeLamports = priorityFeeSol * 1e9;
      const priorityFeeMicroLamports = Math.round((priorityFeeLamports * 1e6) / DEFAULT_COMPUTE_UNITS);

      // Check wallet
      const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
      if (!walletName) {
        logError("No active wallet set. Use 'raydium wallet use <name>' to set one.");
        process.exitCode = 1;
        return;
      }

      // Prompt for password and decrypt wallet
      const password = await promptPassword("Enter wallet password");
      let owner: Keypair;
      try {
        owner = await decryptWallet(walletName, password);
      } catch (error) {
        logError("Failed to decrypt wallet", (error as Error).message);
        process.exitCode = 1;
        return;
      }

      // Load Raydium with owner
      const raydium = await withSpinner("Loading Raydium", () =>
        loadRaydium({ owner, disableLoadToken: true })
      );

      // Fetch pool info
      let poolInfo: ApiV3PoolInfoStandardItemCpmm;
      try {
        poolInfo = await withSpinner("Fetching pool info", async () => {
          const data = await raydium.api.fetchPoolById({ ids: poolId.toBase58() });
          if (!data || data.length === 0) {
            throw new Error("Pool not found");
          }
          const pool = data[0];
          if (pool.type !== "Standard" || !("lpMint" in pool)) {
            throw new Error("Not a CPMM pool");
          }
          return pool as ApiV3PoolInfoStandardItemCpmm;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("Failed to fetch pool info", message);
        process.exitCode = 1;
        return;
      }

      // Show preview
      const mintA = poolInfo.mintA;
      const mintB = poolInfo.mintB;
      const symbolA = mintA.symbol || mintA.address.slice(0, 8) + "...";
      const symbolB = mintB.symbol || mintB.address.slice(0, 8) + "...";

      if (isJsonOutput()) {
        logJson({
          action: "collect-creator-fees",
          poolId: poolId.toBase58(),
          pair: `${symbolA}/${symbolB}`
        });
      } else {
        logInfo("");
        logInfo(`Collecting Creator Fees`);
        logInfo(`  Pool: ${poolId.toBase58()}`);
        logInfo(`  Pair: ${symbolA}/${symbolB}`);
      }

      // Confirm
      const ok = await promptConfirm("Proceed with collecting creator fees?", false);
      if (!ok) {
        logInfo("Cancelled");
        return;
      }

      // Build and execute transaction
      type CollectCreatorFeesTxData = Awaited<ReturnType<typeof raydium.cpmm.collectCreatorFees>>;
      let txData: CollectCreatorFeesTxData;
      try {
        txData = await withSpinner("Building transaction", async () => {
          return raydium.cpmm.collectCreatorFees({
            poolInfo,
            programId: CREATE_CPMM_POOL_PROGRAM,
            txVersion: TxVersion.V0,
            computeBudgetConfig: priorityFeeMicroLamports > 0
              ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
              : undefined
          });
        });
      } catch (error) {
        logErrorWithDebug("Failed to build transaction", error, { debug: options.debug, fallback: "Failed to build transaction" });
        process.exitCode = 1;
        return;
      }

      let result: { txId: string };
      try {
        result = await withSpinner("Sending transaction", async () => {
          const executed = await txData.execute({ sendAndConfirm: true });
          return { txId: executed.txId };
        });
      } catch (error) {
        logErrorWithDebug("Collect fees failed", error, { debug: options.debug, fallback: "Collect fees failed" });
        process.exitCode = 1;
        return;
      }

      if (isJsonOutput()) {
        logJson({ txId: result.txId });
      } else {
        logSuccess(`Creator fees collected: ${result.txId}`);
      }
    });

  // Harvest LP fees command (for locked LP positions)
  addRichHelp(
    cpmm
      .command("harvest-lp-fees")
      .description("Harvest fees from a locked LP position")
      .requiredOption("--pool-id <address>", "Pool ID")
      .requiredOption("--nft-mint <address>", "Fee Key NFT mint address")
      .option("--lp-fee-amount <amount>", "LP fee amount to harvest (in raw units, overrides --percent)")
      .option("--percent <number>", "Percentage of available fees to harvest (default: 100)", "100")
      .option("--priority-fee <sol>", "Priority fee in SOL")
      .option("--debug", "Print full error on failure"),
    {
      auth: PASSWORD_AUTH_HELP,
      units: [
        "--lp-fee-amount is in raw units.",
        "--percent is a percentage from 1 to 100.",
        "--priority-fee is in SOL."
      ],
      defaults: [
        "If --lp-fee-amount is omitted, the command derives the harvest amount from the current available fees.",
        "--percent defaults to 100."
      ],
      nonInteractive: NON_INTERACTIVE_HELP,
      examples: [
        "raydium cpmm harvest-lp-fees --pool-id <pool-id> --nft-mint <lock-nft-mint>",
        "raydium cpmm harvest-lp-fees --pool-id <pool-id> --nft-mint <lock-nft-mint> --percent 50",
        "raydium cpmm harvest-lp-fees --pool-id <pool-id> --nft-mint <lock-nft-mint> --lp-fee-amount 123456"
      ]
    }
  )
    .action(async (options: {
      poolId: string;
      nftMint: string;
      lpFeeAmount?: string;
      percent?: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

      // Validate pool ID
      let poolId: PublicKey;
      try {
        poolId = new PublicKey(options.poolId);
      } catch {
        logError("Invalid pool ID address");
        process.exitCode = 1;
        return;
      }

      // Validate NFT mint
      let nftMint: PublicKey;
      try {
        nftMint = new PublicKey(options.nftMint);
      } catch {
        logError("Invalid NFT mint address");
        process.exitCode = 1;
        return;
      }

      // Validate percent
      const percent = Number(options.percent ?? "100");
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        logError("Invalid percent (must be 1-100)");
        process.exitCode = 1;
        return;
      }

      // Determine LP fee amount - either explicit or fetched from API
      let lpFeeAmount: BN;
      let totalAvailableFee: number | undefined;

      if (options.lpFeeAmount) {
        // User provided explicit amount
        const lpFeeAmountNum = Number(options.lpFeeAmount);
        if (!Number.isFinite(lpFeeAmountNum) || lpFeeAmountNum < 0) {
          logError("Invalid LP fee amount");
          process.exitCode = 1;
          return;
        }
        lpFeeAmount = new BN(options.lpFeeAmount);
      } else {
        // Fetch from API using the configured cluster.
        const cluster = config.cluster;
        const lockInfo = await withSpinner("Fetching lock position info", () =>
          fetchCpmmLockPositionInfo(nftMint.toBase58(), cluster)
        );

        if (!lockInfo) {
          logError("Failed to fetch lock position info. Use --lp-fee-amount to specify manually.");
          process.exitCode = 1;
          return;
        }

        totalAvailableFee = lockInfo.positionInfo.unclaimedFee.lp;
        if (totalAvailableFee <= 0) {
          logError("No unclaimed LP fees available");
          process.exitCode = 1;
          return;
        }

        // Calculate amount based on percentage
        const amountToHarvest = Math.floor(totalAvailableFee * (percent / 100));
        if (amountToHarvest <= 0) {
          logError("Calculated harvest amount is zero");
          process.exitCode = 1;
          return;
        }
        lpFeeAmount = new BN(amountToHarvest);
      }

      // Validate priority fee
      const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
      if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
        logError("Invalid priority fee");
        process.exitCode = 1;
        return;
      }
      const priorityFeeLamports = priorityFeeSol * 1e9;
      const priorityFeeMicroLamports = Math.round((priorityFeeLamports * 1e6) / DEFAULT_COMPUTE_UNITS);

      // Check wallet
      const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
      if (!walletName) {
        logError("No active wallet set. Use 'raydium wallet use <name>' to set one.");
        process.exitCode = 1;
        return;
      }

      // Prompt for password and decrypt wallet
      const password = await promptPassword("Enter wallet password");
      let owner: Keypair;
      try {
        owner = await decryptWallet(walletName, password);
      } catch (error) {
        logError("Failed to decrypt wallet", (error as Error).message);
        process.exitCode = 1;
        return;
      }

      // Load Raydium with owner
      const raydium = await withSpinner("Loading Raydium", () =>
        loadRaydium({ owner, disableLoadToken: true })
      );

      // Fetch pool info
      let poolInfo: ApiV3PoolInfoStandardItemCpmm;
      try {
        poolInfo = await withSpinner("Fetching pool info", async () => {
          const data = await raydium.api.fetchPoolById({ ids: poolId.toBase58() });
          if (!data || data.length === 0) {
            throw new Error("Pool not found");
          }
          const pool = data[0];
          if (pool.type !== "Standard" || !("lpMint" in pool)) {
            throw new Error("Not a CPMM pool");
          }
          return pool as ApiV3PoolInfoStandardItemCpmm;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("Failed to fetch pool info", message);
        process.exitCode = 1;
        return;
      }

      // Show preview
      const mintA = poolInfo.mintA;
      const mintB = poolInfo.mintB;
      const symbolA = mintA.symbol || mintA.address.slice(0, 8) + "...";
      const symbolB = mintB.symbol || mintB.address.slice(0, 8) + "...";

      if (isJsonOutput()) {
        logJson({
          action: "harvest-lp-fees",
          poolId: poolId.toBase58(),
          pair: `${symbolA}/${symbolB}`,
          nftMint: nftMint.toBase58(),
          lpFeeAmount: lpFeeAmount.toString(),
          ...(totalAvailableFee !== undefined && { totalAvailableFee, percent })
        });
      } else {
        logInfo("");
        logInfo(`Harvesting LP Fees from Locked Position`);
        logInfo(`  Pool: ${poolId.toBase58()}`);
        logInfo(`  Pair: ${symbolA}/${symbolB}`);
        logInfo(`  NFT Mint: ${nftMint.toBase58()}`);
        if (totalAvailableFee !== undefined) {
          logInfo(`  Available LP Fees: ${totalAvailableFee}`);
          logInfo(`  Harvesting: ${percent}% (${lpFeeAmount.toString()} LP)`);
        } else {
          logInfo(`  LP Fee Amount: ${lpFeeAmount.toString()}`);
        }
      }

      // Confirm
      const ok = await promptConfirm("Proceed with harvesting LP fees?", false);
      if (!ok) {
        logInfo("Cancelled");
        return;
      }

      // Build and execute transaction
      type HarvestLockLpTxData = Awaited<ReturnType<typeof raydium.cpmm.harvestLockLp>>;
      let txData: HarvestLockLpTxData;
      try {
        txData = await withSpinner("Building transaction", async () => {
          return raydium.cpmm.harvestLockLp({
            poolInfo,
            nftMint,
            lpFeeAmount,
            programId: LOCK_CPMM_PROGRAM,
            authProgram: LOCK_CPMM_AUTH,
            txVersion: TxVersion.V0,
            computeBudgetConfig: priorityFeeMicroLamports > 0
              ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
              : undefined
          });
        });
      } catch (error) {
        logErrorWithDebug("Failed to build transaction", error, { debug: options.debug, fallback: "Failed to build transaction" });
        process.exitCode = 1;
        return;
      }

      let result: { txId: string };
      try {
        result = await withSpinner("Sending transaction", async () => {
          const executed = await txData.execute({ sendAndConfirm: true });
          return { txId: executed.txId };
        });
      } catch (error) {
        logErrorWithDebug("Harvest failed", error, { debug: options.debug, fallback: "Harvest failed" });
        process.exitCode = 1;
        return;
      }

      if (isJsonOutput()) {
        logJson({ txId: result.txId });
      } else {
        logSuccess(`LP fees harvested: ${result.txId}`);
      }
    });
}
