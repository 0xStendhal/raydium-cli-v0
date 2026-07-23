import { Command } from "commander";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import {
  TxVersion,
  CREATE_CPMM_POOL_PROGRAM,
  LOCK_CPMM_PROGRAM,
  LOCK_CPMM_AUTH,
  ApiV3PoolInfoStandardItemCpmm,
  CurveCalculator,
  FeeOn,
  Percent,
  getTransferAmountFeeV2
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";

import { getApiUrlsForCluster } from "../../lib/api-urls";
import { getUnsupportedCpmmLayoutMessage } from "../../lib/cpmm-layout";
import { getConnection } from "../../lib/connection";
import { loadConfig } from "../../lib/config-manager";
import { getConfiguredCluster, loadRaydium } from "../../lib/raydium-client";
import { decryptWallet, resolveWalletIdentifier } from "../../lib/wallet-manager";
import { promptConfirm, promptIfMissing, promptNumberIfMissing, promptPassword } from "../../lib/prompt";
import { isJsonOutput, logError, logErrorWithDebug, logInfo, logJson, logSuccess, withSpinner } from "../../lib/output";
import { Cluster } from "../../types/config";
import { addRichHelp, AUTOMATION_HELP, PASSWORD_AUTH_HELP } from "../../lib/help";
import { getTransactionExplorerUrl, offerTransactionExplorer } from "../../lib/explorer";
import {
  SimulationBalanceGuards,
  assertTransactionPriorityFeeBudget,
  sendAndConfirmVersionedTransaction,
  simulateVersionedTransaction,
  validateVersionedTransactionPolicy
} from "../../lib/safe-transaction";
import {
  parsePriorityFeeMicroLamports,
  parseSlippagePercent
} from "../../lib/swap-guards";
import { assertJsonQuoteApproval, withQuoteApprovalId } from "../../lib/quote-approval";
import { resolveMintPublicKey } from "../../lib/mint-resolver";

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
const MAX_PRIORITY_FEE_LAMPORTS = 100_000_000n;
const SIGNATURE_FEE_LAMPORTS = 5_000n;
// Headroom for rent spent on token accounts the swap may create (an ATA costs ~2_039_280 lamports).
const SWAP_RENT_ALLOWANCE_LAMPORTS = 10_000_000n;

type CpmmPoolInspection = {
  source: "rpc" | "raydium-api";
  warning?: string;
  poolId: string;
  pair: string;
  mintA: { address: string; symbol?: string };
  mintB: { address: string; symbol?: string };
  lpMint: { address: string };
  reserves: { mintA: string; mintB: string };
  fees: {
    denominator?: number;
    trade?: { raw: string; percent: string };
    creator?: { raw: string; percent: string };
    protocol?: { raw: string; percent: string };
    fund?: { raw: string; percent: string };
    apiFeeRate?: number;
  };
};

const COMMON_TRANSACTION_PROGRAM_IDS = new Set([
  ComputeBudgetProgram.programId.toBase58(),
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
]);

function parseUiAmount(value: string, decimals: number, label: string): BN {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error(`${label} must be a positive decimal number`);
  const amount = new Decimal(normalized);
  if (!amount.isFinite() || amount.lte(0)) throw new Error(`${label} must be greater than zero`);
  const raw = amount.mul(new Decimal(10).pow(decimals));
  if (!raw.isInteger()) throw new Error(`${label} has more than ${decimals} decimal places`);
  return new BN(raw.toFixed(0));
}

function formatRawAmount(raw: BN, decimals: number): string {
  return new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toFixed();
}

function getCpmmSymbol(mint: { address: string; symbol?: string }): string {
  return mint.symbol || `${mint.address.slice(0, 6)}...`;
}

function formatCpmmFeeRate(rawRate: BN | undefined): { raw: string; percent: string } | undefined {
  if (!rawRate) return undefined;
  return {
    raw: rawRate.toString(),
    percent: new Decimal(rawRate.toString()).mul(100).div(FEE_RATE_DENOMINATOR).toFixed()
  };
}

function getCpmmOperationError(error: unknown): unknown {
  return getUnsupportedCpmmLayoutMessage(error) ?? error;
}

function isCpmmApiPool(pool: unknown): pool is ApiV3PoolInfoStandardItemCpmm {
  return Boolean(
    pool &&
    typeof pool === "object" &&
    (pool as { type?: unknown }).type === "Standard" &&
    "config" in pool
  );
}

function applyCpmmSlippage(rawAmount: BN, slippage: number, exactOut: boolean): BN {
  const multiplier = new BN((exactOut ? 1 + slippage : 1 - slippage) * 10_000);
  return rawAmount.mul(multiplier).div(new BN(10_000));
}

function toCpmmSlippageFraction(slippagePercent: number): Percent {
  const decimal = new Decimal(slippagePercent).div(100);
  const places = decimal.decimalPlaces();
  const denominator = new Decimal(10).pow(places);
  return new Percent(
    new BN(decimal.mul(denominator).toFixed(0)),
    new BN(denominator.toFixed(0))
  );
}

async function reviewAndExecuteCpmmTransaction(params: {
  transaction: VersionedTransaction;
  owner: Keypair;
  action: string;
  quoteAction: string;
  quote: Record<string, unknown>;
  approvedQuoteId?: string;
  requestedPriorityFeeMicroLamports: number;
  explorer: { explorer: "solscan" | "solanaFm" | "solanaExplorer"; cluster: Cluster };
  allowedProgramIds: ReadonlySet<string>;
  balanceGuards?: SimulationBalanceGuards;
}): Promise<string | undefined> {
  const { transaction, owner } = params;
  assertJsonQuoteApproval({
    action: params.quoteAction,
    quote: params.quote,
    approvedQuoteId: params.approvedQuoteId
  });
  const connection = await getConnection();
  const policyPreview = await validateVersionedTransactionPolicy(connection, transaction, {
    owner: owner.publicKey,
    allowedProgramIds: params.allowedProgramIds
  });
  const feePreview = assertTransactionPriorityFeeBudget(
    transaction,
    params.requestedPriorityFeeMicroLamports,
    MAX_PRIORITY_FEE_LAMPORTS
  );
  const preview = { ...feePreview, programIds: policyPreview.programIds };
  const simulation = await withSpinner("Simulating transaction", () =>
    simulateVersionedTransaction(connection, transaction, params.balanceGuards)
  );

  if (!isJsonOutput()) {
    logInfo(`Transaction review: ${preview.instructionCount} instructions`);
    logInfo(`Programs: ${preview.programIds.join(", ") || "unavailable"}`);
    if (preview.computeBudget?.maximumPriorityFeeLamports) {
      logInfo(`Maximum priority fee: ${preview.computeBudget.maximumPriorityFeeLamports} lamports`);
    }
    logInfo(`Simulation: succeeded${simulation.unitsConsumed ? ` (${simulation.unitsConsumed} compute units)` : ""}`);
  }

  const ok = await promptConfirm("Send the simulated CPMM transaction?", false);
  if (!ok) {
    logInfo("Cancelled");
    return undefined;
  }

  transaction.sign([owner]);
  const txId = await withSpinner("Sending transaction", () =>
    sendAndConfirmVersionedTransaction(connection, transaction)
  );
  const explorerUrl = getTransactionExplorerUrl({ ...params.explorer, signature: txId });
  if (!isJsonOutput()) {
    logInfo(`Explorer: ${explorerUrl}`);
    try {
      await offerTransactionExplorer({ ...params.explorer, signature: txId });
    } catch (error) {
      logErrorWithDebug("Transaction confirmed, but explorer could not be opened", error);
    }
  }
  if (isJsonOutput()) {
    logJson({
      action: params.action,
      ...withQuoteApprovalId(params.quoteAction, params.quote),
      transaction: preview,
      simulation: { unitsConsumed: simulation.unitsConsumed },
      txId,
      explorerUrl,
      confirmationStatus: "confirmed"
    });
  } else {
    logSuccess(`CPMM transaction confirmed: ${txId}`);
  }
  return txId;
}

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
      automation: AUTOMATION_HELP,
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
      .option("--pool-id <address>", "Pool ID to collect from (prompted when omitted)")
      .option("--priority-fee <sol>", "Priority fee in SOL")
      .option("--debug", "Print full error on failure"),
    {
      auth: PASSWORD_AUTH_HELP,
      units: "--priority-fee is in SOL.",
      defaults: "Uses the active wallet unless --keystore overrides it.",
      automation: AUTOMATION_HELP,
      examples: [
        "raydium cpmm collect-creator-fees --pool-id <pool-id>",
        "printf '%s' 'wallet-password' | raydium --json --yes --password-stdin cpmm collect-creator-fees --pool-id <pool-id>"
      ]
    }
  )
    .action(async (options: {
      poolId?: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      options.poolId = await promptIfMissing(options.poolId, "CPMM pool address");
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
      .option("--pool-id <address>", "Pool ID (prompted when omitted)")
      .option("--nft-mint <address>", "Fee Key NFT mint address (prompted when omitted)")
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
      automation: AUTOMATION_HELP,
      examples: [
        "raydium cpmm harvest-lp-fees --pool-id <pool-id> --nft-mint <lock-nft-mint>",
        "raydium cpmm harvest-lp-fees --pool-id <pool-id> --nft-mint <lock-nft-mint> --percent 50",
        "raydium cpmm harvest-lp-fees --pool-id <pool-id> --nft-mint <lock-nft-mint> --lp-fee-amount 123456"
      ]
    }
  )
    .action(async (options: {
      poolId?: string;
      nftMint?: string;
      lpFeeAmount?: string;
      percent?: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      options.poolId = await promptIfMissing(options.poolId, "CPMM pool address");
      options.nftMint = await promptIfMissing(options.nftMint, "Fee Key NFT mint address");
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

  cpmm
    .command("pool")
    .description("Show CPMM pool state from RPC, with indexed API fallback for unsupported layouts")
    .argument("[pool-id]", "CPMM pool address (prompted when omitted)")
    .action(async (poolId?: string) => {
      poolId = await promptIfMissing(poolId, "CPMM pool address");
      let parsedPoolId: PublicKey;
      try {
        parsedPoolId = new PublicKey(poolId);
      } catch {
        logError("Invalid CPMM pool address");
        process.exitCode = 1;
        return;
      }

      try {
        const raydium = await withSpinner("Loading Raydium", () =>
          loadRaydium({ disableLoadToken: true })
        );
        let payload: CpmmPoolInspection;
        try {
          const data = await withSpinner("Fetching CPMM pool state", () =>
            raydium.cpmm.getPoolInfoFromRpc(parsedPoolId.toBase58())
          );
          const { poolInfo, rpcData } = data;
          payload = {
            source: "rpc",
            poolId: parsedPoolId.toBase58(),
            pair: `${getCpmmSymbol(poolInfo.mintA)}/${getCpmmSymbol(poolInfo.mintB)}`,
            mintA: poolInfo.mintA,
            mintB: poolInfo.mintB,
            lpMint: poolInfo.lpMint,
            reserves: {
              mintA: formatRawAmount(rpcData.baseReserve, poolInfo.mintA.decimals),
              mintB: formatRawAmount(rpcData.quoteReserve, poolInfo.mintB.decimals)
            },
            fees: {
              denominator: FEE_RATE_DENOMINATOR,
              trade: formatCpmmFeeRate(rpcData.configInfo?.tradeFeeRate),
              creator: formatCpmmFeeRate(rpcData.configInfo?.creatorFeeRate),
              protocol: formatCpmmFeeRate(rpcData.configInfo?.protocolFeeRate),
              fund: formatCpmmFeeRate(rpcData.configInfo?.fundFeeRate)
            }
          };
        } catch (error) {
          const layoutMessage = getUnsupportedCpmmLayoutMessage(error);
          if (!layoutMessage) throw error;

          const pools = await withSpinner("Fetching indexed CPMM pool data", () =>
            raydium.api.fetchPoolById({ ids: parsedPoolId.toBase58() })
          );
          const pool = pools.find(isCpmmApiPool);
          if (!pool) {
            throw new Error(`${layoutMessage} The indexed Raydium API has no CPMM record for this pool.`);
          }
          payload = {
            source: "raydium-api",
            warning: "RPC decoding failed. Values are indexed API data and may be stale; transaction building remains disabled.",
            poolId: pool.id,
            pair: `${getCpmmSymbol(pool.mintA)}/${getCpmmSymbol(pool.mintB)}`,
            mintA: pool.mintA,
            mintB: pool.mintB,
            lpMint: pool.lpMint,
            reserves: {
              mintA: String(pool.mintAmountA),
              mintB: String(pool.mintAmountB)
            },
            fees: { apiFeeRate: pool.feeRate }
          };
        }

        if (isJsonOutput()) {
          logJson(payload);
        } else {
          logInfo(`CPMM pool: ${payload.pair}`);
          logInfo(`  Source: ${payload.source}`);
          logInfo(`  ID: ${payload.poolId}`);
          logInfo(`  Reserves: ${payload.reserves.mintA} / ${payload.reserves.mintB}`);
          logInfo(`  LP mint: ${payload.lpMint.address}`);
          if (payload.warning) logInfo(`  Warning: ${payload.warning}`);
          if (payload.fees.trade) logInfo(`  Trade fee: ${payload.fees.trade.percent}% (${payload.fees.trade.raw}/${FEE_RATE_DENOMINATOR})`);
          if (payload.fees.apiFeeRate !== undefined) logInfo(`  API fee rate: ${payload.fees.apiFeeRate}`);
        }
      } catch (error) {
        logErrorWithDebug("Failed to fetch CPMM pool", getCpmmOperationError(error));
        process.exitCode = 1;
      }
    });

  cpmm
    .command("swap")
    .description("Quote or execute a direct CPMM swap")
    .option("--pool-id <address>", "CPMM pool address (prompted when omitted)")
    .option("--input-mint <mint-or-symbol>", "Input token mint or Raydium APIv3 symbol for an exact-input swap")
    .option("--output-mint <mint-or-symbol>", "Requested output token mint or Raydium APIv3 symbol for an exact-output swap")
    .option("--amount <number>", "Input amount, or requested output with --exact-out (prompted when omitted)")
    .option("--exact-out", "Treat --amount as the requested output amount")
    .option("--slippage <percent>", "Slippage tolerance")
    .option("--allow-high-slippage", "Allow slippage above the 5% safety cap")
    .option("--priority-fee <sol>", "Priority fee in SOL")
    .option("--allow-high-priority-fee", "Allow priority fee above the 0.01 SOL safety cap")
    .option("--execute", "Build, simulate, review, and send the swap")
    .option("--approve-quote <quote-id>", "Required with --json --execute; use quoteId from a fresh quote")
    .action(async (options: {
      poolId?: string;
      inputMint?: string;
      outputMint?: string;
      amount?: string;
      exactOut?: boolean;
      slippage?: string;
      allowHighSlippage?: boolean;
      priorityFee?: string;
      allowHighPriorityFee?: boolean;
      execute?: boolean;
      approveQuote?: string;
    }) => {
      options.poolId = await promptIfMissing(options.poolId, "CPMM pool address");
      options.amount = await promptNumberIfMissing(options.amount, "Swap amount", (input) =>
        Number.isFinite(Number(input)) && Number(input) > 0 ? true : "Enter a positive amount"
      );
      if (options.exactOut) {
        options.outputMint = await promptIfMissing(options.outputMint, "Output token mint");
      } else {
        options.inputMint = await promptIfMissing(options.inputMint, "Input token mint");
      }
      const config = await loadConfig({ createIfMissing: true });
      let poolId: PublicKey;
      let specifiedMint: PublicKey;
      try {
        poolId = new PublicKey(options.poolId);
        const requestedMint = options.exactOut ? options.outputMint : options.inputMint;
        if (!requestedMint) {
          throw new Error(options.exactOut
            ? "--exact-out requires --output-mint"
            : "An exact-input swap requires --input-mint");
        }
        specifiedMint = await resolveMintPublicKey(requestedMint, { cluster: config.cluster });
      } catch (error) {
        logError(error instanceof Error
          ? error.message
          : options.exactOut
            ? "--exact-out requires a valid --output-mint address"
            : "A valid --pool-id and --input-mint address are required");
        process.exitCode = 1;
        return;
      }

      let slippagePercent: number;
      let priorityFeeMicroLamports: number;
      try {
        slippagePercent = parseSlippagePercent(
          options.slippage ?? String(config["default-slippage"]),
          Boolean(options.allowHighSlippage)
        ).toNumber();
        priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
          options.priorityFee ?? String(config["priority-fee"]),
          Boolean(options.allowHighPriorityFee)
        );
      } catch (error) {
        logError(error instanceof Error ? error.message : "Invalid swap safety setting");
        process.exitCode = 1;
        return;
      }
      const slippage = slippagePercent / 100;

      const buildQuote = async (raydium: Awaited<ReturnType<typeof loadRaydium>>) => {
        const data = await raydium.cpmm.getPoolInfoFromRpc(poolId.toBase58());
        const { poolInfo, poolKeys, rpcData } = data;
        const mintA = new PublicKey(poolInfo.mintA.address);
        const mintB = new PublicKey(poolInfo.mintB.address);
        if (!specifiedMint.equals(mintA) && !specifiedMint.equals(mintB)) {
          throw new Error("Specified mint does not belong to this CPMM pool");
        }

        const baseIn = options.exactOut ? specifiedMint.equals(mintB) : specifiedMint.equals(mintA);
        const amountDecimals = specifiedMint.equals(mintA)
          ? poolInfo.mintA.decimals
          : poolInfo.mintB.decimals;
        const requestedAmount = parseUiAmount(options.amount!, amountDecimals, "Amount");
        const sourceReserve = baseIn ? rpcData.baseReserve : rpcData.quoteReserve;
        const destinationReserve = baseIn ? rpcData.quoteReserve : rpcData.baseReserve;
        if (options.exactOut && requestedAmount.gte(destinationReserve)) {
          throw new Error("Requested output must be less than the current pool reserve");
        }
        const configInfo = rpcData.configInfo;
        if (!configInfo) throw new Error("CPMM pool is missing its fee configuration");
        const feeOnOutput = rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB;

        const swapResult = options.exactOut
          ? CurveCalculator.swapBaseOutput(
              requestedAmount,
              sourceReserve,
              destinationReserve,
              configInfo.tradeFeeRate,
              configInfo.creatorFeeRate,
              configInfo.protocolFeeRate,
              configInfo.fundFeeRate,
              feeOnOutput
            )
          : CurveCalculator.swapBaseInput(
              requestedAmount,
              sourceReserve,
              destinationReserve,
              configInfo.tradeFeeRate,
              configInfo.creatorFeeRate,
              configInfo.protocolFeeRate,
              configInfo.fundFeeRate,
              feeOnOutput
            );

        const inputMint = baseIn ? poolInfo.mintA : poolInfo.mintB;
        const outputMint = baseIn ? poolInfo.mintB : poolInfo.mintA;
        const inputRaw = swapResult.inputAmount;
        const outputRaw = swapResult.outputAmount;

        return {
          poolInfo,
          poolKeys,
          swapResult,
          baseIn,
          quote: {
            poolId: poolId.toBase58(),
            pair: `${getCpmmSymbol(poolInfo.mintA)}/${getCpmmSymbol(poolInfo.mintB)}`,
            swapType: options.exactOut ? "BaseOut" : "BaseIn",
            input: {
              amount: formatRawAmount(inputRaw, inputMint.decimals),
              mint: inputMint.address
            },
            output: {
              amount: formatRawAmount(outputRaw, outputMint.decimals),
              mint: outputMint.address
            },
            protection: options.exactOut
              ? {
                  maximumInput: formatRawAmount(
                    applyCpmmSlippage(inputRaw, slippage, true),
                    inputMint.decimals
                  ),
                  mint: inputMint.address
                }
              : {
                  minimumOutput: formatRawAmount(
                    applyCpmmSlippage(outputRaw, slippage, false),
                    outputMint.decimals
                  ),
                  mint: outputMint.address
                },
            slippagePercent
          }
        };
      };

      try {
        const raydium = await withSpinner("Loading Raydium", () => loadRaydium({ disableLoadToken: true }));
        const quoteData = await withSpinner("Fetching live CPMM quote", () => buildQuote(raydium));
        if (!options.execute) {
          const approvedQuote = withQuoteApprovalId("cpmm-swap-quote", quoteData.quote);
          if (isJsonOutput()) {
            logJson({ action: "cpmm-swap-quote", ...approvedQuote });
          } else {
            logInfo(`CPMM ${quoteData.quote.swapType}: ${quoteData.quote.input.amount} -> ${quoteData.quote.output.amount}`);
            if ("minimumOutput" in quoteData.quote.protection) {
              logInfo(`Minimum output: ${quoteData.quote.protection.minimumOutput}`);
            } else {
              logInfo(`Maximum input: ${quoteData.quote.protection.maximumInput}`);
            }
            logInfo(`Quote ID: ${approvedQuote.quoteId}`);
            logInfo("Quote only. Re-run with --execute to build, simulate, review, and send.");
          }
          return;
        }

        const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
        if (!walletName) throw new Error("No active wallet set");
        const password = await promptPassword("Enter wallet password");
        const owner = await decryptWallet(walletName, password);
        const signingRaydium = await loadRaydium({ owner, disableLoadToken: true });
        const fresh = await withSpinner("Refreshing CPMM quote", () => buildQuote(signingRaydium));
        const built = await withSpinner("Building CPMM swap", () =>
          signingRaydium.cpmm.swap({
            poolInfo: fresh.poolInfo,
            poolKeys: fresh.poolKeys,
            inputAmount: options.exactOut ? new BN(0) : parseUiAmount(options.amount!, specifiedMint.equals(new PublicKey(fresh.poolInfo.mintA.address)) ? fresh.poolInfo.mintA.decimals : fresh.poolInfo.mintB.decimals, "Amount"),
            swapResult: fresh.swapResult,
            fixedOut: Boolean(options.exactOut),
            slippage,
            baseIn: fresh.baseIn,
            txVersion: TxVersion.V0,
            computeBudgetConfig: priorityFeeMicroLamports > 0
              ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
              : undefined
          })
        );
        if (!(built.transaction instanceof VersionedTransaction)) {
          throw new Error("CPMM safe execution requires a single V0 transaction");
        }

        const inputMintInfo = fresh.baseIn ? fresh.poolInfo.mintA : fresh.poolInfo.mintB;
        const outputMintInfo = fresh.baseIn ? fresh.poolInfo.mintB : fresh.poolInfo.mintA;
        const inputIsSol = inputMintInfo.address === NATIVE_MINT.toBase58();
        const outputIsSol = outputMintInfo.address === NATIVE_MINT.toBase58();
        const inputMaxAtomic = BigInt(
          (options.exactOut
            ? applyCpmmSlippage(fresh.swapResult.inputAmount, slippage, true)
            : fresh.swapResult.inputAmount
          ).toString()
        );
        const minOutputAtomic = BigInt(
          (options.exactOut
            ? fresh.swapResult.outputAmount
            : applyCpmmSlippage(fresh.swapResult.outputAmount, slippage, false)
          ).toString()
        );
        const feeAllowanceLamports =
          (BigInt(priorityFeeMicroLamports) * BigInt(DEFAULT_COMPUTE_UNITS) + 999_999n) / 1_000_000n +
          SIGNATURE_FEE_LAMPORTS +
          SWAP_RENT_ALLOWANCE_LAMPORTS;
        const getAta = (mint: { address: string; programId: string }) =>
          getAssociatedTokenAddressSync(
            new PublicKey(mint.address),
            owner.publicKey,
            false,
            new PublicKey(mint.programId)
          );
        const balanceGuards: SimulationBalanceGuards = {
          owner: owner.publicKey,
          minOwnerLamportsDelta:
            (outputIsSol ? minOutputAtomic : 0n) -
            (inputIsSol ? inputMaxAtomic : 0n) -
            feeAllowanceLamports,
          tokenAccounts: [
            ...(!inputIsSol
              ? [{ account: getAta(inputMintInfo), label: "input token account", minDelta: -inputMaxAtomic }]
              : []),
            ...(!outputIsSol
              ? [{ account: getAta(outputMintInfo), label: "output token account", minDelta: minOutputAtomic }]
              : [])
          ]
        };

        await reviewAndExecuteCpmmTransaction({
          transaction: built.transaction,
          owner,
          action: "cpmm-swap-execute",
          quoteAction: "cpmm-swap-quote",
          quote: fresh.quote,
          approvedQuoteId: options.approveQuote,
          requestedPriorityFeeMicroLamports: priorityFeeMicroLamports,
          explorer: { explorer: config.explorer, cluster: config.cluster },
          allowedProgramIds: new Set([...COMMON_TRANSACTION_PROGRAM_IDS, fresh.poolInfo.programId]),
          balanceGuards
        });
      } catch (error) {
        logErrorWithDebug("CPMM swap failed", getCpmmOperationError(error));
        process.exitCode = 1;
      }
    });

  const liquidity = cpmm.command("liquidity").description("Quote or manage CPMM liquidity");

  liquidity
    .command("add")
    .description("Quote or add proportional liquidity to a CPMM pool")
    .option("--pool-id <address>", "CPMM pool address (prompted when omitted)")
    .option("--input-mint <mint-or-symbol>", "Token mint or Raydium APIv3 symbol whose amount you are specifying (prompted when omitted)")
    .option("--amount <number>", "Maximum input token amount (prompted when omitted)")
    .option("--slippage <percent>", "Minimum LP-token minting tolerance")
    .option("--allow-high-slippage", "Allow slippage above the 5% safety cap")
    .option("--priority-fee <sol>", "Priority fee in SOL")
    .option("--allow-high-priority-fee", "Allow priority fee above the 0.01 SOL safety cap")
    .option("--execute", "Build, simulate, review, and send the liquidity deposit")
    .option("--approve-quote <quote-id>", "Required with --json --execute; use quoteId from a fresh quote")
    .action(async (options: {
      poolId?: string;
      inputMint?: string;
      amount?: string;
      slippage?: string;
      allowHighSlippage?: boolean;
      priorityFee?: string;
      allowHighPriorityFee?: boolean;
      execute?: boolean;
      approveQuote?: string;
    }) => {
      options.poolId = await promptIfMissing(options.poolId, "CPMM pool address");
      options.inputMint = await promptIfMissing(options.inputMint, "Input token mint");
      options.amount = await promptNumberIfMissing(options.amount, "Maximum input token amount", (input) =>
        Number.isFinite(Number(input)) && Number(input) > 0 ? true : "Enter a positive amount"
      );
      const config = await loadConfig({ createIfMissing: true });
      let poolId: PublicKey;
      let inputMint: PublicKey;
      try {
        poolId = new PublicKey(options.poolId);
        inputMint = await resolveMintPublicKey(options.inputMint, { cluster: config.cluster });
      } catch (error) {
        logError(error instanceof Error ? error.message : "A valid --pool-id and --input-mint address are required");
        process.exitCode = 1;
        return;
      }

      let slippagePercent: number;
      let priorityFeeMicroLamports: number;
      try {
        slippagePercent = parseSlippagePercent(
          options.slippage ?? String(config["default-slippage"]),
          Boolean(options.allowHighSlippage)
        ).toNumber();
        priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
          options.priorityFee ?? String(config["priority-fee"]),
          Boolean(options.allowHighPriorityFee)
        );
      } catch (error) {
        logError(error instanceof Error ? error.message : "Invalid liquidity safety setting");
        process.exitCode = 1;
        return;
      }
      const slippage = toCpmmSlippageFraction(slippagePercent);

      const buildQuote = async (raydium: Awaited<ReturnType<typeof loadRaydium>>) => {
        const data = await raydium.cpmm.getPoolInfoFromRpc(poolId.toBase58());
        const { poolInfo, poolKeys, rpcData } = data;
        const mintA = new PublicKey(poolInfo.mintA.address);
        const mintB = new PublicKey(poolInfo.mintB.address);
        if (!inputMint.equals(mintA) && !inputMint.equals(mintB)) {
          throw new Error("Input mint does not belong to this CPMM pool");
        }
        const baseIn = inputMint.equals(mintA);
        const inputToken = baseIn ? poolInfo.mintA : poolInfo.mintB;
        const otherToken = baseIn ? poolInfo.mintB : poolInfo.mintA;
        const inputAmount = parseUiAmount(options.amount!, inputToken.decimals, "Amount");
        const compute = raydium.cpmm.computePairAmount({
          poolInfo,
          baseReserve: rpcData.baseReserve,
          quoteReserve: rpcData.quoteReserve,
          amount: options.amount!,
          slippage: new Percent(0),
          epochInfo: await raydium.fetchEpochInfo(),
          baseIn
        });
        const minimumLiquidity = new Percent(new BN(1)).sub(slippage).mul(compute.liquidity).quotient;

        return {
          poolInfo,
          poolKeys,
          inputAmount,
          baseIn,
          quote: {
            poolId: poolId.toBase58(),
            pair: `${getCpmmSymbol(poolInfo.mintA)}/${getCpmmSymbol(poolInfo.mintB)}`,
            input: {
              amount: formatRawAmount(compute.inputAmountFee.amount, inputToken.decimals),
              mint: inputToken.address
            },
            estimatedOtherToken: {
              amount: formatRawAmount(compute.anotherAmount.amount, otherToken.decimals),
              mint: otherToken.address
            },
            minimumLpTokens: {
              amount: formatRawAmount(minimumLiquidity, poolInfo.lpMint.decimals),
              mint: poolInfo.lpMint.address
            },
            slippagePercent
          }
        };
      };

      try {
        const raydium = await withSpinner("Loading Raydium", () => loadRaydium({ disableLoadToken: true }));
        const quoteData = await withSpinner("Fetching CPMM liquidity quote", () => buildQuote(raydium));
        if (!options.execute) {
          const approvedQuote = withQuoteApprovalId("cpmm-liquidity-add-quote", quoteData.quote);
          if (isJsonOutput()) {
            logJson({ action: "cpmm-liquidity-add-quote", ...approvedQuote });
          } else {
            logInfo(`CPMM liquidity quote for ${quoteData.quote.pair}`);
            logInfo(`Input: ${quoteData.quote.input.amount}`);
            logInfo(`Estimated other token: ${quoteData.quote.estimatedOtherToken.amount}`);
            logInfo(`Minimum LP tokens: ${quoteData.quote.minimumLpTokens.amount}`);
            logInfo(`Quote ID: ${approvedQuote.quoteId}`);
            logInfo("Quote only. Re-run with --execute to build, simulate, review, and send.");
          }
          return;
        }

        const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
        if (!walletName) throw new Error("No active wallet set");
        const password = await promptPassword("Enter wallet password");
        const owner = await decryptWallet(walletName, password);
        const signingRaydium = await loadRaydium({ owner, disableLoadToken: true });
        const fresh = await withSpinner("Refreshing CPMM liquidity quote", () => buildQuote(signingRaydium));
        const built = await withSpinner("Building CPMM liquidity deposit", () =>
          signingRaydium.cpmm.addLiquidity({
            poolInfo: fresh.poolInfo,
            poolKeys: fresh.poolKeys,
            inputAmount: fresh.inputAmount,
            baseIn: fresh.baseIn,
            slippage,
            txVersion: TxVersion.V0,
            computeBudgetConfig: priorityFeeMicroLamports > 0
              ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
              : undefined
          })
        );
        if (!(built.transaction instanceof VersionedTransaction)) {
          throw new Error("CPMM safe execution requires a single V0 transaction");
        }
        await reviewAndExecuteCpmmTransaction({
          transaction: built.transaction,
          owner,
          action: "cpmm-liquidity-add-execute",
          quoteAction: "cpmm-liquidity-add-quote",
          quote: fresh.quote,
          approvedQuoteId: options.approveQuote,
          requestedPriorityFeeMicroLamports: priorityFeeMicroLamports,
          explorer: { explorer: config.explorer, cluster: config.cluster },
          allowedProgramIds: new Set([...COMMON_TRANSACTION_PROGRAM_IDS, fresh.poolInfo.programId])
        });
      } catch (error) {
        logErrorWithDebug("CPMM liquidity deposit failed", getCpmmOperationError(error));
        process.exitCode = 1;
      }
    });

  liquidity
    .command("remove")
    .description("Quote or remove CPMM liquidity by LP-token amount")
    .option("--pool-id <address>", "CPMM pool address (prompted when omitted)")
    .option("--lp-amount <number>", "LP token amount to burn (prompted when omitted)")
    .option("--slippage <percent>", "Minimum withdrawal receipt tolerance")
    .option("--allow-high-slippage", "Allow slippage above the 5% safety cap")
    .option("--priority-fee <sol>", "Priority fee in SOL")
    .option("--allow-high-priority-fee", "Allow priority fee above the 0.01 SOL safety cap")
    .option("--keep-wsol", "Keep wrapped SOL instead of unwrapping it")
    .option("--execute", "Build, simulate, review, and send the liquidity withdrawal")
    .option("--approve-quote <quote-id>", "Required with --json --execute; use quoteId from a fresh quote")
    .action(async (options: {
      poolId?: string;
      lpAmount?: string;
      slippage?: string;
      allowHighSlippage?: boolean;
      priorityFee?: string;
      allowHighPriorityFee?: boolean;
      keepWsol?: boolean;
      execute?: boolean;
      approveQuote?: string;
    }) => {
      options.poolId = await promptIfMissing(options.poolId, "CPMM pool address");
      options.lpAmount = await promptNumberIfMissing(options.lpAmount, "LP token amount to burn", (input) =>
        Number.isFinite(Number(input)) && Number(input) > 0 ? true : "Enter a positive amount"
      );
      let poolId: PublicKey;
      try {
        poolId = new PublicKey(options.poolId);
      } catch {
        logError("Invalid --pool-id address");
        process.exitCode = 1;
        return;
      }

      const config = await loadConfig({ createIfMissing: true });
      let slippagePercent: number;
      let priorityFeeMicroLamports: number;
      try {
        slippagePercent = parseSlippagePercent(
          options.slippage ?? String(config["default-slippage"]),
          Boolean(options.allowHighSlippage)
        ).toNumber();
        priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
          options.priorityFee ?? String(config["priority-fee"]),
          Boolean(options.allowHighPriorityFee)
        );
      } catch (error) {
        logError(error instanceof Error ? error.message : "Invalid liquidity safety setting");
        process.exitCode = 1;
        return;
      }
      const slippage = toCpmmSlippageFraction(slippagePercent);

      const buildQuote = async (raydium: Awaited<ReturnType<typeof loadRaydium>>) => {
        const data = await raydium.cpmm.getPoolInfoFromRpc(poolId.toBase58());
        const { poolInfo, poolKeys, rpcData } = data;
        const lpAmount = parseUiAmount(options.lpAmount!, poolInfo.lpMint.decimals, "LP amount");
        if (lpAmount.gt(rpcData.lpAmount)) throw new Error("LP amount exceeds the pool LP-token supply");
        const epochInfo = await raydium.fetchEpochInfo();
        const minimumAmountA = new Percent(new BN(1)).sub(slippage)
          .mul(lpAmount.mul(rpcData.baseReserve).div(rpcData.lpAmount)).quotient;
        const minimumAmountB = new Percent(new BN(1)).sub(slippage)
          .mul(lpAmount.mul(rpcData.quoteReserve).div(rpcData.lpAmount)).quotient;
        const receivedA = minimumAmountA.sub(
          getTransferAmountFeeV2(minimumAmountA, poolInfo.mintA.extensions.feeConfig, epochInfo, false).fee ?? new BN(0)
        );
        const receivedB = minimumAmountB.sub(
          getTransferAmountFeeV2(minimumAmountB, poolInfo.mintB.extensions.feeConfig, epochInfo, false).fee ?? new BN(0)
        );

        return {
          poolInfo,
          poolKeys,
          lpAmount,
          quote: {
            poolId: poolId.toBase58(),
            pair: `${getCpmmSymbol(poolInfo.mintA)}/${getCpmmSymbol(poolInfo.mintB)}`,
            lpTokensBurned: { amount: formatRawAmount(lpAmount, poolInfo.lpMint.decimals), mint: poolInfo.lpMint.address },
            minimumReceipts: {
              mintA: { amount: formatRawAmount(receivedA, poolInfo.mintA.decimals), mint: poolInfo.mintA.address },
              mintB: { amount: formatRawAmount(receivedB, poolInfo.mintB.decimals), mint: poolInfo.mintB.address }
            },
            slippagePercent
          }
        };
      };

      try {
        const raydium = await withSpinner("Loading Raydium", () => loadRaydium({ disableLoadToken: true }));
        const quoteData = await withSpinner("Fetching CPMM withdrawal quote", () => buildQuote(raydium));
        if (!options.execute) {
          const approvedQuote = withQuoteApprovalId("cpmm-liquidity-remove-quote", quoteData.quote);
          if (isJsonOutput()) {
            logJson({ action: "cpmm-liquidity-remove-quote", ...approvedQuote });
          } else {
            logInfo(`CPMM withdrawal quote for ${quoteData.quote.pair}`);
            logInfo(`Burn LP tokens: ${quoteData.quote.lpTokensBurned.amount}`);
            logInfo(`Minimum receipts: ${quoteData.quote.minimumReceipts.mintA.amount} / ${quoteData.quote.minimumReceipts.mintB.amount}`);
            logInfo(`Quote ID: ${approvedQuote.quoteId}`);
            logInfo("Quote only. Re-run with --execute to build, simulate, review, and send.");
          }
          return;
        }

        const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
        if (!walletName) throw new Error("No active wallet set");
        const password = await promptPassword("Enter wallet password");
        const owner = await decryptWallet(walletName, password);
        const signingRaydium = await loadRaydium({ owner, disableLoadToken: true });
        const fresh = await withSpinner("Refreshing CPMM withdrawal quote", () => buildQuote(signingRaydium));
        const built = await withSpinner("Building CPMM liquidity withdrawal", () =>
          signingRaydium.cpmm.withdrawLiquidity({
            poolInfo: fresh.poolInfo,
            poolKeys: fresh.poolKeys,
            lpAmount: fresh.lpAmount,
            slippage,
            closeWsol: !options.keepWsol,
            txVersion: TxVersion.V0,
            computeBudgetConfig: priorityFeeMicroLamports > 0
              ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
              : undefined
          })
        );
        if (!(built.transaction instanceof VersionedTransaction)) {
          throw new Error("CPMM safe execution requires a single V0 transaction");
        }
        await reviewAndExecuteCpmmTransaction({
          transaction: built.transaction,
          owner,
          action: "cpmm-liquidity-remove-execute",
          quoteAction: "cpmm-liquidity-remove-quote",
          quote: fresh.quote,
          approvedQuoteId: options.approveQuote,
          requestedPriorityFeeMicroLamports: priorityFeeMicroLamports,
          explorer: { explorer: config.explorer, cluster: config.cluster },
          allowedProgramIds: new Set([...COMMON_TRANSACTION_PROGRAM_IDS, fresh.poolInfo.programId])
        });
      } catch (error) {
        logErrorWithDebug("CPMM liquidity withdrawal failed", getCpmmOperationError(error));
        process.exitCode = 1;
      }
    });
}
