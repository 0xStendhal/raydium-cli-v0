import { Command } from "commander";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  Curve,
  TxVersion,
  getPdaCreatorVault,
  getPdaLaunchpadPoolId,
  getPdaPlatformVault,
  LAUNCHPAD_PROGRAM
} from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import Decimal from "decimal.js";

import { getApiUrlsForCluster } from "../../lib/api-urls";
import { loadConfig } from "../../lib/config-manager";
import { getConfiguredCluster, loadRaydium } from "../../lib/raydium-client";
import { decryptWallet, resolveWalletIdentifier } from "../../lib/wallet-manager";
import { promptConfirm, promptPassword } from "../../lib/prompt";
import { isJsonOutput, logError, logErrorWithDebug, logInfo, logJson, logSuccess, withSpinner } from "../../lib/output";
import { uploadTokenMetadata } from "../../lib/ipfs";
import { addRichHelp, NON_INTERACTIVE_HELP, PASSWORD_AUTH_HELP } from "../../lib/help";

const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Known Token-2022 quote tokens (use TOKEN_2022_PROGRAM_ID instead of TOKEN_PROGRAM_ID)
// Note: USD1 uses regular Token Program, not Token-2022
const TOKEN_2022_MINTS = new Set<string>([
  // Add Token-2022 mints here as needed
]);

const CURVE_TYPE_NAMES: Record<number, string> = {
  0: "Constant Product",
  1: "Fixed Price",
  2: "Linear Price"
};

const FEE_DENOMINATOR = 1_000_000;
const SLIPPAGE_DENOMINATOR = 10000; // 10000 = 100%
const DEFAULT_COMPUTE_UNITS = 600_000;
const KNOWN_QUOTE_TOKENS = [
  { mint: new PublicKey("So11111111111111111111111111111111111111112"), symbol: "SOL", decimals: 9 },
  { mint: new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"), symbol: "USD1", decimals: 6 },
  { mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), symbol: "USDC", decimals: 6 }
] as const;
const KNOWN_QUOTES: Record<string, string> = {
  "So11111111111111111111111111111111111111112": "SOL",
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB": "USD1",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC"
};

function formatFeeRate(rate: string | number): string {
  const numRate = typeof rate === "string" ? Number(rate) : rate;
  const percent = (numRate / FEE_DENOMINATOR) * 100;
  return `${percent}%`;
}

function formatAmount(raw: string | number, decimals: number): string {
  const value = new Decimal(String(raw)).div(new Decimal(10).pow(decimals));
  return value.toFixed();
}

function parsePositiveDecimal(value: string, label: string): Decimal {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  const decimal = new Decimal(normalized);
  if (!decimal.isFinite() || decimal.lte(0)) {
    throw new Error(`${label} must be greater than zero`);
  }
  return decimal;
}

function parseNonNegativeDecimal(value: string, label: string): Decimal {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  const decimal = new Decimal(normalized);
  if (!decimal.isFinite() || decimal.lt(0)) {
    throw new Error(`Invalid ${label}`);
  }
  return decimal;
}

function parseTokenAmountToBN(value: string, decimals: number, label: string, allowZero = false): BN {
  const decimal = allowZero ? parseNonNegativeDecimal(value, label) : parsePositiveDecimal(value, label);
  const scaled = decimal.mul(new Decimal(10).pow(decimals));
  if (!scaled.isInteger()) {
    throw new Error(`${label} has more than ${decimals} decimal places`);
  }
  return new BN(scaled.toFixed(0));
}

function parseSlippagePercentToBn(value: string): BN {
  const decimal = parseNonNegativeDecimal(value, "slippage percent");
  const scaled = decimal.mul(new Decimal(SLIPPAGE_DENOMINATOR).div(100));
  if (!scaled.isInteger()) {
    throw new Error("Slippage percent supports up to 2 decimal places");
  }
  return new BN(scaled.toFixed(0));
}

function parsePriorityFeeMicroLamports(value: string): number {
  const sol = parseNonNegativeDecimal(value, "priority fee");
  const microLamports = sol
    .mul(new Decimal(1e9))
    .mul(new Decimal(1e6))
    .div(DEFAULT_COMPUTE_UNITS)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return microLamports.toNumber();
}

function formatRawAmount(raw: bigint | string, decimals: number): string {
  return new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toFixed();
}

function formatRateFromBpsString(value: string, decimals = 2): string {
  return new Decimal(value).div(10000).toFixed(decimals);
}

function getQuoteSymbol(mint: PublicKey): string {
  const mintStr = mint.toBase58();
  return KNOWN_QUOTES[mintStr] ?? `${mintStr.slice(0, 8)}...`;
}

function getQuoteCandidates() {
  return KNOWN_QUOTE_TOKENS.map((quote) => ({ mint: quote.mint, symbol: quote.symbol }));
}

function getQuoteCandidatesForMint(mintB?: string): Array<{ mint: PublicKey; symbol: string }> {
  if (!mintB) {
    return getQuoteCandidates();
  }

  let quoteMint: PublicKey;
  try {
    quoteMint = new PublicKey(mintB);
  } catch {
    throw new Error("Invalid quote token mint address for --mint-b");
  }

  return [{ mint: quoteMint, symbol: getQuoteSymbol(quoteMint) }];
}

export function registerLaunchpadCommands(program: Command): void {
  const launchpad = program.command("launchpad").description("Launchpad commands");

  launchpad
    .command("configs")
    .description("List available launchpad configurations")
    .action(async () => {
      const raydium = await withSpinner("Loading Raydium", () =>
        loadRaydium({ disableLoadToken: true })
      );

      const configs = await withSpinner("Fetching launchpad configs", () =>
        raydium.api.fetchLaunchConfigs()
      );

      if (isJsonOutput()) {
        logJson({ configs });
        return;
      }

      if (configs.length === 0) {
        logInfo("No launchpad configurations found");
        return;
      }

      configs.forEach((config) => {
        const curveTypeName = CURVE_TYPE_NAMES[config.key.curveType] ?? `Unknown (${config.key.curveType})`;
        const quoteSymbol = config.mintInfoB?.symbol ?? "Unknown";
        const quoteDecimals = config.mintInfoB?.decimals ?? 9;

        // Default params (tokens have 6 decimals by default)
        const defaultSupply = config.defaultParams?.supplyInit
          ? formatAmount(config.defaultParams.supplyInit, 6)
          : "N/A";
        const defaultSellPercent = config.defaultParams?.totalSellA && config.defaultParams?.supplyInit
          ? ((Number(config.defaultParams.totalSellA) / Number(config.defaultParams.supplyInit)) * 100).toFixed(2)
          : "N/A";
        const defaultRaise = config.defaultParams?.totalFundRaisingB
          ? formatAmount(config.defaultParams.totalFundRaisingB, quoteDecimals)
          : "N/A";

        logInfo(`${quoteSymbol} - ${config.key.name}`);
        logInfo(`  Config: ${config.key.pubKey}`);
        logInfo(`  Quote: ${quoteSymbol} (${config.key.mintB})`);
        logInfo(`  Trade Fee: ${formatFeeRate(config.key.tradeFeeRate)}`);
        logInfo(`  Min Raise: ${formatAmount(config.key.minFundRaisingB, quoteDecimals)} ${quoteSymbol}`);
        logInfo(`  Defaults:`);
        logInfo(`    Supply: ${defaultSupply} tokens`);
        logInfo(`    On Curve: ${defaultSellPercent}%`);
        logInfo(`    Target Raise: ${defaultRaise} ${quoteSymbol}`);
        logInfo(`  Protocol Wallets:`);
        logInfo(`    Protocol Fee Owner: ${config.key.protocolFeeOwner}`);
        logInfo(`    Migrate Fee Owner: ${config.key.migrateFeeOwner}`);
        logInfo(`    Migrate to AMM: ${config.key.migrateToAmmWallet}`);
        logInfo(`    Migrate to CPMM: ${config.key.migrateToCpmmWallet}`);
        logInfo("");
      });
    });

  launchpad
    .command("platforms")
    .description("List LaunchLab platforms")
    .option("--limit <number>", "Max results", "20")
    .option("--page <number>", "Page number", "1")
    .action(async (options: { limit: string; page: string }) => {
      const cluster = await getConfiguredCluster();
      const launchMintHost = getApiUrlsForCluster(cluster).LAUNCH_MINT_HOST;
      const limit = Number(options.limit);
      const page = Number(options.page);

      interface PlatformData {
        pubKey: string;
        name: string;
        web: string;
        img: string;
        feeRate: string;
        creatorFeeRate: string;
        platformScale: string;
        creatorScale: string;
        burnScale: string;
        cpConfigId: string;
        platformClaimFeeWallet: string;
        platformLockNftWallet: string;
      }

      interface PlatformsResponse {
        id: string;
        success: boolean;
        data: {
          data: PlatformData[];
        };
      }

      let platforms: PlatformData[] = [];
      try {
        platforms = await withSpinner("Fetching platforms", async () => {
          const response = await fetch(
            `${launchMintHost}/main/platforms?page=${page}&pageSize=${limit}`
          );
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const json = (await response.json()) as PlatformsResponse;
          return json.data?.data ?? [];
        });
      } catch (error) {
        logError("Failed to fetch platforms", (error as Error).message);
        process.exitCode = 1;
        return;
      }

      if (isJsonOutput()) {
        logJson({ platforms, page, count: platforms.length });
        return;
      }

      if (platforms.length === 0) {
        logInfo("No platforms found");
        return;
      }

      logInfo(`Found ${platforms.length} platforms (page ${page})\n`);

      platforms.forEach((platform) => {
        const feePercent = formatRateFromBpsString(platform.feeRate, 2);
        const creatorFeePercent = formatRateFromBpsString(platform.creatorFeeRate, 2);
        const platformLpPercent = formatRateFromBpsString(platform.platformScale, 1);
        const creatorLpPercent = formatRateFromBpsString(platform.creatorScale, 1);
        const burnLpPercent = formatRateFromBpsString(platform.burnScale, 1);

        logInfo(`${platform.name}`);
        logInfo(`  ID: ${platform.pubKey}`);
        if (platform.web) logInfo(`  Web: ${platform.web}`);
        logInfo(`  Fees: ${feePercent}% platform, ${creatorFeePercent}% creator`);
        logInfo(`  LP Split: ${platformLpPercent}% platform / ${creatorLpPercent}% creator / ${burnLpPercent}% burn`);
        logInfo("");
      });
    });

  const USD1_MINT = new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB");

  launchpad
    .command("info")
    .description("Get launchpad pool info")
    .option("--mint <address>", "Token mint address (derives pool from mint + quote)")
    .option("--pool <address>", "Direct pool address")
    .option("--usd1", "Use USD1 as quote token instead of SOL (only with --mint)")
    .action(async (options: { mint?: string; pool?: string; usd1?: boolean }) => {
      if (!options.mint && !options.pool) {
        logError("Must specify either --mint or --pool");
        process.exitCode = 1;
        return;
      }

      if (options.mint && options.pool) {
        logError("Cannot specify both --mint and --pool");
        process.exitCode = 1;
        return;
      }

      if (options.pool && options.usd1) {
        logError("--usd1 can only be used together with --mint because --pool already selects the quote token");
        process.exitCode = 1;
        return;
      }

      let poolId: PublicKey;

      if (options.pool) {
        try {
          poolId = new PublicKey(options.pool);
        } catch {
          logError("Invalid pool address");
          process.exitCode = 1;
          return;
        }
      } else {
        // Derive pool ID from mint + quote token
        let mintA: PublicKey;
        try {
          mintA = new PublicKey(options.mint!);
        } catch {
          logError("Invalid mint address");
          process.exitCode = 1;
          return;
        }

        const mintB = options.usd1 ? USD1_MINT : NATIVE_MINT;
        const { publicKey } = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintA, mintB);
        poolId = publicKey;

        if (!isJsonOutput()) {
          logInfo(`Derived pool: ${poolId.toBase58()}`);
          logInfo(`Quote token: ${options.usd1 ? "USD1" : "SOL"}`);
          logInfo("");
        }
      }

      const raydium = await withSpinner("Loading Raydium", () =>
        loadRaydium({ disableLoadToken: true })
      );

      type LaunchpadRpcPoolInfo = Awaited<ReturnType<typeof raydium.launchpad.getRpcPoolInfo>>;
      let poolInfo: LaunchpadRpcPoolInfo;
      try {
        poolInfo = await withSpinner("Fetching pool info", () =>
          raydium.launchpad.getRpcPoolInfo({ poolId })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("Failed to fetch pool info", message);
        process.exitCode = 1;
        return;
      }

      const curveType = poolInfo.configInfo.curveType;
      const decimalA = poolInfo.mintDecimalsA;
      const decimalB = poolInfo.mintDecimalsB;

      // Calculate current price
      const currentPrice = Curve.getPrice({
        poolInfo,
        curveType,
        decimalA,
        decimalB
      });

      // Calculate progress
      const soldAmount = new Decimal(poolInfo.realA.toString());
      const totalSellAmount = new Decimal(poolInfo.totalSellA.toString());
      const progressPercent = totalSellAmount.isZero()
        ? new Decimal(0)
        : soldAmount.div(totalSellAmount).mul(100);

      // Calculate raised amount
      const raisedAmount = new Decimal(poolInfo.realB.toString());
      const targetAmount = new Decimal(poolInfo.totalFundRaisingB.toString());

      if (isJsonOutput()) {
        logJson({
          poolId: poolId.toBase58(),
          status: poolInfo.status,
          mintA: poolInfo.mintA.toBase58(),
          mintB: poolInfo.mintB.toBase58(),
          mintDecimalsA: decimalA,
          mintDecimalsB: decimalB,
          curveType,
          currentPrice: currentPrice.toFixed(),
          progress: {
            sold: poolInfo.realA.toString(),
            total: poolInfo.totalSellA.toString(),
            percent: progressPercent.toFixed(2)
          },
          raised: {
            current: poolInfo.realB.toString(),
            target: poolInfo.totalFundRaisingB.toString()
          },
          vestingSchedule: {
            totalLockedAmount: poolInfo.vestingSchedule.totalLockedAmount.toString(),
            cliffPeriod: poolInfo.vestingSchedule.cliffPeriod.toString(),
            unlockPeriod: poolInfo.vestingSchedule.unlockPeriod.toString()
          },
          creator: poolInfo.creator.toBase58(),
          configId: poolInfo.configId.toBase58(),
          platformId: poolInfo.platformId.toBase58()
        });
        return;
      }

      const curveTypeName = CURVE_TYPE_NAMES[curveType] ?? `Unknown (${curveType})`;
      const soldFormatted = formatAmount(poolInfo.realA.toString(), decimalA);
      const totalSellFormatted = formatAmount(poolInfo.totalSellA.toString(), decimalA);
      const raisedFormatted = formatAmount(poolInfo.realB.toString(), decimalB);
      const targetFormatted = formatAmount(poolInfo.totalFundRaisingB.toString(), decimalB);

      logInfo(`Pool: ${poolId.toBase58()}`);
      logInfo(`Status: ${poolInfo.status}`);
      logInfo(`Token (mintA): ${poolInfo.mintA.toBase58()}`);
      logInfo(`Quote (mintB): ${poolInfo.mintB.toBase58()}`);
      logInfo("");
      logInfo(`Curve: ${curveTypeName}`);
      logInfo(`Current Price: ${currentPrice.toFixed()} (mintB per mintA)`);
      logInfo("");
      logInfo(`Progress: ${progressPercent.toFixed(2)}%`);
      logInfo(`  Sold: ${soldFormatted} / ${totalSellFormatted}`);
      logInfo(`  Raised: ${raisedFormatted} / ${targetFormatted}`);
      logInfo("");
      logInfo(`Creator: ${poolInfo.creator.toBase58()}`);

      if (!poolInfo.vestingSchedule.totalLockedAmount.isZero()) {
        const lockedFormatted = formatAmount(poolInfo.vestingSchedule.totalLockedAmount.toString(), decimalA);
        logInfo("");
        logInfo("Vesting Schedule:");
        logInfo(`  Locked: ${lockedFormatted}`);
        logInfo(`  Cliff: ${poolInfo.vestingSchedule.cliffPeriod.toString()} seconds`);
        logInfo(`  Unlock: ${poolInfo.vestingSchedule.unlockPeriod.toString()} seconds`);
      }
    });

  // Buy command - spend mintB (SOL/USDC/USD1) to get mintA (token)
  addRichHelp(
    launchpad
      .command("buy")
      .description("Buy tokens from a launchpad pool")
      .requiredOption("--mint <address>", "Token mint address (mintA)")
      .requiredOption("--amount <number>", "Amount of quote token to spend")
      .option("--mint-b <address>", "Quote token mint to spend (defaults to auto-discovery across SOL, USD1, USDC)")
      .option("--slippage <percent>", "Slippage tolerance in percent")
      .option("--priority-fee <sol>", "Priority fee in SOL")
      .option("--debug", "Print full error on failure"),
    {
      summary: "Buys launchpad tokens by spending the matching quote token for the discovered pool.",
      auth: PASSWORD_AUTH_HELP,
      units: [
        "--amount is a decimal UI amount of the quote token you are spending.",
        "--slippage is a percent such as 1 for 1%.",
        "--priority-fee is in SOL."
      ],
      defaults: [
        "The command discovers the pool by trying supported quote tokens for the configured cluster.",
        "Current quote-token discovery checks SOL, USD1, and USDC."
      ],
      nonInteractive: NON_INTERACTIVE_HELP,
      examples: [
        "raydium launchpad buy --mint <token-mint> --amount 0.25",
        "raydium launchpad buy --mint <token-mint> --mint-b EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --amount 100",
        "raydium launchpad buy --mint <token-mint> --amount 100 --slippage 0.5"
      ]
    }
  )
    .action(async (options: {
      mint: string;
      amount: string;
      mintB?: string;
      slippage?: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

      // Validate slippage
      let slippagePercent: Decimal;
      let slippageBps: BN;
      try {
        slippagePercent = parseNonNegativeDecimal(
          options.slippage ?? String(config["default-slippage"]),
          "slippage percent"
        );
        slippageBps = parseSlippagePercentToBn(slippagePercent.toString());
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

      // Validate priority fee
      let priorityFeeMicroLamports: number;
      try {
        priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
          options.priorityFee ?? String(config["priority-fee"])
        );
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

      // Check wallet
      const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
      if (!walletName) {
        logError("No active wallet set. Use 'raydium wallet use <name>' to set one.");
        process.exitCode = 1;
        return;
      }

      // Validate mint address
      let mintA: PublicKey;
      try {
        mintA = new PublicKey(options.mint);
      } catch {
        logError("Invalid mint address");
        process.exitCode = 1;
        return;
      }

      // Validate amount
      try {
        parsePositiveDecimal(options.amount, "amount");
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

      let quoteCandidates: Array<{ mint: PublicKey; symbol: string }>;
      try {
        quoteCandidates = getQuoteCandidatesForMint(options.mintB);
      } catch (error) {
        logError((error as Error).message);
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

      // First fetch pool info to get the quote token (mintB) and its decimals
      // Try different quote tokens (SOL, USD1, USDC) to find the pool
      type LaunchpadRpcPoolInfo = Awaited<ReturnType<typeof raydium.launchpad.getRpcPoolInfo>>;
      let poolInfo: LaunchpadRpcPoolInfo;
      let mintB: PublicKey | undefined;
      try {
        poolInfo = await withSpinner<LaunchpadRpcPoolInfo>("Fetching pool info", async () => {
          for (const quote of quoteCandidates) {
            try {
              const { publicKey: poolId } = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintA, quote.mint);
              const info = await raydium.launchpad.getRpcPoolInfo({ poolId });
              mintB = quote.mint;
              return info;
            } catch {
              // Try next quote token
            }
          }
          throw new Error(
            options.mintB
              ? `No launchpad pool found for token ${mintA.toBase58()} with quote token ${options.mintB}`
              : "No launchpad pool found for this token with SOL, USD1, or USDC"
          );
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("Failed to find launchpad pool for this token", message);
        process.exitCode = 1;
        return;
      }

      const mintBDecimals = poolInfo.mintDecimalsB;
      const mintBStr = mintB!.toBase58();

      // Identify quote token for display
      const quoteSymbol = getQuoteSymbol(mintB!);

      logInfo(`Pool quote token: ${quoteSymbol} (${mintBStr})`);
      logInfo(`You need ${quoteSymbol} to buy from this pool.`);

      // Build buy transaction
      type BuyTxData = Awaited<ReturnType<typeof raydium.launchpad.buyToken>>;
      let txData: BuyTxData;
      let extInfo: BuyTxData["extInfo"];
      try {
        const result = await withSpinner("Building buy transaction", async () => {
          // Convert amount using the correct decimals for the quote token
          const buyAmountRaw = parseTokenAmountToBN(options.amount, mintBDecimals, "amount");

          return raydium.launchpad.buyToken({
            mintA,
            mintB: mintB!,
            poolInfo,
            buyAmount: buyAmountRaw,
            slippage: slippageBps,
            txVersion: TxVersion.V0,
            computeBudgetConfig: priorityFeeMicroLamports > 0
              ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
              : undefined
          });
        });
        txData = result;
        extInfo = result.extInfo;
      } catch (error) {
        logErrorWithDebug("Failed to build transaction", error, { debug: options.debug, fallback: "Failed to build transaction" });
        process.exitCode = 1;
        return;
      }

      // Show preview
      const outAmount = extInfo.decimalOutAmount;
      const minOutAmount = extInfo.minDecimalOutAmount;

      if (isJsonOutput()) {
        logJson({
          action: "buy",
          input: { amount: options.amount, token: quoteSymbol, mint: mintBStr },
          output: {
            estimated: outAmount.toFixed(),
            minimum: minOutAmount.toFixed()
          },
          slippage: slippagePercent.toString(),
          fees: {
            platform: extInfo.splitFee.platformFee.toString(),
            protocol: extInfo.splitFee.protocolFee.toString(),
            creator: extInfo.splitFee.creatorFee.toString()
          }
        });
      } else {
        logInfo("");
        logInfo(`Buying tokens from launchpad`);
        logInfo(`Input: ${options.amount} ${quoteSymbol}`);
        logInfo(`Estimated output: ${outAmount.toFixed()} tokens`);
        logInfo(`Minimum output: ${minOutAmount.toFixed()} tokens`);
        logInfo(`Slippage: ${slippagePercent.toString()}%`);
      }

      // Confirm
      const ok = await promptConfirm("Proceed with buy?", false);
      if (!ok) {
        logInfo("Cancelled");
        return;
      }

      // Execute transaction
      let result: { txId: string };
      try {
        result = await withSpinner("Sending transaction", async () => {
          const executed = await txData.execute({ sendAndConfirm: true });
          return { txId: executed.txId };
        });
      } catch (error) {
        logErrorWithDebug("Buy failed", error, { debug: options.debug, fallback: "Buy failed" });
        process.exitCode = 1;
        return;
      }

      if (isJsonOutput()) {
        logJson({ txId: result.txId });
      } else {
        logSuccess(`Buy submitted: ${result.txId}`);
      }
    });

  // Sell command - sell mintA (token) to get mintB (SOL/USDC/USD1)
  launchpad
    .command("sell")
    .description("Sell tokens back to a launchpad pool")
    .requiredOption("--mint <address>", "Token mint address (mintA)")
    .requiredOption("--amount <number>", "Amount of tokens to sell")
    .option("--mint-b <address>", "Quote token mint to receive (defaults to auto-discovery across SOL, USD1, USDC)")
    .option("--slippage <percent>", "Slippage tolerance in percent")
    .option("--priority-fee <sol>", "Priority fee in SOL")
    .option("--debug", "Print full error on failure")
    .addHelpText("after", "\nAuth:\n  Use --password-stdin or the interactive password prompt. --password requires --unsafe-secret-flags.\n")
    .action(async (options: {
      mint: string;
      amount: string;
      mintB?: string;
      slippage?: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

      // Validate slippage
      let slippagePercent: Decimal;
      let slippageBps: BN;
      try {
        slippagePercent = parseNonNegativeDecimal(
          options.slippage ?? String(config["default-slippage"]),
          "slippage percent"
        );
        slippageBps = parseSlippagePercentToBn(slippagePercent.toString());
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

      // Validate priority fee
      let priorityFeeMicroLamports: number;
      try {
        priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
          options.priorityFee ?? String(config["priority-fee"])
        );
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

      // Check wallet
      const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
      if (!walletName) {
        logError("No active wallet set. Use 'raydium wallet use <name>' to set one.");
        process.exitCode = 1;
        return;
      }

      // Validate mint address
      let mintA: PublicKey;
      try {
        mintA = new PublicKey(options.mint);
      } catch {
        logError("Invalid mint address");
        process.exitCode = 1;
        return;
      }

      // Validate amount
      try {
        parsePositiveDecimal(options.amount, "amount");
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

      let quoteCandidates: Array<{ mint: PublicKey; symbol: string }>;
      try {
        quoteCandidates = getQuoteCandidatesForMint(options.mintB);
      } catch (error) {
        logError((error as Error).message);
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

      // First fetch pool info to get the quote token (mintB) and its decimals
      // Try different quote tokens (SOL, USD1, USDC) to find the pool
      type LaunchpadRpcPoolInfo = Awaited<ReturnType<typeof raydium.launchpad.getRpcPoolInfo>>;
      let poolInfo: LaunchpadRpcPoolInfo;
      let mintB: PublicKey | undefined;
      try {
        poolInfo = await withSpinner<LaunchpadRpcPoolInfo>("Fetching pool info", async () => {
          for (const quote of quoteCandidates) {
            try {
              const { publicKey: poolId } = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintA, quote.mint);
              const info = await raydium.launchpad.getRpcPoolInfo({ poolId });
              mintB = quote.mint;
              return info;
            } catch {
              // Try next quote token
            }
          }
          throw new Error(
            options.mintB
              ? `No launchpad pool found for token ${mintA.toBase58()} with quote token ${options.mintB}`
              : "No launchpad pool found for this token with SOL, USD1, or USDC"
          );
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError("Failed to find launchpad pool for this token", message);
        process.exitCode = 1;
        return;
      }

      const mintADecimals = poolInfo.mintDecimalsA;
      const mintBDecimals = poolInfo.mintDecimalsB;
      const mintBStr = mintB!.toBase58();

      // Identify quote token for display
      const quoteSymbol = getQuoteSymbol(mintB!);

      logInfo(`Pool quote token: ${quoteSymbol} (${mintBStr})`);
      logInfo(`You will receive ${quoteSymbol} from this sale.`);

      // Build sell transaction to get quote
      type SellTxData = Awaited<ReturnType<typeof raydium.launchpad.sellToken>>;
      let txData: SellTxData;
      let extInfo: SellTxData["extInfo"];
      try {
        const result = await withSpinner("Building sell transaction", async () => {
          // Convert amount using the correct decimals for mintA
          const sellAmountRaw = parseTokenAmountToBN(options.amount, mintADecimals, "amount");

          return raydium.launchpad.sellToken({
            mintA,
            mintB: mintB!,
            poolInfo,
            sellAmount: sellAmountRaw,
            slippage: slippageBps,
            txVersion: TxVersion.V0,
            computeBudgetConfig: priorityFeeMicroLamports > 0
              ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
              : undefined
          });
        });
        txData = result;
        extInfo = result.extInfo;
      } catch (error) {
        logErrorWithDebug("Failed to build transaction", error, { debug: options.debug, fallback: "Failed to build transaction" });
        process.exitCode = 1;
        return;
      }

      // Show preview
      const outAmountRaw = extInfo.outAmount;
      const outAmountFormatted = formatRawAmount(outAmountRaw.toString(), mintBDecimals);

      if (isJsonOutput()) {
        logJson({
          action: "sell",
          input: { amount: options.amount, token: "mintA" },
          output: {
            amount: outAmountRaw.toString(),
            formatted: outAmountFormatted,
            token: quoteSymbol,
            mint: mintBStr
          },
          slippage: slippagePercent.toString()
        });
      } else {
        logInfo("");
        logInfo(`Selling tokens to launchpad`);
        logInfo(`Input: ${options.amount} tokens`);
        logInfo(`Minimum output: ${outAmountFormatted} ${quoteSymbol}`);
        logInfo(`Slippage: ${slippagePercent.toString()}%`);
      }

      // Confirm
      const ok = await promptConfirm("Proceed with sell?", false);
      if (!ok) {
        logInfo("Cancelled");
        return;
      }

      // Execute transaction
      let result: { txId: string };
      try {
        result = await withSpinner("Sending transaction", async () => {
          const executed = await txData.execute({ sendAndConfirm: true });
          return { txId: executed.txId };
        });
      } catch (error) {
        logErrorWithDebug("Sell failed", error, { debug: options.debug, fallback: "Sell failed" });
        process.exitCode = 1;
        return;
      }

      if (isJsonOutput()) {
        logJson({ txId: result.txId });
      } else {
        logSuccess(`Sell submitted: ${result.txId}`);
      }
    });

  // Create platform config command
  launchpad
    .command("create-platform")
    .description("Create a new launchpad platform configuration")
    .requiredOption("--name <string>", "Platform name")
    .option("--fee-rate <bps>", "Platform fee in basis points (default: 100 = 1%)", "100")
    .option("--creator-fee-rate <bps>", "Creator fee in basis points (default: 50 = 0.5%)", "50")
    .option("--platform-scale <percent>", "Platform LP % on migration (default: 50)", "50")
    .option("--creator-scale <percent>", "Creator LP % on migration (default: 50)", "50")
    .option("--burn-scale <percent>", "Burn LP % on migration (default: 0)", "0")
    .option("--web <url>", "Platform website URL")
    .option("--img <url>", "Platform logo image URL")
    .option("--priority-fee <sol>", "Priority fee in SOL")
    .option("--debug", "Print full error on failure")
    .addHelpText("after", "\nAuth:\n  Use --password-stdin or the interactive password prompt. --password requires --unsafe-secret-flags.\n")
    .action(async (options: {
      name: string;
      feeRate: string;
      creatorFeeRate: string;
      platformScale: string;
      creatorScale: string;
      burnScale: string;
      web?: string;
      img?: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

      // Validate fee rates
      const feeRateBps = Number(options.feeRate);
      const creatorFeeRateBps = Number(options.creatorFeeRate);
      if (!Number.isFinite(feeRateBps) || feeRateBps < 0 || feeRateBps > 1000000) {
        logError("Invalid fee rate (must be 0-1000000 bps)");
        process.exitCode = 1;
        return;
      }
      if (!Number.isFinite(creatorFeeRateBps) || creatorFeeRateBps < 0 || creatorFeeRateBps > 1000000) {
        logError("Invalid creator fee rate (must be 0-1000000 bps)");
        process.exitCode = 1;
        return;
      }

      // Validate LP scales (must sum to 100)
      const platformScale = Number(options.platformScale);
      const creatorScale = Number(options.creatorScale);
      const burnScale = Number(options.burnScale);
      if (
        !Number.isFinite(platformScale) ||
        !Number.isFinite(creatorScale) ||
        !Number.isFinite(burnScale)
      ) {
        logError("Platform, creator, and burn LP scales must be numeric percentages");
        process.exitCode = 1;
        return;
      }
      if (platformScale < 0 || platformScale > 100 || creatorScale < 0 || creatorScale > 100 || burnScale < 0 || burnScale > 100) {
        logError("Platform, creator, and burn LP scales must each be between 0 and 100");
        process.exitCode = 1;
        return;
      }
      if (platformScale + creatorScale + burnScale !== 100) {
        logError("LP scales must sum to 100 (platform + creator + burn)");
        process.exitCode = 1;
        return;
      }

      // Validate priority fee
      let priorityFeeMicroLamports: number;
      try {
        priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
          options.priorityFee ?? String(config["priority-fee"])
        );
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

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

      // Fetch CPMM configs to get a valid cpConfigId for pool migration
      const cpmmConfigs = await withSpinner("Fetching CPMM configs", () =>
        raydium.api.getCpmmConfigs()
      );

      if (cpmmConfigs.length === 0) {
        logError("No CPMM configs available from API");
        process.exitCode = 1;
        return;
      }

      const selectedCpmmConfig = cpmmConfigs[0];

      // Convert percentages to scale (1,000,000 denominator)
      const platformScaleBN = new BN(platformScale * 10000);
      const creatorScaleBN = new BN(creatorScale * 10000);
      const burnScaleBN = new BN(burnScale * 10000);

      // Convert fee rates (bps to 1,000,000 denominator: 100 bps = 1% = 10000)
      const feeRateBN = new BN(feeRateBps * 100);
      const creatorFeeRateBN = new BN(creatorFeeRateBps * 100);

      // Show preview
      if (isJsonOutput()) {
        logJson({
          action: "create-platform",
          name: options.name,
          feeRate: `${feeRateBps / 100}%`,
          creatorFeeRate: `${creatorFeeRateBps / 100}%`,
          lpSplit: {
            platform: `${platformScale}%`,
            creator: `${creatorScale}%`,
            burn: `${burnScale}%`
          },
          cpmmConfig: selectedCpmmConfig.id
        });
      } else {
        logInfo("");
        logInfo(`Creating Platform Config`);
        logInfo(`  Name: ${options.name}`);
        logInfo(`  Platform Fee: ${feeRateBps / 100}%`);
        logInfo(`  Creator Fee: ${creatorFeeRateBps / 100}%`);
        logInfo(`  LP Split: ${platformScale}% platform / ${creatorScale}% creator / ${burnScale}% burn`);
        logInfo(`  CPMM Config: ${selectedCpmmConfig.id}`);
        if (options.web) logInfo(`  Website: ${options.web}`);
        if (options.img) logInfo(`  Image: ${options.img}`);
      }

      // Confirm
      const ok = await promptConfirm("Proceed with creating platform?", false);
      if (!ok) {
        logInfo("Cancelled");
        return;
      }

      // Build transaction
      type CreatePlatformTxData = Awaited<ReturnType<typeof raydium.launchpad.createPlatformConfig>>;
      let txData: CreatePlatformTxData;
      let extInfo: CreatePlatformTxData["extInfo"];
      try {
        const result = await withSpinner("Building transaction", async () => {
          return raydium.launchpad.createPlatformConfig({
            platformAdmin: owner.publicKey,
            platformClaimFeeWallet: owner.publicKey,
            platformLockNftWallet: owner.publicKey,
            platformVestingWallet: owner.publicKey,
            cpConfigId: new PublicKey(selectedCpmmConfig.id),
            migrateCpLockNftScale: {
              platformScale: platformScaleBN,
              creatorScale: creatorScaleBN,
              burnScale: burnScaleBN
            },
            transferFeeExtensionAuth: owner.publicKey,
            feeRate: feeRateBN,
            creatorFeeRate: creatorFeeRateBN,
            name: options.name,
            web: options.web ?? "",
            img: options.img ?? "",
            platformVestingScale: new BN(0),
            txVersion: TxVersion.V0,
            computeBudgetConfig: priorityFeeMicroLamports > 0
              ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
              : undefined
          });
        });
        txData = result;
        extInfo = result.extInfo;
      } catch (error) {
        logErrorWithDebug("Failed to build transaction", error, { debug: options.debug, fallback: "Failed to build transaction" });
        process.exitCode = 1;
        return;
      }

      // Execute transaction
      let result: { txId: string };
      try {
        result = await withSpinner("Sending transaction", async () => {
          const executed = await txData.execute({ sendAndConfirm: true });
          return { txId: executed.txId };
        });
      } catch (error) {
        logErrorWithDebug("Create platform failed", error, {
          debug: options.debug,
          fallback: "Transaction failed (no error message from SDK)"
        });
        process.exitCode = 1;
        return;
      }

      if (isJsonOutput()) {
        logJson({
          txId: result.txId,
          platformId: extInfo.platformId.toBase58()
        });
      } else {
        logSuccess(`Platform created: ${result.txId}`);
        logInfo(`Platform ID: ${extInfo.platformId.toBase58()}`);
      }
    });

  // Create launchpad (launch a new token) command
  addRichHelp(
    launchpad
      .command("create")
      .description("Launch a new token with a bonding curve")
      .requiredOption("--platform-id <address>", "Platform config address")
      .requiredOption("--name <string>", "Token name")
      .requiredOption("--symbol <string>", "Token symbol")
      .option("--image <path>", "Path to token image (uploads to IPFS)")
      .option("--uri <string>", "Token metadata URI (use instead of --image if you have a URI)")
      .option("--description <string>", "Token description")
      .option("--twitter <url>", "Twitter URL")
      .option("--telegram <url>", "Telegram URL")
      .option("--website <url>", "Website URL")
      .option("--config-id <address>", "Launchpad config ID (auto-detected if not specified)")
      .option("--decimals <number>", "Token decimals (default: 6)", "6")
      .option("--buy-amount <sol>", "Initial SOL to buy (optional dev buy)")
      .option("--slippage <percent>", "Slippage tolerance for initial buy (default: 1)", "1")
      .option("--priority-fee <sol>", "Priority fee in SOL")
      .option("--debug", "Print full error on failure"),
    {
      summary: "Creates a new launchpad token and optionally performs an initial buy in the same workflow.",
      auth: PASSWORD_AUTH_HELP,
      units: [
        "--decimals is the token mint decimals.",
        "--buy-amount is a SOL amount for the optional initial buy.",
        "--slippage is a percent such as 1 for 1%.",
        "--priority-fee is in SOL."
      ],
      defaults: [
        "Provide either --image or --uri.",
        "--config-id is auto-detected if omitted.",
        "--decimals defaults to 6 and --slippage defaults to 1."
      ],
      nonInteractive: NON_INTERACTIVE_HELP,
      examples: [
        "raydium launchpad create --platform-id <platform-id> --name 'My Token' --symbol MTK --image ./token.png",
        "raydium launchpad create --platform-id <platform-id> --name 'My Token' --symbol MTK --uri https://example.com/meta.json --buy-amount 0.25"
      ],
      notes: "If both --image and --uri are omitted, the command fails before any transaction is built."
    }
  )
    .action(async (options: {
      platformId: string;
      name: string;
      symbol: string;
      image?: string;
      uri?: string;
      description?: string;
      twitter?: string;
      telegram?: string;
      website?: string;
      configId?: string;
      decimals: string;
      buyAmount?: string;
      slippage: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

      // Validate that either --image or --uri is provided
      if (!options.image && !options.uri) {
        logError("Either --image or --uri is required");
        logInfo("  --image <path>  Path to local image file (auto-uploads to IPFS)");
        logInfo("  --uri <url>     Pre-hosted metadata URI");
        process.exitCode = 1;
        return;
      }

      if (options.image && options.uri) {
        logError("Choose only one metadata source: --image or --uri");
        logInfo("Use --image to upload metadata through Pinata, or --uri to reuse existing hosted metadata.");
        process.exitCode = 1;
        return;
      }

      // Validate platform ID
      let platformId: PublicKey;
      try {
        platformId = new PublicKey(options.platformId);
      } catch {
        logError("Invalid platform ID address");
        process.exitCode = 1;
        return;
      }

      if (options.configId) {
        try {
          new PublicKey(options.configId);
        } catch {
          logError("Invalid launchpad config ID address");
          process.exitCode = 1;
          return;
        }
      }

      // Validate decimals
      const decimals = Number(options.decimals);
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 9) {
        logError("Invalid decimals (must be 0-9)");
        process.exitCode = 1;
        return;
      }

      // Validate slippage
      let slippagePercent: Decimal;
      let slippageBps: BN;
      try {
        slippagePercent = parseNonNegativeDecimal(options.slippage, "slippage percent");
        slippageBps = parseSlippagePercentToBn(slippagePercent.toString());
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

      // Validate buy amount
      let buyAmountLamports = new BN(0);
      if (options.buyAmount) {
        try {
          buyAmountLamports = parseTokenAmountToBN(options.buyAmount, 9, "buy amount", true);
        } catch (error) {
          logError((error as Error).message);
          process.exitCode = 1;
          return;
        }
      }

      // Validate priority fee
      let priorityFeeMicroLamports: number;
      try {
        priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
          options.priorityFee ?? String(config["priority-fee"])
        );
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

      // Check wallet
      const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
      if (!walletName) {
        logError("No active wallet set. Use 'raydium wallet use <name>' to set one.");
        process.exitCode = 1;
        return;
      }

      // Handle image upload to IPFS if --image is provided
      let metadataUri: string;
      let imageUrl: string | undefined;

      if (options.image) {
        // Check if Pinata JWT is configured
        const pinataJwt = config["pinata-jwt"];
        if (!pinataJwt) {
          logError("Pinata JWT not configured");
          logInfo("Get a free JWT at https://pinata.cloud and run:");
          logInfo("  raydium config set pinata-jwt <your-jwt>");
          process.exitCode = 1;
          return;
        }

        try {
          const result = await withSpinner("Uploading to IPFS", () =>
            uploadTokenMetadata({
              imagePath: options.image!,
              name: options.name,
              symbol: options.symbol,
              description: options.description,
              twitter: options.twitter,
              telegram: options.telegram,
              website: options.website,
              apiKey: pinataJwt,
            })
          );
          metadataUri = result.uri;
          imageUrl = result.imageUrl;
          logInfo(`Image: ${imageUrl}`);
          logInfo(`Metadata: ${metadataUri}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logError("Failed to upload to IPFS", message);
          process.exitCode = 1;
          return;
        }
      } else {
        metadataUri = options.uri!;
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

      // Fetch platform info to get associated configs
      interface PlatformData {
        pubKey: string;
        name: string;
        cpConfigId: string;
        feeRate: string;
        creatorFeeRate: string;
      }

      interface PlatformsResponse {
        id: string;
        success: boolean;
        data: {
          data: PlatformData[];
        };
      }

      let platformInfo: PlatformData | undefined;
      try {
        platformInfo = await withSpinner("Fetching platform info", async () => {
          const cluster = await getConfiguredCluster();
          const launchMintHost = getApiUrlsForCluster(cluster).LAUNCH_MINT_HOST;
          const response = await fetch(
            `${launchMintHost}/main/platforms?pageSize=100`
          );
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const json = (await response.json()) as PlatformsResponse;
          const platforms = json.data?.data ?? [];
          return platforms.find((p) => p.pubKey === platformId.toBase58());
        });
      } catch (error) {
        logError("Failed to fetch platform info", (error as Error).message);
        process.exitCode = 1;
        return;
      }

      if (!platformInfo) {
        if (!isJsonOutput()) {
          logInfo(`Platform not found in API, using on-chain ID: ${platformId.toBase58()}`);
        }
      }

      // Fetch available launchpad configs from API
      const launchConfigs = await withSpinner("Fetching launchpad configs", () =>
        raydium.api.fetchLaunchConfigs()
      );

      if (launchConfigs.length === 0) {
        logError("No launchpad configs available from API");
        process.exitCode = 1;
        return;
      }

      // Select config: use provided config-id, or find SOL config
      let selectedConfig: (typeof launchConfigs)[number];
      if (options.configId) {
        const matchingConfig = launchConfigs.find((c) => c.key.pubKey === options.configId);
        if (!matchingConfig) {
          logError(`Config not found: ${options.configId}`);
          logInfo("Available configs:");
          launchConfigs.forEach((c) => {
            logInfo(`  ${c.key.pubKey} (${c.mintInfoB.symbol})`);
          });
          process.exitCode = 1;
          return;
        }
        selectedConfig = matchingConfig;
      } else {
        // Find a config that uses SOL as the quote token
        const solConfig = launchConfigs.find(
          (c) => c.mintInfoB.symbol === "SOL" || c.mintInfoB.symbol === "WSOL"
        );
        selectedConfig = solConfig || launchConfigs[0]!;
      }

      if (
        options.buyAmount &&
        selectedConfig.mintInfoB.symbol !== "SOL" &&
        selectedConfig.mintInfoB.symbol !== "WSOL"
      ) {
        logError(
          `--buy-amount is currently interpreted in SOL, but config ${selectedConfig.key.pubKey} uses quote token ${selectedConfig.mintInfoB.symbol}`
        );
        logInfo("Omit --buy-amount or choose a SOL-quoted launchpad config.");
        process.exitCode = 1;
        return;
      }

      // Generate a new keypair for the token mint
      const mintKeypair = Keypair.generate();

      // Show preview
      if (isJsonOutput()) {
        logJson({
          action: "create",
          token: {
            name: options.name,
            symbol: options.symbol,
            uri: metadataUri,
            image: imageUrl,
            decimals,
            mint: mintKeypair.publicKey.toBase58()
          },
          platformId: platformId.toBase58(),
          configId: selectedConfig.key.pubKey,
          quoteToken: selectedConfig.mintInfoB.symbol,
          initialBuy: options.buyAmount ? `${options.buyAmount} SOL` : "none",
          slippage: `${slippagePercent.toString()}%`
        });
      } else {
        logInfo("");
        logInfo(`Launching Token`);
        logInfo(`  Name: ${options.name}`);
        logInfo(`  Symbol: ${options.symbol}`);
        logInfo(`  Decimals: ${decimals}`);
        logInfo(`  URI: ${metadataUri}`);
        logInfo(`  Mint: ${mintKeypair.publicKey.toBase58()}`);
        logInfo(`  Platform: ${platformInfo?.name ?? "Custom"} (${platformId.toBase58()})`);
        logInfo(`  Config: ${selectedConfig.key.pubKey}`);
        logInfo(`  Quote: ${selectedConfig.mintInfoB.symbol}`);
        if (options.buyAmount) {
          logInfo(`  Initial Buy: ${options.buyAmount} SOL`);
          logInfo(`  Slippage: ${slippagePercent.toString()}%`);
        }
      }

      // Confirm
      const ok = await promptConfirm("Proceed with launching token?", false);
      if (!ok) {
        logInfo("Cancelled");
        return;
      }

      // Build transaction
      type CreateLaunchpadTxData = Awaited<ReturnType<typeof raydium.launchpad.createLaunchpad>>;
      let txData: CreateLaunchpadTxData;
      let extInfo: CreateLaunchpadTxData["extInfo"];
      try {
        const result = await withSpinner("Building transaction", async () => {
          return raydium.launchpad.createLaunchpad({
            mintA: mintKeypair.publicKey,
            name: options.name,
            symbol: options.symbol,
            uri: metadataUri,
            decimals,
            platformId,
            configId: new PublicKey(selectedConfig.key.pubKey),
            migrateType: "cpmm",
            buyAmount: buyAmountLamports,
            slippage: slippageBps,
            createOnly: buyAmountLamports.isZero(), // Skip buy if no amount specified
            extraSigners: [mintKeypair],
            txVersion: TxVersion.V0,
            computeBudgetConfig: priorityFeeMicroLamports > 0
              ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
              : undefined
          });
        });
        txData = result;
        extInfo = result.extInfo;
      } catch (error) {
        logErrorWithDebug("Failed to build transaction", error, {
          debug: options.debug,
          fallback: "Unknown error - run with --debug for details"
        });
        process.exitCode = 1;
        return;
      }

      // Execute transaction
      let result: { txIds: string[] };
      try {
        result = await withSpinner("Sending transaction", async () => {
          const executed = await txData.execute({ sendAndConfirm: true, sequentially: true });
          return { txIds: executed.txIds };
        });
      } catch (error) {
        logErrorWithDebug("Create launchpad failed", error, {
          debug: options.debug,
          fallback: "Unknown error - run with --debug for details"
        });
        process.exitCode = 1;
        return;
      }

      if (isJsonOutput()) {
        logJson({
          txId: result.txIds[0],
          mintAddress: mintKeypair.publicKey.toBase58(),
          poolId: extInfo.address.poolId.toBase58()
        });
      } else {
        logSuccess(`Token launched: ${result.txIds[0]}`);
        logInfo(`Mint Address: ${mintKeypair.publicKey.toBase58()}`);
        logInfo(`Pool ID: ${extInfo.address.poolId.toBase58()}`);
      }
    });

  // Claim platform fees command
  launchpad
    .command("claim-fees")
    .description("Claim platform fees from launchpad")
    .requiredOption("--platform-id <address>", "Platform config address")
    .option("--mint-b <address>", "Quote token mint (default: SOL)")
    .option("--priority-fee <sol>", "Priority fee in SOL")
    .option("--debug", "Print full error on failure")
    .addHelpText("after", "\nAuth:\n  Use --password-stdin or the interactive password prompt. --password requires --unsafe-secret-flags.\n")
    .action(async (options: {
      platformId: string;
      mintB?: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

      // Validate platform ID
      let platformId: PublicKey;
      try {
        platformId = new PublicKey(options.platformId);
      } catch {
        logError("Invalid platform ID address");
        process.exitCode = 1;
        return;
      }

      // Validate mint B
      let mintB: PublicKey = NATIVE_MINT;
      if (options.mintB) {
        try {
          mintB = new PublicKey(options.mintB);
        } catch {
          logError("Invalid mint B address");
          process.exitCode = 1;
          return;
        }
      }

      // Validate priority fee
      let priorityFeeMicroLamports: number;
      try {
        priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
          options.priorityFee ?? String(config["priority-fee"])
        );
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

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

      // Identify quote token for display
      const mintBStr = mintB.toBase58();
      const quoteSymbol = getQuoteSymbol(mintB);

      // Show preview
      if (isJsonOutput()) {
        logJson({
          action: "claim-fees",
          platformId: platformId.toBase58(),
          quoteToken: quoteSymbol,
          claimWallet: owner.publicKey.toBase58()
        });
      } else {
        logInfo("");
        logInfo(`Claiming Platform Fees`);
        logInfo(`  Platform: ${platformId.toBase58()}`);
        logInfo(`  Quote Token: ${quoteSymbol}`);
        logInfo(`  Claim Wallet: ${owner.publicKey.toBase58()}`);
      }

      // Confirm
      const ok = await promptConfirm("Proceed with claiming fees?", false);
      if (!ok) {
        logInfo("Cancelled");
        return;
      }

      // Determine the token program for mintB
      const isToken2022 = TOKEN_2022_MINTS.has(mintBStr);
      const mintBProgram = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

      if (!isJsonOutput() && isToken2022) {
        logInfo(`  Token Program: Token-2022`);
      }

      // Build transaction
      type ClaimVaultPlatformFeeTxData = Awaited<ReturnType<typeof raydium.launchpad.claimVaultPlatformFee>>;
      let txData: ClaimVaultPlatformFeeTxData;
      try {
        txData = await withSpinner("Building transaction", async () => {
          return raydium.launchpad.claimVaultPlatformFee({
            platformId,
            mintB,
            mintBProgram,
            claimFeeWallet: owner.publicKey,
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

      // Execute transaction
      let result: { txId: string };
      try {
        result = await withSpinner("Sending transaction", async () => {
          const executed = await txData.execute({ sendAndConfirm: true });
          return { txId: executed.txId };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? "Claim fees failed");
        logErrorWithDebug("Claim fees failed", error, { debug: options.debug, fallback: "Claim fees failed" });

        // Check if it's a "no fees to claim" scenario
        if (message.includes("insufficient") || message.includes("0x1") || message.includes("0x0")) {
          logInfo("Note: This error may mean there are no fees to claim yet.");
        }

        process.exitCode = 1;
        return;
      }

      if (isJsonOutput()) {
        logJson({ txId: result.txId });
      } else {
        logSuccess(`Fees claimed: ${result.txId}`);
      }
    });

  // Check platform fee balance command
  launchpad
    .command("fee-balance")
    .description("Check platform fee balances available to claim")
    .requiredOption("--platform-id <address>", "Platform config address")
    .option("--mint-b <address>", "Quote token mint (default: checks SOL, USD1, USDC)")
    .action(async (options: {
      platformId: string;
      mintB?: string;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

      // Validate platform ID
      let platformId: PublicKey;
      try {
        platformId = new PublicKey(options.platformId);
      } catch {
        logError("Invalid platform ID address");
        process.exitCode = 1;
        return;
      }

      // Known quote tokens to check
      const knownQuoteTokens: Array<{ symbol: string; mint: string; decimals: number; isToken2022: boolean }> =
        KNOWN_QUOTE_TOKENS.map((token) => ({
          symbol: token.symbol,
          mint: token.mint.toBase58(),
          decimals: token.decimals,
          isToken2022: false
        }));

      // If specific mint provided, only check that one
      let tokensToCheck = knownQuoteTokens;
      if (options.mintB) {
        let mintB: PublicKey;
        try {
          mintB = new PublicKey(options.mintB);
        } catch {
          logError("Invalid mint B address");
          process.exitCode = 1;
          return;
        }
        const known = knownQuoteTokens.find(t => t.mint === options.mintB);
        tokensToCheck = known
          ? [known]
          : [{ symbol: options.mintB.slice(0, 8) + "...", mint: options.mintB, decimals: 9, isToken2022: TOKEN_2022_MINTS.has(options.mintB) }];
      }

      // Load Raydium (no owner needed, just connection)
      const raydium = await withSpinner("Loading Raydium", () =>
        loadRaydium({ disableLoadToken: true })
      );

      logInfo("");
      logInfo(`Platform Fee Balances for ${platformId.toBase58()}`);
      logInfo("");

      const results: Array<{ symbol: string; mint: string; balance: string; vaultAddress: string }> = [];

      for (const token of tokensToCheck) {
        const mintB = new PublicKey(token.mint);

        // Derive platform fee vault PDA using SDK's method
        // PDA: [platformId, mintB] -> LAUNCHPAD_PROGRAM
        const vaultPda = getPdaPlatformVault(LAUNCHPAD_PROGRAM, platformId, mintB).publicKey;

        try {
          // Fetch token account info
          const accountInfo = await raydium.connection.getAccountInfo(vaultPda);

          if (!accountInfo) {
            if (!isJsonOutput()) {
              logInfo(`  ${token.symbol}: No vault (0)`);
            }
            results.push({ symbol: token.symbol, mint: token.mint, balance: "0", vaultAddress: vaultPda.toBase58() });
            continue;
          }

          // Parse token account data to get balance
          // Token account layout: first 64 bytes contain mint (32) + owner (32), then amount at offset 64 (8 bytes)
          const data = accountInfo.data;
          if (data.length < 72) {
            if (!isJsonOutput()) {
              logInfo(`  ${token.symbol}: Invalid account data`);
            }
            continue;
          }

          // Read amount (u64 at offset 64)
          const amountBuffer = data.slice(64, 72);
          const amount = amountBuffer.readBigUInt64LE(0);
          const displayAmount = formatRawAmount(amount, token.decimals);

          if (!isJsonOutput()) {
            logInfo(`  ${token.symbol}: ${displayAmount} (${amount.toString()} raw)`);
            logInfo(`    Vault: ${vaultPda.toBase58()}`);
          }
          results.push({ symbol: token.symbol, mint: token.mint, balance: displayAmount, vaultAddress: vaultPda.toBase58() });
        } catch (error) {
          if (!isJsonOutput()) {
            logInfo(`  ${token.symbol}: Error fetching (${(error as Error).message})`);
          }
        }
      }

      if (isJsonOutput()) {
        logJson({ platformId: platformId.toBase58(), balances: results });
      }
    });

  // Check creator fee balance command
  launchpad
    .command("creator-fee-balance")
    .description("Check your creator fee balances available to claim")
    .option("--mint-b <address>", "Quote token mint (default: checks SOL, USD1, USDC)")
    .addHelpText("after", "\nAuth:\n  Use --password-stdin or the interactive password prompt. --password requires --unsafe-secret-flags.\n")
    .action(async (options: {
      mintB?: string;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

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

      // Known quote tokens to check
      const knownQuoteTokens: Array<{ symbol: string; mint: string; decimals: number; isToken2022: boolean }> =
        KNOWN_QUOTE_TOKENS.map((token) => ({
          symbol: token.symbol,
          mint: token.mint.toBase58(),
          decimals: token.decimals,
          isToken2022: false
        }));

      // If specific mint provided, only check that one
      let tokensToCheck = knownQuoteTokens;
      if (options.mintB) {
        let mintB: PublicKey;
        try {
          mintB = new PublicKey(options.mintB);
        } catch {
          logError("Invalid mint B address");
          process.exitCode = 1;
          return;
        }
        const known = knownQuoteTokens.find(t => t.mint === options.mintB);
        tokensToCheck = known
          ? [known]
          : [{ symbol: options.mintB.slice(0, 8) + "...", mint: options.mintB, decimals: 9, isToken2022: TOKEN_2022_MINTS.has(options.mintB) }];
      }

      // Load Raydium (no owner needed for balance check, just connection)
      const raydium = await withSpinner("Loading Raydium", () =>
        loadRaydium({ disableLoadToken: true })
      );

      logInfo("");
      logInfo(`Creator Fee Balances for ${owner.publicKey.toBase58()}`);
      logInfo("");

      const results: Array<{ symbol: string; mint: string; balance: string; vaultAddress: string }> = [];

      for (const token of tokensToCheck) {
        const mintB = new PublicKey(token.mint);

        // Derive creator fee vault PDA: [creator, mintB] -> LAUNCHPAD_PROGRAM
        const vaultPda = getPdaCreatorVault(LAUNCHPAD_PROGRAM, owner.publicKey, mintB).publicKey;

        try {
          // Fetch token account info
          const accountInfo = await raydium.connection.getAccountInfo(vaultPda);

          if (!accountInfo) {
            if (!isJsonOutput()) {
              logInfo(`  ${token.symbol}: No vault (0)`);
            }
            results.push({ symbol: token.symbol, mint: token.mint, balance: "0", vaultAddress: vaultPda.toBase58() });
            continue;
          }

          // Parse token account data to get balance
          // Token account layout: first 64 bytes contain mint (32) + owner (32), then amount at offset 64 (8 bytes)
          const data = accountInfo.data;
          if (data.length < 72) {
            if (!isJsonOutput()) {
              logInfo(`  ${token.symbol}: Invalid account data`);
            }
            continue;
          }

          // Read amount (u64 at offset 64)
          const amountBuffer = data.slice(64, 72);
          const amount = amountBuffer.readBigUInt64LE(0);
          const displayAmount = formatRawAmount(amount, token.decimals);

          if (!isJsonOutput()) {
            logInfo(`  ${token.symbol}: ${displayAmount} (${amount.toString()} raw)`);
            logInfo(`    Vault: ${vaultPda.toBase58()}`);
          }
          results.push({ symbol: token.symbol, mint: token.mint, balance: displayAmount, vaultAddress: vaultPda.toBase58() });
        } catch (error) {
          if (!isJsonOutput()) {
            logInfo(`  ${token.symbol}: Error fetching (${(error as Error).message})`);
          }
        }
      }

      if (isJsonOutput()) {
        logJson({ creator: owner.publicKey.toBase58(), balances: results });
      }
    });

  // Claim creator fees command
  // Note: Creator fees are accumulated per quote token (mintB), not per pool.
  // The SDK claims from a creator vault derived from (owner, mintB).
  launchpad
    .command("claim-creator-fees")
    .description("Claim creator fees accumulated from your launchpad tokens")
    .option("--mint-b <address>", "Quote token mint (default: SOL)")
    .option("--priority-fee <sol>", "Priority fee in SOL")
    .option("--debug", "Print full error on failure")
    .addHelpText("after", "\nAuth:\n  Use --password-stdin or the interactive password prompt. --password requires --unsafe-secret-flags.\n")
    .action(async (options: {
      mintB?: string;
      priorityFee?: string;
      debug?: boolean;
    }) => {
      const config = await loadConfig({ createIfMissing: true });

      // Validate mint B (default to SOL)
      let mintB: PublicKey = NATIVE_MINT;
      if (options.mintB) {
        try {
          mintB = new PublicKey(options.mintB);
        } catch {
          logError("Invalid mint B address");
          process.exitCode = 1;
          return;
        }
      }

      // Validate priority fee
      let priorityFeeMicroLamports: number;
      try {
        priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
          options.priorityFee ?? String(config["priority-fee"])
        );
      } catch (error) {
        logError((error as Error).message);
        process.exitCode = 1;
        return;
      }

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

      const mintBStr = mintB.toBase58();

      // Identify quote token for display
      const KNOWN_QUOTES: Record<string, string> = {
        "So11111111111111111111111111111111111111112": "SOL",
        "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB": "USD1",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC"
      };
      const quoteSymbol = KNOWN_QUOTES[mintBStr] ?? mintBStr.slice(0, 8) + "...";

      // Show preview
      if (isJsonOutput()) {
        logJson({
          action: "claim-creator-fees",
          quoteToken: quoteSymbol,
          mintB: mintBStr,
          creator: owner.publicKey.toBase58()
        });
      } else {
        logInfo("");
        logInfo(`Claiming Creator Fees`);
        logInfo(`  Quote Token: ${quoteSymbol} (${mintBStr})`);
        logInfo(`  Creator: ${owner.publicKey.toBase58()}`);
        logInfo("");
        logInfo("Note: This claims all accumulated creator fees for this quote token.");
      }

      // Determine the token program for mintB
      const isToken2022 = TOKEN_2022_MINTS.has(mintBStr);
      const mintBProgram = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

      if (!isJsonOutput() && isToken2022) {
        logInfo(`  Token Program: Token-2022`);
      }

      // Confirm
      const ok = await promptConfirm("Proceed with claiming creator fees?", false);
      if (!ok) {
        logInfo("Cancelled");
        return;
      }

      // Build transaction
      type ClaimCreatorFeeTxData = Awaited<ReturnType<typeof raydium.launchpad.claimCreatorFee>>;
      let txData: ClaimCreatorFeeTxData;
      try {
        txData = await withSpinner("Building transaction", async () => {
          return raydium.launchpad.claimCreatorFee({
            mintB,
            mintBProgram,
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

      // Execute transaction
      let result: { txId: string };
      try {
        result = await withSpinner("Sending transaction", async () => {
          const executed = await txData.execute({ sendAndConfirm: true });
          return { txId: executed.txId };
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error ?? "Claim creator fees failed");
        logErrorWithDebug("Claim creator fees failed", error, { debug: options.debug, fallback: "Claim creator fees failed" });

        // Check if it's a "no fees to claim" scenario
        if (message.includes("insufficient") || message.includes("0x1")) {
          logInfo("Note: This error may mean there are no creator fees to claim yet.");
        }

        process.exitCode = 1;
        return;
      }

      if (isJsonOutput()) {
        logJson({ txId: result.txId });
      } else {
        logSuccess(`Creator fees claimed: ${result.txId}`);
      }
    });
}
