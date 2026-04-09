import { Command } from "commander";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CLMM_PROGRAM_ID,
  DEVNET_PROGRAM_ID,
  ApiV3PoolInfoConcentratedItem,
  TxVersion,
  ClmmPositionLayout,
  PoolUtils
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import BN from "bn.js";

import { loadConfig } from "../../lib/config-manager";
import { getConnection } from "../../lib/connection";
import { decryptWallet, getWalletPublicKey, resolveWalletIdentifier } from "../../lib/wallet-manager";
import { promptConfirm, promptPassword } from "../../lib/prompt";
import { isJsonOutput, logError, logErrorWithDebug, logInfo, logJson, logSuccess, withSpinner } from "../../lib/output";
import { loadRaydium } from "../../lib/raydium-client";
import {
  sqrtPriceX64ToPrice,
  tickToPrice,
  getAmountsFromLiquidity,
  getAmountsForTickRange,
  formatTokenAmount,
  formatPrice,
  formatFeeRate,
  formatUsd,
  calculateUsdValue,
  isPositionInRange,
  applySlippage,
  priceToAlignedTick
} from "../../lib/clmm-utils";
import { getTokenPrices } from "../../lib/token-price";
import { addRichHelp, NON_INTERACTIVE_HELP, PASSWORD_AUTH_HELP } from "../../lib/help";

const VALID_CLMM_PROGRAM_IDS = new Set([
  CLMM_PROGRAM_ID.toBase58(),
  DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID.toBase58()
]);

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function parsePositiveDecimalInput(value: string, label: string): Decimal {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`${label} must be a positive decimal number`);
  }

  const decimal = new Decimal(normalized);
  if (!decimal.isFinite() || decimal.lte(0)) {
    throw new Error(`${label} must be greater than zero`);
  }

  return decimal;
}

/**
 * Populate rewardDefaultInfos from on-chain rewardInfos
 * This is needed because getPoolInfoFromRpc returns empty rewardDefaultInfos
 * but the program expects reward accounts for active rewards
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function populateRewardDefaultInfos(poolInfo: any): void {
  if (poolInfo.rewardDefaultInfos && poolInfo.rewardDefaultInfos.length > 0) {
    return; // Already populated
  }

  const rewardInfos = poolInfo.rewardInfos || [];
  const activeRewards: Array<{ mint: { address: string; programId: string } }> = [];

  for (const reward of rewardInfos) {
    const rewardState = typeof reward.rewardState === "number"
      ? reward.rewardState
      : parseInt(reward.rewardState, 10);

    // Get mint address as string
    const mintAddress = typeof reward.tokenMint === "string"
      ? reward.tokenMint
      : reward.tokenMint?.toBase58?.() || reward.tokenMint?.toString() || "";

    // Skip inactive rewards or system program placeholder
    if (rewardState === 0 || mintAddress === SYSTEM_PROGRAM_ID || mintAddress === "") {
      continue;
    }

    activeRewards.push({
      mint: {
        address: mintAddress,
        programId: TOKEN_PROGRAM_ID
      }
    });
  }

  poolInfo.rewardDefaultInfos = activeRewards;
}

/**
 * Get token balance for a wallet
 */
async function getTokenBalance(
  connection: import("@solana/web3.js").Connection,
  owner: PublicKey,
  mintAddress: string
): Promise<BN> {
  if (mintAddress === WRAPPED_SOL_MINT) {
    const balance = await connection.getBalance(owner);
    return new BN(balance);
  }

  try {
    const tokenAccounts = await connection.getTokenAccountsByOwner(owner, {
      mint: new PublicKey(mintAddress)
    });

    if (tokenAccounts.value.length > 0) {
      const accountData = tokenAccounts.value[0].account.data;
      // Token account: first 32 bytes mint, next 32 bytes owner, next 8 bytes amount
      const amountBytes = accountData.slice(64, 72);
      return new BN(amountBytes, "le");
    }
  } catch {
    // Return 0 on error
  }

  return new BN(0);
}

export function registerClmmCommands(program: Command): void {
  const clmm = program.command("clmm").description("CLMM (concentrated liquidity) commands");
  const withPasswordOptions = (cmd: Command, sections?: {
    summary?: string | string[];
    units?: string | string[];
    defaults?: string | string[];
    examples?: string | string[];
    notes?: string | string[];
  }): Command =>
    addRichHelp(cmd, {
      auth: PASSWORD_AUTH_HELP,
      nonInteractive: NON_INTERACTIVE_HELP,
      ...sections
    });

  // clmm pool <pool-id>
  clmm
    .command("pool")
    .description("Show CLMM pool state")
    .argument("<pool-id>", "Pool address")
    .action(handlePoolCommand);

  // clmm ticks <pool-id>
  clmm
    .command("ticks")
    .description("List initialized ticks with liquidity")
    .argument("<pool-id>", "Pool address")
    .option("--min-tick <tick>", "Minimum tick index")
    .option("--max-tick <tick>", "Maximum tick index")
    .option("--limit <number>", "Maximum ticks to display", "50")
    .action(handleTicksCommand);

  // clmm positions
  withPasswordOptions(
    clmm
      .command("positions")
    .description("List all positions for the active wallet")
      .option("--wallet <name>", "Wallet name to use (defaults to active wallet)")
  ).action(handlePositionsCommand);

  // clmm position <nft-mint>
  withPasswordOptions(
    clmm
      .command("position")
    .description("Show detailed position state")
      .argument("<nft-mint>", "Position NFT mint address")
  ).action(handlePositionCommand);

  // clmm collect-fees
  withPasswordOptions(
    clmm
      .command("collect-fees")
    .description("Collect accumulated fees from position(s)")
      .option("--nft-mint <address>", "Position NFT mint address")
      .option("--all", "Collect fees from all positions with unclaimed fees")
      .option("--priority-fee <sol>", "Priority fee in SOL")
  ).action(handleCollectFeesCommand);

  // clmm close-position
  withPasswordOptions(
    clmm
      .command("close-position")
    .description("Close a CLMM position")
      .requiredOption("--nft-mint <address>", "Position NFT mint address")
      .option("--force", "Remove all liquidity first, then close")
      .option("--slippage <percent>", "Slippage tolerance for force mode")
      .option("--priority-fee <sol>", "Priority fee in SOL")
  ).action(handleClosePositionCommand);

  // clmm decrease-liquidity
  withPasswordOptions(
    clmm
      .command("decrease-liquidity")
    .description("Remove liquidity from a position")
      .requiredOption("--nft-mint <address>", "Position NFT mint address")
      .requiredOption("--percent <number>", "Percentage of liquidity to remove (1-100)")
      .option("--slippage <percent>", "Slippage tolerance")
      .option("--priority-fee <sol>", "Priority fee in SOL")
      .option("--swap-to-sol", "Swap both withdrawn tokens to SOL after removing liquidity")
  ).action(handleDecreaseLiquidityCommand);

  // clmm increase-liquidity
  withPasswordOptions(
    clmm
      .command("increase-liquidity")
    .description("Add liquidity to an existing position")
      .requiredOption("--nft-mint <address>", "Position NFT mint address")
      .requiredOption("--amount <number>", "Amount to add")
      .option("--token <A|B>", "Which token the amount refers to", "A")
      .option("--slippage <percent>", "Slippage tolerance")
      .option("--priority-fee <sol>", "Priority fee in SOL")
      .option("--auto-swap", "Automatically swap tokens if you don't have enough of the other token")
  , {
    units: [
      "--amount is a decimal UI amount for the token selected by --token.",
      "--slippage is a percent such as 0.5 for 0.5%.",
      "--priority-fee is in SOL."
    ],
    defaults: "--token defaults to A.",
    examples: [
      "raydium clmm increase-liquidity --nft-mint <position-nft> --amount 10 --token A",
      "raydium clmm increase-liquidity --nft-mint <position-nft> --amount 25 --token B --auto-swap"
    ]
  }
  ).action(handleIncreaseLiquidityCommand);

  // clmm open-position
  withPasswordOptions(
    clmm
      .command("open-position")
    .description("Open a new liquidity position")
      .requiredOption("--pool-id <address>", "Pool address")
      .requiredOption("--price-lower <number>", "Lower price bound")
      .requiredOption("--price-upper <number>", "Upper price bound")
      .requiredOption("--amount <number>", "Deposit amount")
      .option("--token <A|B>", "Which token the amount refers to", "A")
      .option("--slippage <percent>", "Slippage tolerance")
      .option("--priority-fee <sol>", "Priority fee in SOL")
      .option("--auto-swap", "Automatically swap to get required tokens if balance is insufficient")
  , {
    units: [
      "--price-lower and --price-upper are pool price bounds in token B per token A.",
      "--amount is a decimal UI amount for the token selected by --token.",
      "--slippage is a percent such as 0.5 for 0.5%.",
      "--priority-fee is in SOL."
    ],
    defaults: "--token defaults to A.",
    examples: [
      "raydium clmm open-position --pool-id <pool-id> --price-lower 120 --price-upper 160 --amount 25 --token A",
      "raydium clmm open-position --pool-id <pool-id> --price-lower 120 --price-upper 160 --amount 500 --token B --auto-swap"
    ]
  }
  ).action(handleOpenPositionCommand);

  // clmm create-pool
  withPasswordOptions(
    clmm
      .command("create-pool")
    .description("Create a new CLMM pool")
      .requiredOption("--mint-a <address>", "Token A mint address")
      .requiredOption("--mint-b <address>", "Token B mint address")
      .requiredOption("--fee-tier <bps>", "Fee tier in basis points (e.g., 500, 3000, 10000)")
      .requiredOption("--initial-price <number>", "Initial price of token A in terms of token B")
      .option("--priority-fee <sol>", "Priority fee in SOL")
  ).action(handleCreatePoolCommand);
}

async function handlePoolCommand(poolIdStr: string): Promise<void> {
  let poolId: PublicKey;
  try {
    poolId = new PublicKey(poolIdStr);
  } catch {
    logError("Invalid pool ID");
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ disableLoadToken: true })
  );

  let poolInfo: ApiV3PoolInfoConcentratedItem;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let computePoolInfo: any;

  try {
    const data = await withSpinner("Fetching pool info", async () => {
      const result = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58());
      if (!result.poolInfo) {
        throw new Error("Pool not found");
      }
      if (!VALID_CLMM_PROGRAM_IDS.has(result.poolInfo.programId)) {
        throw new Error("Not a CLMM pool");
      }
      return result;
    });
    poolInfo = data.poolInfo;
    computePoolInfo = data.computePoolInfo;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch pool info", msg);
    process.exitCode = 1;
    return;
  }

  const mintA = poolInfo.mintA;
  const mintB = poolInfo.mintB;
  const decimalsA = mintA.decimals;
  const decimalsB = mintB.decimals;

  // Use computePoolInfo for BN values
  const sqrtPriceX64 = computePoolInfo.sqrtPriceX64.toString();
  const liquidity = computePoolInfo.liquidity.toString();
  const tickCurrent = computePoolInfo.tickCurrent;
  const tickSpacing = computePoolInfo.tickSpacing;

  const currentPrice = sqrtPriceX64ToPrice(sqrtPriceX64, decimalsA, decimalsB);

  const symbolA = mintA.symbol || mintA.address.slice(0, 6);
  const symbolB = mintB.symbol || mintB.address.slice(0, 6);

  // Fee rate is in the poolInfo from API
  const feeRate = poolInfo.feeRate;
  const protocolFeeRate = computePoolInfo.ammConfig?.protocolFeeRate ?? 0;
  const fundFeeRate = computePoolInfo.ammConfig?.fundFeeRate ?? 0;

  // Pool reserves (raw amounts from API, need to adjust for decimals)
  const mintAmountARaw = poolInfo.mintAmountA;
  const mintAmountBRaw = poolInfo.mintAmountB;
  const amountA = new Decimal(mintAmountARaw).div(new Decimal(10).pow(decimalsA));
  const amountB = new Decimal(mintAmountBRaw).div(new Decimal(10).pow(decimalsB));

  const tvl = poolInfo.tvl;

  // Fetch optional USD prices
  const prices = await withSpinner("Fetching token prices", () =>
    getTokenPrices([mintA.address, mintB.address])
  );
  const priceA = prices.get(mintA.address) ?? null;
  const priceB = prices.get(mintB.address) ?? null;
  const calculatedTvl = calculateUsdValue(amountA, amountB, priceA, priceB);

  if (isJsonOutput()) {
    logJson({
      poolId: poolId.toBase58(),
      programId: poolInfo.programId,
      mintA: {
        address: mintA.address,
        symbol: mintA.symbol,
        decimals: decimalsA,
        amount: amountA.toString(),
        ...(priceA !== null && { priceUsd: priceA })
      },
      mintB: {
        address: mintB.address,
        symbol: mintB.symbol,
        decimals: decimalsB,
        amount: amountB.toString(),
        ...(priceB !== null && { priceUsd: priceB })
      },
      currentTick: tickCurrent,
      sqrtPriceX64: sqrtPriceX64,
      price: currentPrice.toString(),
      liquidity: liquidity,
      tvl: tvl,
      ...(calculatedTvl !== null && { tvlCalculated: calculatedTvl.toNumber() }),
      feeRate: feeRate,
      tickSpacing: tickSpacing,
      protocolFeeRate: protocolFeeRate,
      fundFeeRate: fundFeeRate
    });
    return;
  }

  logInfo(`Pool: ${poolId.toBase58()}`);
  logInfo(`Program: ${poolInfo.programId}`);
  logInfo("");
  logInfo("Tokens:");
  logInfo(`  ${symbolA}: ${mintA.address} (${decimalsA} decimals)`);
  if (priceA !== null) logInfo(`    Price: ${formatUsd(priceA)}`);
  logInfo(`  ${symbolB}: ${mintB.address} (${decimalsB} decimals)`);
  if (priceB !== null) logInfo(`    Price: ${formatUsd(priceB)}`);
  logInfo("");
  logInfo("Price:");
  logInfo(`  Current tick: ${tickCurrent}`);
  logInfo(`  sqrtPriceX64: ${sqrtPriceX64}`);
  logInfo(`  Price: ${formatPrice(currentPrice)} ${symbolB}/${symbolA}`);
  logInfo("");
  logInfo("Liquidity:");
  logInfo(`  In-range liquidity: ${liquidity}`);
  logInfo(`  ${symbolA} in pool: ${formatTokenAmount(amountA)}`);
  logInfo(`  ${symbolB} in pool: ${formatTokenAmount(amountB)}`);
  if (tvl > 0) logInfo(`  TVL: $${tvl.toLocaleString()}`);
  if (calculatedTvl !== null && tvl <= 0) logInfo(`  TVL: ${formatUsd(calculatedTvl)}`);
  logInfo("");
  logInfo("Fees:");
  logInfo(`  Fee rate: ${formatFeeRate(feeRate)}`);
  logInfo(`  Tick spacing: ${tickSpacing}`);
  logInfo(`  Protocol fee rate: ${protocolFeeRate / 10000}%`);
  logInfo(`  Fund fee rate: ${fundFeeRate / 10000}%`);
}

async function handleTicksCommand(
  poolIdStr: string,
  options: { minTick?: string; maxTick?: string; limit?: string }
): Promise<void> {
  let poolId: PublicKey;
  try {
    poolId = new PublicKey(poolIdStr);
  } catch {
    logError("Invalid pool ID");
    process.exitCode = 1;
    return;
  }

  const limit = options.limit ? Number(options.limit) : 50;
  if (!Number.isFinite(limit) || limit < 1) {
    logError("Invalid limit");
    process.exitCode = 1;
    return;
  }

  const minTick = options.minTick ? Number(options.minTick) : undefined;
  const maxTick = options.maxTick ? Number(options.maxTick) : undefined;
  if (
    (minTick !== undefined && !Number.isFinite(minTick)) ||
    (maxTick !== undefined && !Number.isFinite(maxTick))
  ) {
    logError("--min-tick and --max-tick must be numeric tick indexes");
    process.exitCode = 1;
    return;
  }
  if (minTick !== undefined && maxTick !== undefined && minTick > maxTick) {
    logError("--min-tick cannot be greater than --max-tick");
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ disableLoadToken: true })
  );

  let poolInfo: ApiV3PoolInfoConcentratedItem;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let computePoolInfo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tickData: any;

  try {
    const data = await withSpinner("Fetching pool and tick data", async () => {
      const result = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58());
      if (!result.poolInfo) {
        throw new Error("Pool not found");
      }
      if (!VALID_CLMM_PROGRAM_IDS.has(result.poolInfo.programId)) {
        throw new Error("Not a CLMM pool");
      }
      return result;
    });
    poolInfo = data.poolInfo;
    computePoolInfo = data.computePoolInfo;
    tickData = data.tickData;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch pool info", msg);
    process.exitCode = 1;
    return;
  }

  const mintA = poolInfo.mintA;
  const mintB = poolInfo.mintB;
  const decimalsA = mintA.decimals;
  const decimalsB = mintB.decimals;
  const currentTick = computePoolInfo.tickCurrent;
  const tickSpacing = computePoolInfo.tickSpacing;
  const sqrtPriceX64 = computePoolInfo.sqrtPriceX64.toString();

  // Get initialized ticks from tickData
  // tickData structure: tickData[poolId][startTickIndex] = { ticks: [...] }
  const initializedTicks: Array<{
    tick: number;
    liquidityNet: string;
    liquidityGross: string;
  }> = [];

  if (tickData && typeof tickData === "object") {
    // Get the pool's tick data
    const poolTickData = tickData[poolId.toBase58()];
    if (poolTickData && typeof poolTickData === "object") {
      // Iterate over tick arrays (keyed by start index)
      for (const tickArray of Object.values(poolTickData)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ticks = (tickArray as any)?.ticks;
        if (ticks && Array.isArray(ticks)) {
          for (const tick of ticks) {
            if (tick && tick.liquidityGross && !tick.liquidityGross.isZero()) {
              const tickIndex = tick.tick;
              if (minTick !== undefined && tickIndex < minTick) continue;
              if (maxTick !== undefined && tickIndex > maxTick) continue;
              initializedTicks.push({
                tick: tickIndex,
                liquidityNet: tick.liquidityNet.toString(),
                liquidityGross: tick.liquidityGross.toString()
              });
            }
          }
        }
      }
    }
  }

  // Sort by tick index
  initializedTicks.sort((a, b) => a.tick - b.tick);

  // Apply limit
  const displayTicks = initializedTicks.slice(0, limit);

  const symbolA = mintA.symbol || mintA.address.slice(0, 6);
  const symbolB = mintB.symbol || mintB.address.slice(0, 6);

  // Fetch optional USD prices
  const prices = await withSpinner("Fetching token prices", () =>
    getTokenPrices([mintA.address, mintB.address])
  );
  const priceA = prices.get(mintA.address) ?? null;
  const priceB = prices.get(mintB.address) ?? null;

  // Calculate amounts for each tick
  const ticksWithAmounts = displayTicks.map((t) => {
    const price = tickToPrice(t.tick, decimalsA, decimalsB);
    const amounts = getAmountsForTickRange(
      t.liquidityNet,
      t.tick,
      tickSpacing,
      currentTick,
      sqrtPriceX64,
      decimalsA,
      decimalsB
    );
    const usdValue = calculateUsdValue(amounts.amount0, amounts.amount1, priceA, priceB);
    return {
      tick: t.tick,
      price: price.toString(),
      liquidityNet: t.liquidityNet,
      liquidityGross: t.liquidityGross,
      amount0: amounts.amount0.toString(),
      amount1: amounts.amount1.toString(),
      ...(usdValue !== null && { usdValue: usdValue.toNumber() })
    };
  });

  if (isJsonOutput()) {
    logJson({
      poolId: poolId.toBase58(),
      currentTick,
      tickSpacing,
      totalInitialized: initializedTicks.length,
      displayed: displayTicks.length,
      ticks: ticksWithAmounts
    });
    return;
  }

  logInfo(`Pool: ${poolId.toBase58()}`);
  logInfo(`Current tick: ${currentTick}`);
  logInfo(`Tick spacing: ${tickSpacing}`);
  logInfo(`Initialized ticks: ${initializedTicks.length} (showing ${displayTicks.length})`);
  logInfo("");

  if (displayTicks.length === 0) {
    logInfo("No initialized ticks found in range");
    return;
  }

  for (const t of ticksWithAmounts) {
    const isNearCurrent = Math.abs(t.tick - currentTick) <= tickSpacing;
    const marker = isNearCurrent ? " <-- current" : "";
    const price = new Decimal(t.price);

    logInfo(`Tick ${t.tick}${marker}`);
    logInfo(`  Price: ${formatPrice(price)} ${symbolB}/${symbolA}`);
    logInfo(`  Liquidity net: ${t.liquidityNet}`);
    logInfo(`  Liquidity gross: ${t.liquidityGross}`);
    logInfo(`  ${symbolA}: ${formatTokenAmount(new Decimal(t.amount0))}`);
    logInfo(`  ${symbolB}: ${formatTokenAmount(new Decimal(t.amount1))}`);
    if (t.usdValue !== undefined) logInfo(`  Value: ${formatUsd(t.usdValue)}`);
  }
}

async function handlePositionsCommand(options: { wallet?: string }): Promise<void> {
  const config = await loadConfig({ createIfMissing: true });
  const walletName = resolveWalletIdentifier(options.wallet, config.activeWallet);

  if (!walletName) {
    logError("No wallet specified and no active wallet set");
    logInfo("Use --wallet <name> or set an active wallet with: raydium wallet use <name>");
    process.exitCode = 1;
    return;
  }

  const password = await promptPassword("Enter wallet password");
  let owner: Keypair;
  try {
    owner = await decryptWallet(walletName, password);
  } catch (error) {
    logError("Failed to decrypt wallet", (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ owner, disableLoadToken: true })
  );

  const isDevnet = raydium.cluster !== "mainnet";
  const clmmProgramId = isDevnet ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let positions: any[];
  try {
    positions = await withSpinner("Fetching positions", () =>
      raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId })
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch positions", msg);
    process.exitCode = 1;
    return;
  }

  if (!positions || positions.length === 0) {
    if (isJsonOutput()) {
      logJson({ positions: [], count: 0 });
    } else {
      logInfo(`No CLMM positions found for wallet: ${owner.publicKey.toBase58()}`);
    }
    return;
  }

  // Collect unique pool IDs
  const poolIds = new Set<string>();
  for (const pos of positions) {
    if (pos.poolId) poolIds.add(pos.poolId.toBase58());
  }

  // Fetch fresh pool data from RPC for accurate current tick
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const poolDataMap = new Map<string, any>();
  if (poolIds.size > 0) {
    try {
      const poolDataResults = await withSpinner("Fetching pool data", async () => {
        const results = await Promise.all(
          Array.from(poolIds).map(async (poolId) => {
            try {
              const data = await raydium.clmm.getPoolInfoFromRpc(poolId);
              return { poolId, data };
            } catch {
              return { poolId, data: null };
            }
          })
        );
        return results;
      });
      for (const { poolId, data } of poolDataResults) {
        if (data?.poolInfo) {
          poolDataMap.set(poolId, data);
        }
      }
    } catch {
      // Continue without fresh pool data
    }
  }

  // Collect unique mint addresses for price fetching
  const uniqueMints = new Set<string>();
  for (const pos of positions) {
    const freshPoolData = poolDataMap.get(pos.poolId?.toBase58() ?? "");
    const poolInfo = freshPoolData?.poolInfo ?? pos.poolInfo;
    if (poolInfo?.mintA?.address) uniqueMints.add(poolInfo.mintA.address);
    if (poolInfo?.mintB?.address) uniqueMints.add(poolInfo.mintB.address);
  }

  // Fetch optional USD prices
  const tokenPrices = await withSpinner("Fetching token prices", () =>
    getTokenPrices(Array.from(uniqueMints))
  );

  const positionsData = positions.map((pos) => {
    const poolIdStr = pos.poolId?.toBase58() ?? "";
    const freshPoolData = poolDataMap.get(poolIdStr);
    const poolInfo = freshPoolData?.poolInfo ?? pos.poolInfo;
    const computePoolInfo = freshPoolData?.computePoolInfo;

    const mintA = poolInfo?.mintA;
    const mintB = poolInfo?.mintB;
    const decimalsA = mintA?.decimals ?? 9;
    const decimalsB = mintB?.decimals ?? 9;

    // Use fresh tick data from RPC if available
    const currentTick = computePoolInfo?.tickCurrent ?? poolInfo?.tickCurrent ?? 0;
    const sqrtPriceX64 = computePoolInfo?.sqrtPriceX64?.toString() ?? poolInfo?.sqrtPriceX64?.toString() ?? "0";

    const inRange = isPositionInRange(pos.tickLower, pos.tickUpper, currentTick);

    const amounts = getAmountsFromLiquidity(
      pos.liquidity?.toString() ?? "0",
      sqrtPriceX64,
      pos.tickLower,
      pos.tickUpper,
      decimalsA,
      decimalsB
    );

    const priceA = mintA?.address ? (tokenPrices.get(mintA.address) ?? null) : null;
    const priceB = mintB?.address ? (tokenPrices.get(mintB.address) ?? null) : null;
    const usdValue = calculateUsdValue(amounts.amount0, amounts.amount1, priceA, priceB);

    return {
      nftMint: pos.nftMint?.toBase58() ?? "unknown",
      poolId: poolIdStr || "unknown",
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      currentTick,
      inRange,
      liquidity: pos.liquidity?.toString() ?? "0",
      amount0: amounts.amount0.toString(),
      amount1: amounts.amount1.toString(),
      symbol0: mintA?.symbol || mintA?.address?.slice(0, 6) || "token0",
      symbol1: mintB?.symbol || mintB?.address?.slice(0, 6) || "token1",
      feesOwed0: pos.tokenFeesOwedA?.toString() ?? "0",
      feesOwed1: pos.tokenFeesOwedB?.toString() ?? "0",
      ...(usdValue !== null && { usdValue: usdValue.toNumber() })
    };
  });

  if (isJsonOutput()) {
    logJson({
      wallet: owner.publicKey.toBase58(),
      positions: positionsData,
      count: positionsData.length
    });
    return;
  }

  logInfo(`Wallet: ${owner.publicKey.toBase58()}`);
  logInfo(`Positions: ${positionsData.length}`);
  logInfo("");

  for (const pos of positionsData) {
    const rangeStatus = pos.inRange ? "IN RANGE" : "OUT OF RANGE";

    logInfo(`Position: ${pos.nftMint}`);
    logInfo(`  Pool: ${pos.poolId}`);
    logInfo(`  Range: [${pos.tickLower}, ${pos.tickUpper}] (current: ${pos.currentTick}) - ${rangeStatus}`);
    logInfo(`  Liquidity: ${pos.liquidity}`);
    logInfo(`  ${pos.symbol0}: ${formatTokenAmount(new Decimal(pos.amount0))}`);
    logInfo(`  ${pos.symbol1}: ${formatTokenAmount(new Decimal(pos.amount1))}`);
    if (pos.usdValue !== undefined) logInfo(`  Value: ${formatUsd(pos.usdValue)}`);
    if (pos.feesOwed0 !== "0" || pos.feesOwed1 !== "0") {
      logInfo(`  Fees owed: ${pos.feesOwed0} ${pos.symbol0}, ${pos.feesOwed1} ${pos.symbol1}`);
    }
    logInfo("");
  }
}

async function handlePositionCommand(nftMintStr: string): Promise<void> {
  let nftMint: PublicKey;
  try {
    nftMint = new PublicKey(nftMintStr);
  } catch {
    logError("Invalid NFT mint address");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig({ createIfMissing: true });
  const walletName = resolveWalletIdentifier(undefined, config.activeWallet);

  if (!walletName) {
    logError("No active wallet set. Required to fetch position info.");
    logInfo("Set an active wallet with: raydium wallet use <name>");
    process.exitCode = 1;
    return;
  }

  const password = await promptPassword("Enter wallet password");
  let owner: Keypair;
  try {
    owner = await decryptWallet(walletName, password);
  } catch (error) {
    logError("Failed to decrypt wallet", (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ owner, disableLoadToken: true })
  );

  const isDevnet = raydium.cluster !== "mainnet";
  const clmmProgramId = isDevnet ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;

  // Fetch all positions and find the one with matching NFT mint
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let positions: any[];
  try {
    positions = await withSpinner("Fetching positions", () =>
      raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId })
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch positions", msg);
    process.exitCode = 1;
    return;
  }

  const position = positions.find((p) => p.nftMint?.toBase58() === nftMint.toBase58());

  if (!position) {
    logError(`Position not found for NFT mint: ${nftMint.toBase58()}`);
    logInfo("Make sure the NFT is owned by the active wallet");
    process.exitCode = 1;
    return;
  }

  // Fetch fresh pool data from RPC for accurate current tick
  const poolIdStr = position.poolId?.toBase58();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let freshPoolData: any = null;
  if (poolIdStr) {
    try {
      freshPoolData = await withSpinner("Fetching pool data", () =>
        raydium.clmm.getPoolInfoFromRpc(poolIdStr)
      );
    } catch {
      // Continue with position's poolInfo
    }
  }

  const poolInfo = freshPoolData?.poolInfo ?? position.poolInfo;
  const computePoolInfo = freshPoolData?.computePoolInfo;
  const mintA = poolInfo?.mintA;
  const mintB = poolInfo?.mintB;
  const decimalsA = mintA?.decimals ?? 9;
  const decimalsB = mintB?.decimals ?? 9;

  // Use fresh tick data from RPC if available
  const currentTick = computePoolInfo?.tickCurrent ?? poolInfo?.tickCurrent ?? 0;
  const sqrtPriceX64 = computePoolInfo?.sqrtPriceX64?.toString() ?? poolInfo?.sqrtPriceX64?.toString() ?? "0";

  const inRange = isPositionInRange(position.tickLower, position.tickUpper, currentTick);

  const amounts = getAmountsFromLiquidity(
    position.liquidity?.toString() ?? "0",
    sqrtPriceX64,
    position.tickLower,
    position.tickUpper,
    decimalsA,
    decimalsB
  );

  const priceLower = tickToPrice(position.tickLower, decimalsA, decimalsB);
  const priceUpper = tickToPrice(position.tickUpper, decimalsA, decimalsB);
  const currentPrice = sqrtPriceX64ToPrice(sqrtPriceX64, decimalsA, decimalsB);

  const symbolA = mintA?.symbol || mintA?.address?.slice(0, 6) || "token0";
  const symbolB = mintB?.symbol || mintB?.address?.slice(0, 6) || "token1";

  // Fetch optional USD prices
  const mintAddresses: string[] = [];
  if (mintA?.address) mintAddresses.push(mintA.address);
  if (mintB?.address) mintAddresses.push(mintB.address);
  const tokenPrices = await withSpinner("Fetching token prices", () =>
    getTokenPrices(mintAddresses)
  );
  const priceAUsd = mintA?.address ? (tokenPrices.get(mintA.address) ?? null) : null;
  const priceBUsd = mintB?.address ? (tokenPrices.get(mintB.address) ?? null) : null;
  const usdValue = calculateUsdValue(amounts.amount0, amounts.amount1, priceAUsd, priceBUsd);

  if (isJsonOutput()) {
    logJson({
      nftMint: nftMint.toBase58(),
      poolId: position.poolId?.toBase58() ?? "unknown",
      mintA: {
        address: mintA?.address,
        symbol: mintA?.symbol,
        decimals: decimalsA,
        ...(priceAUsd !== null && { priceUsd: priceAUsd })
      },
      mintB: {
        address: mintB?.address,
        symbol: mintB?.symbol,
        decimals: decimalsB,
        ...(priceBUsd !== null && { priceUsd: priceBUsd })
      },
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      priceLower: priceLower.toString(),
      priceUpper: priceUpper.toString(),
      currentTick,
      currentPrice: currentPrice.toString(),
      inRange,
      liquidity: position.liquidity?.toString() ?? "0",
      amount0: amounts.amount0.toString(),
      amount1: amounts.amount1.toString(),
      ...(usdValue !== null && { usdValue: usdValue.toNumber() }),
      feesOwed0: position.tokenFeesOwedA?.toString() ?? "0",
      feesOwed1: position.tokenFeesOwedB?.toString() ?? "0",
      rewardInfos: position.rewardInfos?.map((r: { rewardAmountOwed?: { toString(): string } }) => ({
        rewardAmountOwed: r.rewardAmountOwed?.toString() ?? "0"
      })) ?? []
    });
    return;
  }

  logInfo(`Position: ${nftMint.toBase58()}`);
  logInfo(`Pool: ${position.poolId?.toBase58() ?? "unknown"}`);
  logInfo("");
  logInfo("Tokens:");
  logInfo(`  ${symbolA}: ${mintA?.address} (${decimalsA} decimals)`);
  if (priceAUsd !== null) logInfo(`    Price: ${formatUsd(priceAUsd)}`);
  logInfo(`  ${symbolB}: ${mintB?.address} (${decimalsB} decimals)`);
  if (priceBUsd !== null) logInfo(`    Price: ${formatUsd(priceBUsd)}`);
  logInfo("");
  logInfo("Range:");
  logInfo(`  Tick range: [${position.tickLower}, ${position.tickUpper}]`);
  logInfo(`  Price range: ${formatPrice(priceLower)} - ${formatPrice(priceUpper)} ${symbolB}/${symbolA}`);
  logInfo(`  Current tick: ${currentTick}`);
  logInfo(`  Current price: ${formatPrice(currentPrice)} ${symbolB}/${symbolA}`);
  logInfo(`  Status: ${inRange ? "IN RANGE" : "OUT OF RANGE"}`);
  logInfo("");
  logInfo("Liquidity:");
  logInfo(`  Total: ${position.liquidity?.toString() ?? "0"}`);
  logInfo(`  ${symbolA}: ${formatTokenAmount(amounts.amount0)}`);
  logInfo(`  ${symbolB}: ${formatTokenAmount(amounts.amount1)}`);
  if (usdValue !== null) logInfo(`  Value: ${formatUsd(usdValue)}`);
  logInfo("");
  logInfo("Fees Owed:");
  logInfo(`  ${symbolA}: ${position.tokenFeesOwedA?.toString() ?? "0"}`);
  logInfo(`  ${symbolB}: ${position.tokenFeesOwedB?.toString() ?? "0"}`);

  if (position.rewardInfos?.length) {
    logInfo("");
    logInfo("Rewards:");
    for (let i = 0; i < position.rewardInfos.length; i++) {
      const reward = position.rewardInfos[i];
      if (reward.rewardAmountOwed && !reward.rewardAmountOwed.isZero?.()) {
        logInfo(`  Reward ${i + 1}: ${reward.rewardAmountOwed?.toString() ?? "0"}`);
      }
    }
  }
}

// Helper function to get priority fee config
function getPriorityFeeConfig(
  priorityFeeSol: number
): { units: number; microLamports: number } | undefined {
  if (priorityFeeSol <= 0) return undefined;
  const DEFAULT_COMPUTE_UNITS = 600_000;
  const priorityFeeLamports = priorityFeeSol * 1e9;
  const priorityFeeMicroLamports = Math.round((priorityFeeLamports * 1e6) / DEFAULT_COMPUTE_UNITS);
  return { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports };
}

// Position with pool info (from getOwnerPositionInfo)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PositionWithPoolInfo = ClmmPositionLayout & { poolInfo?: any };

// Helper to find position by NFT mint
function findPositionByNftMint(
  positions: PositionWithPoolInfo[],
  nftMint: PublicKey
): PositionWithPoolInfo | undefined {
  const nftMintStr = nftMint.toBase58();
  return positions.find((p) => p.nftMint?.toBase58() === nftMintStr);
}

// Helper to check if position has unclaimed fees
function hasUnclaimedFees(position: PositionWithPoolInfo): boolean {
  const feesA = position.tokenFeesOwedA;
  const feesB = position.tokenFeesOwedB;
  const hasFeesA = feesA && !feesA.isZero();
  const hasFeesB = feesB && !feesB.isZero();
  return hasFeesA || hasFeesB;
}

async function handleCollectFeesCommand(options: {
  nftMint?: string;
  all?: boolean;
  priorityFee?: string;
}): Promise<void> {
  if (options.nftMint && options.all) {
    logError("Choose either --nft-mint <address> or --all, not both");
    process.exitCode = 1;
    return;
  }

  if (!options.nftMint && !options.all) {
    logError("Must specify --nft-mint <address> or --all");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig({ createIfMissing: true });
  const walletName = resolveWalletIdentifier(undefined, config.activeWallet);

  if (!walletName) {
    logError("No active wallet set");
    logInfo("Set an active wallet with: raydium wallet use <name>");
    process.exitCode = 1;
    return;
  }

  const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
  if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
    logError("Invalid priority fee");
    process.exitCode = 1;
    return;
  }

  let nftMint: PublicKey | undefined;
  if (options.nftMint) {
    try {
      nftMint = new PublicKey(options.nftMint);
    } catch {
      logError("Invalid NFT mint address");
      process.exitCode = 1;
      return;
    }
  }

  const password = await promptPassword("Enter wallet password");
  let owner: Keypair;
  try {
    owner = await decryptWallet(walletName, password);
  } catch (error) {
    logError("Failed to decrypt wallet", (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ owner, disableLoadToken: true })
  );

  const isDevnet = raydium.cluster !== "mainnet";
  const clmmProgramId = isDevnet ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;

  // Fetch all positions
  let positions: PositionWithPoolInfo[];
  try {
    positions = await withSpinner("Fetching positions", () =>
      raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId })
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch positions", msg);
    process.exitCode = 1;
    return;
  }

  if (!positions || positions.length === 0) {
    logError("No CLMM positions found");
    process.exitCode = 1;
    return;
  }

  // Filter positions
  let targetPositions: PositionWithPoolInfo[];
  if (options.all) {
    targetPositions = positions.filter(hasUnclaimedFees);
    if (targetPositions.length === 0) {
      logInfo("No positions with unclaimed fees found");
      return;
    }
  } else {
    const position = findPositionByNftMint(positions, nftMint!);
    if (!position) {
      logError(`Position not found for NFT mint: ${nftMint!.toBase58()}`);
      process.exitCode = 1;
      return;
    }
    if (!hasUnclaimedFees(position)) {
      logInfo("No fees to collect for this position");
      return;
    }
    targetPositions = [position];
  }

  // Show preview
  logInfo(`Positions to collect fees from: ${targetPositions.length}`);
  logInfo("");

  for (const pos of targetPositions) {
    const mintA = pos.poolInfo?.mintA;
    const mintB = pos.poolInfo?.mintB;
    const symbolA = mintA?.symbol || mintA?.address?.slice(0, 6) || "token0";
    const symbolB = mintB?.symbol || mintB?.address?.slice(0, 6) || "token1";

    logInfo(`Position: ${pos.nftMint.toBase58()}`);
    logInfo(`  Fees owed: ${pos.tokenFeesOwedA?.toString() ?? "0"} ${symbolA}, ${pos.tokenFeesOwedB?.toString() ?? "0"} ${symbolB}`);
  }
  logInfo("");

  const ok = await promptConfirm("Proceed with collecting fees?", false);
  if (!ok) {
    logInfo("Cancelled");
    return;
  }

  const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);
  const results: Array<{ nftMint: string; txId?: string; error?: string }> = [];

  for (const pos of targetPositions) {
    try {
      // Collect fees by calling decreaseLiquidity with 0 liquidity
      // This collects fees without removing any liquidity
      const poolData = await raydium.clmm.getPoolInfoFromRpc(pos.poolId.toBase58());
      if (!poolData.poolInfo) {
        throw new Error("Pool not found");
      }

      // Populate rewardDefaultInfos from on-chain data (needed for pools with rewards)
      populateRewardDefaultInfos(poolData.poolInfo);

      const txData = await withSpinner(`Building transaction for ${pos.nftMint.toBase58().slice(0, 8)}...`, () =>
        raydium.clmm.decreaseLiquidity({
          poolInfo: poolData.poolInfo,
          ownerPosition: pos,
          ownerInfo: {
            useSOLBalance: true,
            closePosition: false
          },
          liquidity: new BN(0), // 0 liquidity = collect fees only
          amountMinA: new BN(0),
          amountMinB: new BN(0),
          txVersion: TxVersion.V0,
          computeBudgetConfig
        })
      );

      const result = await withSpinner(`Sending transaction for ${pos.nftMint.toBase58().slice(0, 8)}...`, () =>
        txData.execute({ sendAndConfirm: true })
      );

      results.push({ nftMint: pos.nftMint.toBase58(), txId: result.txId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ nftMint: pos.nftMint.toBase58(), error: msg });
    }
  }

  // Output results
  if (isJsonOutput()) {
    logJson({ results });
  } else {
    logInfo("");
    for (const r of results) {
      if (r.txId) {
        logSuccess(`${r.nftMint}: ${r.txId}`);
      } else {
        logError(`${r.nftMint}: ${r.error}`);
      }
    }
  }
}

async function handleClosePositionCommand(options: {
  nftMint: string;
  force?: boolean;
  slippage?: string;
  priorityFee?: string;
}): Promise<void> {
  const config = await loadConfig({ createIfMissing: true });
  const walletName = resolveWalletIdentifier(undefined, config.activeWallet);

  if (!walletName) {
    logError("No active wallet set");
    logInfo("Set an active wallet with: raydium wallet use <name>");
    process.exitCode = 1;
    return;
  }

  let nftMint: PublicKey;
  try {
    nftMint = new PublicKey(options.nftMint);
  } catch {
    logError("Invalid NFT mint address");
    process.exitCode = 1;
    return;
  }

  const slippagePercent = options.slippage ? Number(options.slippage) : config["default-slippage"];
  if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
    logError("Invalid slippage percent");
    process.exitCode = 1;
    return;
  }
  if (options.slippage && !options.force) {
    logError("--slippage is only used with --force because closing an empty position does not remove liquidity");
    process.exitCode = 1;
    return;
  }

  const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
  if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
    logError("Invalid priority fee");
    process.exitCode = 1;
    return;
  }

  const password = await promptPassword("Enter wallet password");
  let owner: Keypair;
  try {
    owner = await decryptWallet(walletName, password);
  } catch (error) {
    logError("Failed to decrypt wallet", (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ owner, disableLoadToken: true })
  );

  const isDevnet = raydium.cluster !== "mainnet";
  const clmmProgramId = isDevnet ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;

  // Fetch positions
  let positions: PositionWithPoolInfo[];
  try {
    positions = await withSpinner("Fetching positions", () =>
      raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId })
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch positions", msg);
    process.exitCode = 1;
    return;
  }

  const position = findPositionByNftMint(positions, nftMint);
  if (!position) {
    logError(`Position not found for NFT mint: ${nftMint.toBase58()}`);
    process.exitCode = 1;
    return;
  }

  const hasLiquidity = position.liquidity && !position.liquidity.isZero();

  if (hasLiquidity && !options.force) {
    logError("Position still has liquidity. Use --force to remove liquidity and close.");
    logInfo(`Current liquidity: ${position.liquidity.toString()}`);
    process.exitCode = 1;
    return;
  }

  // Fetch pool info
  const poolData = await withSpinner("Fetching pool info", () =>
    raydium.clmm.getPoolInfoFromRpc(position.poolId.toBase58())
  );

  if (!poolData.poolInfo) {
    logError("Pool not found");
    process.exitCode = 1;
    return;
  }

  const poolInfo = poolData.poolInfo;
  const computePoolInfo = poolData.computePoolInfo;

  // Populate rewardDefaultInfos from on-chain data (needed for pools with rewards)
  populateRewardDefaultInfos(poolInfo);

  const mintA = poolInfo.mintA;
  const mintB = poolInfo.mintB;
  const symbolA = mintA?.symbol || mintA?.address?.slice(0, 6) || "token0";
  const symbolB = mintB?.symbol || mintB?.address?.slice(0, 6) || "token1";

  // Show preview
  logInfo(`Position: ${nftMint.toBase58()}`);
  logInfo(`Pool: ${position.poolId.toBase58()}`);

  if (hasLiquidity) {
    const decimalsA = mintA.decimals;
    const decimalsB = mintB.decimals;
    const amounts = getAmountsFromLiquidity(
      position.liquidity.toString(),
      computePoolInfo.sqrtPriceX64.toString(),
      position.tickLower,
      position.tickUpper,
      decimalsA,
      decimalsB
    );

    logInfo(`Liquidity to remove: ${position.liquidity.toString()}`);
    logInfo(`Expected ${symbolA}: ${formatTokenAmount(amounts.amount0)}`);
    logInfo(`Expected ${symbolB}: ${formatTokenAmount(amounts.amount1)}`);
    logInfo(`Slippage: ${slippagePercent}%`);
  }

  if (hasUnclaimedFees(position)) {
    logInfo(`Fees to collect: ${position.tokenFeesOwedA?.toString() ?? "0"} ${symbolA}, ${position.tokenFeesOwedB?.toString() ?? "0"} ${symbolB}`);
  }

  logInfo("");
  const ok = await promptConfirm("Proceed with closing position?", false);
  if (!ok) {
    logInfo("Cancelled");
    return;
  }

  const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);

  try {
    let result: { txId: string };

    if (hasLiquidity) {
      // Calculate minimum amounts with slippage
      const decimalsA = mintA.decimals;
      const decimalsB = mintB.decimals;
      const amounts = getAmountsFromLiquidity(
        position.liquidity.toString(),
        computePoolInfo.sqrtPriceX64.toString(),
        position.tickLower,
        position.tickUpper,
        decimalsA,
        decimalsB
      );

      const amountARaw = amounts.amount0.mul(new Decimal(10).pow(decimalsA));
      const amountBRaw = amounts.amount1.mul(new Decimal(10).pow(decimalsB));
      const amountMinA = applySlippage(new BN(amountARaw.floor().toString()), slippagePercent, true);
      const amountMinB = applySlippage(new BN(amountBRaw.floor().toString()), slippagePercent, true);

      // Decrease liquidity with closePosition flag
      const txData = await withSpinner("Building transaction", () =>
        raydium.clmm.decreaseLiquidity({
          poolInfo,
          ownerPosition: position,
          ownerInfo: {
            useSOLBalance: true,
            closePosition: true
          },
          liquidity: position.liquidity,
          amountMinA,
          amountMinB,
          txVersion: TxVersion.V0,
          computeBudgetConfig
        })
      );

      result = await withSpinner("Sending transaction", () =>
        txData.execute({ sendAndConfirm: true })
      );
    } else {
      // Just close the empty position
      const txData = await withSpinner("Building transaction", () =>
        raydium.clmm.closePosition({
          poolInfo,
          ownerPosition: position,
          txVersion: TxVersion.V0,
          computeBudgetConfig
        })
      );

      result = await withSpinner("Sending transaction", () =>
        txData.execute({ sendAndConfirm: true })
      );
    }

    if (isJsonOutput()) {
      logJson({ txId: result.txId });
    } else {
      logSuccess(`Position closed: ${result.txId}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to close position", msg);
    process.exitCode = 1;
  }
}

async function handleDecreaseLiquidityCommand(options: {
  nftMint: string;
  percent: string;
  slippage?: string;
  priorityFee?: string;
  swapToSol?: boolean;
}): Promise<void> {
  const config = await loadConfig({ createIfMissing: true });
  const walletName = resolveWalletIdentifier(undefined, config.activeWallet);

  if (!walletName) {
    logError("No active wallet set");
    logInfo("Set an active wallet with: raydium wallet use <name>");
    process.exitCode = 1;
    return;
  }

  let nftMint: PublicKey;
  try {
    nftMint = new PublicKey(options.nftMint);
  } catch {
    logError("Invalid NFT mint address");
    process.exitCode = 1;
    return;
  }

  const percent = Number(options.percent);
  if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
    logError("Percent must be between 1 and 100");
    process.exitCode = 1;
    return;
  }

  const slippagePercent = options.slippage ? Number(options.slippage) : config["default-slippage"];
  if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
    logError("Invalid slippage percent");
    process.exitCode = 1;
    return;
  }

  const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
  if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
    logError("Invalid priority fee");
    process.exitCode = 1;
    return;
  }

  const password = await promptPassword("Enter wallet password");
  let owner: Keypair;
  try {
    owner = await decryptWallet(walletName, password);
  } catch (error) {
    logError("Failed to decrypt wallet", (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ owner, disableLoadToken: true })
  );

  const isDevnet = raydium.cluster !== "mainnet";
  const clmmProgramId = isDevnet ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;

  // Fetch positions
  let positions: PositionWithPoolInfo[];
  try {
    positions = await withSpinner("Fetching positions", () =>
      raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId })
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch positions", msg);
    process.exitCode = 1;
    return;
  }

  const position = findPositionByNftMint(positions, nftMint);
  if (!position) {
    logError(`Position not found for NFT mint: ${nftMint.toBase58()}`);
    process.exitCode = 1;
    return;
  }

  if (!position.liquidity || position.liquidity.isZero()) {
    logError("Position has no liquidity to remove");
    process.exitCode = 1;
    return;
  }

  // Fetch pool info
  const poolData = await withSpinner("Fetching pool info", () =>
    raydium.clmm.getPoolInfoFromRpc(position.poolId.toBase58())
  );

  if (!poolData.poolInfo) {
    logError("Pool not found");
    process.exitCode = 1;
    return;
  }

  const poolInfo = poolData.poolInfo;
  const computePoolInfo = poolData.computePoolInfo;

  // Populate rewardDefaultInfos from on-chain data (needed for pools with rewards)
  populateRewardDefaultInfos(poolInfo);

  const mintA = poolInfo.mintA;
  const mintB = poolInfo.mintB;
  const decimalsA = mintA.decimals;
  const decimalsB = mintB.decimals;
  const symbolA = mintA?.symbol || mintA?.address?.slice(0, 6) || "token0";
  const symbolB = mintB?.symbol || mintB?.address?.slice(0, 6) || "token1";

  // Calculate liquidity to remove
  const liquidityToRemove = position.liquidity.mul(new BN(percent)).div(new BN(100));

  // Calculate expected amounts
  const amounts = getAmountsFromLiquidity(
    liquidityToRemove.toString(),
    computePoolInfo.sqrtPriceX64.toString(),
    position.tickLower,
    position.tickUpper,
    decimalsA,
    decimalsB
  );

  // Show preview
  logInfo(`Position: ${nftMint.toBase58()}`);
  logInfo(`Pool: ${position.poolId.toBase58()}`);
  logInfo(`Removing: ${percent}% of liquidity`);
  logInfo(`Current liquidity: ${position.liquidity.toString()}`);
  logInfo(`Liquidity to remove: ${liquidityToRemove.toString()}`);
  logInfo(`Expected ${symbolA}: ${formatTokenAmount(amounts.amount0)}`);
  logInfo(`Expected ${symbolB}: ${formatTokenAmount(amounts.amount1)}`);
  logInfo(`Slippage: ${slippagePercent}%`);
  logInfo("");

  const ok = await promptConfirm("Proceed with removing liquidity?", false);
  if (!ok) {
    logInfo("Cancelled");
    return;
  }

  const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);

  try {
    // Calculate minimum amounts with slippage
    const amountARaw = amounts.amount0.mul(new Decimal(10).pow(decimalsA));
    const amountBRaw = amounts.amount1.mul(new Decimal(10).pow(decimalsB));
    const amountMinA = applySlippage(new BN(amountARaw.floor().toString()), slippagePercent, true);
    const amountMinB = applySlippage(new BN(amountBRaw.floor().toString()), slippagePercent, true);

    const txData = await withSpinner("Building transaction", () =>
      raydium.clmm.decreaseLiquidity({
        poolInfo,
        ownerPosition: position,
        ownerInfo: {
          useSOLBalance: true,
          closePosition: false
        },
        liquidity: liquidityToRemove,
        amountMinA,
        amountMinB,
        txVersion: TxVersion.V0,
        computeBudgetConfig
      })
    );

    const result = await withSpinner("Sending transaction", () =>
      txData.execute({ sendAndConfirm: true })
    );

    if (isJsonOutput()) {
      logJson({ txId: result.txId, liquidityRemoved: liquidityToRemove.toString() });
    } else {
      logSuccess(`Liquidity removed: ${result.txId}`);
    }

    // Swap to SOL if requested
    if (options.swapToSol) {
      logInfo("");
      logInfo("Swapping withdrawn tokens to SOL...");

      // Brief pause to let the withdrawal settle
      await new Promise((r) => setTimeout(r, 2000));

      const swapSlippage = slippagePercent / 100;
      const tokensToSwap: Array<{ mint: typeof mintA; amount: Decimal; symbol: string; decimals: number }> = [];

      // Check if we have tokenA to swap (skip if it's SOL)
      if (mintA.address !== WRAPPED_SOL_MINT && amounts.amount0.gt(0)) {
        tokensToSwap.push({ mint: mintA, amount: amounts.amount0, symbol: symbolA, decimals: decimalsA });
      }

      // Check if we have tokenB to swap (skip if it's SOL)
      if (mintB.address !== WRAPPED_SOL_MINT && amounts.amount1.gt(0)) {
        tokensToSwap.push({ mint: mintB, amount: amounts.amount1, symbol: symbolB, decimals: decimalsB });
      }

      for (const tokenToSwap of tokensToSwap) {
        try {
          // Find swap pool for this token to SOL
          const swapPoolData = await withSpinner(`Finding ${tokenToSwap.symbol}/SOL swap pool`, async () => {
            const poolsResult = await raydium.api.fetchPoolByMints({
              mint1: tokenToSwap.mint.address,
              mint2: WRAPPED_SOL_MINT
            });

            const pools = poolsResult.data || [];
            const ammPool = pools.find(
              (p: { programId: string }) => p.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
            );

            if (ammPool) {
              return raydium.liquidity.getPoolInfoFromRpc({ poolId: ammPool.id });
            }
            return null;
          });

          if (!swapPoolData || !swapPoolData.poolInfo) {
            logError(`No swap pool found for ${tokenToSwap.symbol}/SOL, skipping swap`);
            continue;
          }

          const swapPoolInfo = swapPoolData.poolInfo;
          const swapPoolKeys = swapPoolData.poolKeys;
          const swapRpcData = swapPoolData.poolRpcData;

          // Get actual balance (might differ from expected due to fees/slippage)
          const actualBalance = await getTokenBalance(raydium.connection, owner.publicKey, tokenToSwap.mint.address);
          const actualBalanceDecimal = new Decimal(actualBalance.toString()).div(new Decimal(10).pow(tokenToSwap.decimals));

          if (actualBalanceDecimal.lte(0)) {
            logInfo(`No ${tokenToSwap.symbol} balance to swap`);
            continue;
          }

          // Calculate expected SOL output
          const poolMintA = swapPoolInfo.mintA;
          const poolMintB = swapPoolInfo.mintB;
          const poolDecimalsA = poolMintA.decimals;
          const poolDecimalsB = poolMintB.decimals;

          const reserveA = new Decimal(swapRpcData.baseReserve.toString()).div(new Decimal(10).pow(poolDecimalsA));
          const reserveB = new Decimal(swapRpcData.quoteReserve.toString()).div(new Decimal(10).pow(poolDecimalsB));

          const tokenIsPoolMintA = poolMintA.address === tokenToSwap.mint.address;
          const priceOfTokenInSol = tokenIsPoolMintA
            ? reserveB.div(reserveA)
            : reserveA.div(reserveB);

          const estimatedSolOut = actualBalanceDecimal.mul(priceOfTokenInSol);

          logInfo(`Swapping ~${formatTokenAmount(actualBalanceDecimal)} ${tokenToSwap.symbol} for ~${formatTokenAmount(estimatedSolOut)} SOL`);

          const swapAmountRaw = actualBalance;

          const computeOut = raydium.liquidity.computeAmountOut({
            poolInfo: {
              ...swapPoolInfo,
              baseReserve: swapRpcData.baseReserve,
              quoteReserve: swapRpcData.quoteReserve,
              status: swapRpcData.status.toNumber(),
              version: 4
            },
            amountIn: swapAmountRaw,
            mintIn: tokenToSwap.mint.address,
            mintOut: WRAPPED_SOL_MINT,
            slippage: swapSlippage
          });

          const swapTxData = await withSpinner(`Building ${tokenToSwap.symbol} swap`, () =>
            raydium.liquidity.swap({
              txVersion: TxVersion.V0,
              poolInfo: swapPoolInfo,
              poolKeys: swapPoolKeys,
              amountIn: swapAmountRaw,
              amountOut: computeOut.minAmountOut,
              inputMint: tokenToSwap.mint.address,
              fixedSide: "in",
              config: {
                associatedOnly: true,
                inputUseSolBalance: false,
                outputUseSolBalance: true
              },
              computeBudgetConfig
            })
          );

          const swapResult = await withSpinner(`Executing ${tokenToSwap.symbol} swap`, () =>
            swapTxData.execute({ sendAndConfirm: true })
          );

          logSuccess(`${tokenToSwap.symbol} swapped to SOL: ${swapResult.txId}`);

          // Brief pause between swaps
          await new Promise((r) => setTimeout(r, 1000));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logError(`Failed to swap ${tokenToSwap.symbol} to SOL`, msg);
          // Continue with other swaps
        }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logErrorWithDebug("Failed to remove liquidity", error, {
      fallback: msg || "(no message)"
    });
    process.exitCode = 1;
  }
}

async function handleIncreaseLiquidityCommand(options: {
  nftMint: string;
  amount: string;
  token?: string;
  slippage?: string;
  priorityFee?: string;
  autoSwap?: boolean;
}): Promise<void> {
  const config = await loadConfig({ createIfMissing: true });
  const walletName = resolveWalletIdentifier(undefined, config.activeWallet);

  if (!walletName) {
    logError("No active wallet set");
    logInfo("Set an active wallet with: raydium wallet use <name>");
    process.exitCode = 1;
    return;
  }

  let nftMint: PublicKey;
  try {
    nftMint = new PublicKey(options.nftMint);
  } catch {
    logError("Invalid NFT mint address");
    process.exitCode = 1;
    return;
  }

  let amount: Decimal;
  try {
    amount = parsePositiveDecimalInput(options.amount, "Amount");
  } catch (error) {
    logError((error as Error).message);
    process.exitCode = 1;
    return;
  }

  const baseToken = (options.token?.toUpperCase() ?? "A") as "A" | "B";
  if (baseToken !== "A" && baseToken !== "B") {
    logError("Token must be A or B");
    process.exitCode = 1;
    return;
  }

  const slippagePercent = options.slippage ? Number(options.slippage) : config["default-slippage"];
  if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
    logError("Invalid slippage percent");
    process.exitCode = 1;
    return;
  }

  const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
  if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
    logError("Invalid priority fee");
    process.exitCode = 1;
    return;
  }

  const password = await promptPassword("Enter wallet password");
  let owner: Keypair;
  try {
    owner = await decryptWallet(walletName, password);
  } catch (error) {
    logError("Failed to decrypt wallet", (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ owner, disableLoadToken: true })
  );

  const isDevnet = raydium.cluster !== "mainnet";
  const clmmProgramId = isDevnet ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;

  // Fetch positions
  let positions: PositionWithPoolInfo[];
  try {
    positions = await withSpinner("Fetching positions", () =>
      raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId })
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch positions", msg);
    process.exitCode = 1;
    return;
  }

  const position = findPositionByNftMint(positions, nftMint);
  if (!position) {
    logError(`Position not found for NFT mint: ${nftMint.toBase58()}`);
    process.exitCode = 1;
    return;
  }

  // Fetch pool info
  const poolData = await withSpinner("Fetching pool info", () =>
    raydium.clmm.getPoolInfoFromRpc(position.poolId.toBase58())
  );

  if (!poolData.poolInfo) {
    logError("Pool not found");
    process.exitCode = 1;
    return;
  }

  const poolInfo = poolData.poolInfo;
  const computePoolInfo = poolData.computePoolInfo;
  const mintA = poolInfo.mintA;
  const mintB = poolInfo.mintB;
  const decimalsA = mintA.decimals;
  const decimalsB = mintB.decimals;
  const symbolA = mintA?.symbol || mintA?.address?.slice(0, 6) || "token0";
  const symbolB = mintB?.symbol || mintB?.address?.slice(0, 6) || "token1";

  const inRange = isPositionInRange(position.tickLower, position.tickUpper, computePoolInfo.tickCurrent);

  // Calculate base amount in raw units
  const baseDecimals = baseToken === "A" ? decimalsA : decimalsB;
  const baseAmount = new BN(amount.mul(new Decimal(10).pow(baseDecimals)).floor().toString());

  // Use SDK to calculate liquidity and other amount
  const epochInfo = await raydium.connection.getEpochInfo();
  const liquidityInfo = await withSpinner("Calculating liquidity", () =>
    PoolUtils.getLiquidityAmountOutFromAmountIn({
      poolInfo,
      inputA: baseToken === "A",
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      amount: baseAmount,
      slippage: slippagePercent / 100,
      add: true,
      epochInfo,
      amountHasFee: false
    })
  );

  const otherAmount = baseToken === "A" ? liquidityInfo.amountB : liquidityInfo.amountA;
  const otherSlippageAmount = baseToken === "A" ? liquidityInfo.amountSlippageB : liquidityInfo.amountSlippageA;
  const otherDecimals = baseToken === "A" ? decimalsB : decimalsA;
  const otherSymbol = baseToken === "A" ? symbolB : symbolA;
  const baseSymbol = baseToken === "A" ? symbolA : symbolB;
  const baseMint = baseToken === "A" ? mintA : mintB;
  const otherMint = baseToken === "A" ? mintB : mintA;

  const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);

  // Auto-swap logic
  if (options.autoSwap) {
    const otherAmountRequired = new Decimal(otherSlippageAmount.amount.toString()).div(new Decimal(10).pow(otherDecimals));

    // Check balances
    const balances = await withSpinner("Checking token balances", async () => {
      const baseBalance = await getTokenBalance(raydium.connection, owner.publicKey, baseMint.address);
      const otherBalance = await getTokenBalance(raydium.connection, owner.publicKey, otherMint.address);
      return {
        baseBalance: new Decimal(baseBalance.toString()).div(new Decimal(10).pow(baseDecimals)),
        otherBalance: new Decimal(otherBalance.toString()).div(new Decimal(10).pow(otherDecimals))
      };
    });

    logInfo(`Your balances:`);
    logInfo(`  ${baseSymbol}: ${formatTokenAmount(balances.baseBalance)}`);
    logInfo(`  ${otherSymbol}: ${formatTokenAmount(balances.otherBalance)}`);
    logInfo("");

    const otherShortfall = otherAmountRequired.sub(balances.otherBalance);

    if (otherShortfall.gt(0)) {
      logInfo(`Shortfall: ${formatTokenAmount(otherShortfall)} ${otherSymbol}`);

      // Find a swap pool
      const swapPoolData = await withSpinner("Finding swap pool", async () => {
        const poolsResult = await raydium.api.fetchPoolByMints({
          mint1: baseMint.address,
          mint2: otherMint.address
        });

        const pools = poolsResult.data || [];
        const ammPool = pools.find(
          (p: { programId: string }) => p.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
        );

        if (ammPool) {
          return raydium.liquidity.getPoolInfoFromRpc({ poolId: ammPool.id });
        }
        return null;
      });

      if (!swapPoolData || !swapPoolData.poolInfo) {
        logError(`No swap pool found for ${baseSymbol}/${otherSymbol}`);
        logInfo("You can manually swap tokens first, then retry without --auto-swap");
        process.exitCode = 1;
        return;
      }

      const swapPoolInfo = swapPoolData.poolInfo;
      const swapPoolKeys = swapPoolData.poolKeys;
      const swapRpcData = swapPoolData.poolRpcData;

      logInfo(`Using swap pool: ${swapPoolInfo.id}`);

      const swapSlippage = slippagePercent / 100;
      const swapAmountNeeded = otherShortfall.mul(1 + swapSlippage);

      const poolMintA = swapPoolInfo.mintA;
      const poolMintB = swapPoolInfo.mintB;
      const poolDecimalsA = poolMintA.decimals;
      const poolDecimalsB = poolMintB.decimals;

      const reserveA = new Decimal(swapRpcData.baseReserve.toString()).div(new Decimal(10).pow(poolDecimalsA));
      const reserveB = new Decimal(swapRpcData.quoteReserve.toString()).div(new Decimal(10).pow(poolDecimalsB));

      const baseMintIsPoolMintA = poolMintA.address === baseMint.address;
      const priceOfBaseInOther = baseMintIsPoolMintA
        ? reserveB.div(reserveA)
        : reserveA.div(reserveB);

      const estimatedSwapIn = swapAmountNeeded.div(priceOfBaseInOther).mul(1.05);

      logInfo(`Swapping ~${formatTokenAmount(estimatedSwapIn)} ${baseSymbol} for ~${formatTokenAmount(swapAmountNeeded)} ${otherSymbol}`);
      logInfo("");

      const swapOk = await promptConfirm("Proceed with swap first?", false);
      if (!swapOk) {
        logInfo("Cancelled");
        return;
      }

      try {
        const swapAmountRaw = new BN(estimatedSwapIn.mul(new Decimal(10).pow(baseDecimals)).floor().toString());

        const computeOut = raydium.liquidity.computeAmountOut({
          poolInfo: {
            ...swapPoolInfo,
            baseReserve: swapRpcData.baseReserve,
            quoteReserve: swapRpcData.quoteReserve,
            status: swapRpcData.status.toNumber(),
            version: 4
          },
          amountIn: swapAmountRaw,
          mintIn: baseMint.address,
          mintOut: otherMint.address,
          slippage: swapSlippage
        });

        const inputIsSol = baseMint.address === WRAPPED_SOL_MINT;
        const outputIsSol = otherMint.address === WRAPPED_SOL_MINT;

        const swapTxData = await withSpinner("Building swap transaction", () =>
          raydium.liquidity.swap({
            txVersion: TxVersion.V0,
            poolInfo: swapPoolInfo,
            poolKeys: swapPoolKeys,
            amountIn: swapAmountRaw,
            amountOut: computeOut.minAmountOut,
            inputMint: baseMint.address,
            fixedSide: "in",
            config: {
              associatedOnly: true,
              inputUseSolBalance: inputIsSol,
              outputUseSolBalance: outputIsSol
            },
            computeBudgetConfig
          })
        );

        const swapResult = await withSpinner("Executing swap", () =>
          swapTxData.execute({ sendAndConfirm: true })
        );

        logSuccess(`Swap completed: ${swapResult.txId}`);
        logInfo("");

        await new Promise((r) => setTimeout(r, 2000));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logError("Swap failed", msg);
        process.exitCode = 1;
        return;
      }
    }
  }

  // Show preview
  logInfo(`Position: ${nftMint.toBase58()}`);
  logInfo(`Pool: ${position.poolId.toBase58()}`);
  logInfo(`Status: ${inRange ? "IN RANGE" : "OUT OF RANGE"}`);
  logInfo(`Current liquidity: ${position.liquidity.toString()}`);
  logInfo("");
  logInfo(`Adding:`);
  logInfo(`  ${baseSymbol}: ${amount}`);
  logInfo(`  ${otherSymbol}: ${formatTokenAmount(new Decimal(otherAmount.amount.toString()).div(new Decimal(10).pow(otherDecimals)))}`);
  logInfo(`  Max ${otherSymbol} (with slippage): ${formatTokenAmount(new Decimal(otherSlippageAmount.amount.toString()).div(new Decimal(10).pow(otherDecimals)))}`);
  logInfo(`Slippage: ${slippagePercent}%`);
  logInfo("");

  const ok = await promptConfirm("Proceed with adding liquidity?", false);
  if (!ok) {
    logInfo("Cancelled");
    return;
  }

  try {
    // The SDK types expect ClmmPoolPersonalPosition but only uses tickLower, tickUpper, nftMint
    // which all exist on ClmmPositionLayout, so we can safely cast
    const txData = await withSpinner("Building transaction", () =>
      raydium.clmm.increasePositionFromBase({
        poolInfo,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ownerPosition: position as any,
        ownerInfo: {
          useSOLBalance: true
        },
        base: baseToken === "A" ? "MintA" : "MintB",
        baseAmount,
        otherAmountMax: otherSlippageAmount.amount,
        txVersion: TxVersion.V0,
        computeBudgetConfig
      })
    );

    const result = await withSpinner("Sending transaction", () =>
      txData.execute({ sendAndConfirm: true })
    );

    if (isJsonOutput()) {
      logJson({ txId: result.txId });
    } else {
      logSuccess(`Liquidity added: ${result.txId}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to add liquidity", msg);
    process.exitCode = 1;
  }
}

async function handleOpenPositionCommand(options: {
  poolId: string;
  priceLower: string;
  priceUpper: string;
  amount: string;
  token?: string;
  slippage?: string;
  priorityFee?: string;
  autoSwap?: boolean;
}): Promise<void> {
  const config = await loadConfig({ createIfMissing: true });
  const walletName = resolveWalletIdentifier(undefined, config.activeWallet);

  if (!walletName) {
    logError("No active wallet set");
    logInfo("Set an active wallet with: raydium wallet use <name>");
    process.exitCode = 1;
    return;
  }

  let poolId: PublicKey;
  try {
    poolId = new PublicKey(options.poolId);
  } catch {
    logError("Invalid pool ID");
    process.exitCode = 1;
    return;
  }

  let priceLower: Decimal;
  let priceUpper: Decimal;
  try {
    priceLower = parsePositiveDecimalInput(options.priceLower, "Lower price");
    priceUpper = parsePositiveDecimalInput(options.priceUpper, "Upper price");
  } catch (error) {
    logError((error as Error).message);
    process.exitCode = 1;
    return;
  }
  if (priceLower.gte(priceUpper)) {
    logError("Lower price must be less than upper price");
    process.exitCode = 1;
    return;
  }

  let amount: Decimal;
  try {
    amount = parsePositiveDecimalInput(options.amount, "Amount");
  } catch (error) {
    logError((error as Error).message);
    process.exitCode = 1;
    return;
  }

  const baseToken = (options.token?.toUpperCase() ?? "A") as "A" | "B";
  if (baseToken !== "A" && baseToken !== "B") {
    logError("Token must be A or B");
    process.exitCode = 1;
    return;
  }

  const slippagePercent = options.slippage ? Number(options.slippage) : config["default-slippage"];
  if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
    logError("Invalid slippage percent");
    process.exitCode = 1;
    return;
  }

  const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
  if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
    logError("Invalid priority fee");
    process.exitCode = 1;
    return;
  }

  const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);

  const password = await promptPassword("Enter wallet password");
  let owner: Keypair;
  try {
    owner = await decryptWallet(walletName, password);
  } catch (error) {
    logError("Failed to decrypt wallet", (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ owner, disableLoadToken: true })
  );

  // Fetch pool info
  const poolData = await withSpinner("Fetching pool info", () =>
    raydium.clmm.getPoolInfoFromRpc(poolId.toBase58())
  );

  if (!poolData.poolInfo) {
    logError("Pool not found");
    process.exitCode = 1;
    return;
  }

  if (!VALID_CLMM_PROGRAM_IDS.has(poolData.poolInfo.programId)) {
    logError("Not a CLMM pool");
    process.exitCode = 1;
    return;
  }

  const poolInfo = poolData.poolInfo;
  const computePoolInfo = poolData.computePoolInfo;
  const mintA = poolInfo.mintA;
  const mintB = poolInfo.mintB;
  const decimalsA = mintA.decimals;
  const decimalsB = mintB.decimals;
  const symbolA = mintA?.symbol || mintA?.address?.slice(0, 6) || "token0";
  const symbolB = mintB?.symbol || mintB?.address?.slice(0, 6) || "token1";
  const tickSpacing = computePoolInfo.tickSpacing;

  // Convert prices to ticks aligned with tick spacing
  const tickLower = priceToAlignedTick(priceLower, tickSpacing, decimalsA, decimalsB);
  const tickUpper = priceToAlignedTick(priceUpper, tickSpacing, decimalsA, decimalsB);

  // Calculate actual prices from aligned ticks
  const actualPriceLower = tickToPrice(tickLower, decimalsA, decimalsB);
  const actualPriceUpper = tickToPrice(tickUpper, decimalsA, decimalsB);

  const currentPrice = sqrtPriceX64ToPrice(computePoolInfo.sqrtPriceX64.toString(), decimalsA, decimalsB);
  const inRange = computePoolInfo.tickCurrent >= tickLower && computePoolInfo.tickCurrent < tickUpper;

  // Calculate base amount in raw units
  const baseDecimals = baseToken === "A" ? decimalsA : decimalsB;
  const baseAmount = new BN(amount.mul(new Decimal(10).pow(baseDecimals)).floor().toString());

  // Use SDK to calculate liquidity and other amount
  const epochInfo = await raydium.connection.getEpochInfo();
  const liquidityInfo = await withSpinner("Calculating liquidity", () =>
    PoolUtils.getLiquidityAmountOutFromAmountIn({
      poolInfo,
      inputA: baseToken === "A",
      tickLower,
      tickUpper,
      amount: baseAmount,
      slippage: slippagePercent / 100,
      add: true,
      epochInfo,
      amountHasFee: false
    })
  );

  const otherAmount = baseToken === "A" ? liquidityInfo.amountB : liquidityInfo.amountA;
  const otherSlippageAmount = baseToken === "A" ? liquidityInfo.amountSlippageB : liquidityInfo.amountSlippageA;
  const otherDecimals = baseToken === "A" ? decimalsB : decimalsA;
  const otherSymbol = baseToken === "A" ? symbolB : symbolA;
  const baseSymbol = baseToken === "A" ? symbolA : symbolB;
  const otherMint = baseToken === "A" ? mintB : mintA;
  const baseMint = baseToken === "A" ? mintA : mintB;

  // Calculate required amounts in human-readable format
  const otherAmountRequired = new Decimal(otherSlippageAmount.amount.toString()).div(new Decimal(10).pow(otherDecimals));
  const baseAmountRequired = amount;

  // Check balances if auto-swap is enabled
  if (options.autoSwap) {
    const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

    // Get user's token balances
    const balances = await withSpinner("Checking token balances", async () => {
      const solBalance = await raydium.connection.getBalance(owner.publicKey);
      const solBalanceDecimal = new Decimal(solBalance).div(1e9);

      // Check for the "other" token balance
      let otherBalance = new Decimal(0);
      if (otherMint.address === WRAPPED_SOL_MINT) {
        otherBalance = solBalanceDecimal;
      } else {
        try {
          const tokenAccounts = await raydium.connection.getTokenAccountsByOwner(owner.publicKey, {
            mint: new PublicKey(otherMint.address)
          });
          if (tokenAccounts.value.length > 0) {
            // Parse token account data to get balance
            const accountData = tokenAccounts.value[0].account.data;
            // Token account: first 32 bytes mint, next 32 bytes owner, next 8 bytes amount
            const amountBytes = accountData.slice(64, 72);
            const rawAmount = new BN(amountBytes, "le");
            otherBalance = new Decimal(rawAmount.toString()).div(new Decimal(10).pow(otherDecimals));
          }
        } catch {
          // No token account found
        }
      }

      // Check base token balance
      let baseBalance = new Decimal(0);
      if (baseMint.address === WRAPPED_SOL_MINT) {
        baseBalance = solBalanceDecimal;
      } else {
        try {
          const tokenAccounts = await raydium.connection.getTokenAccountsByOwner(owner.publicKey, {
            mint: new PublicKey(baseMint.address)
          });
          if (tokenAccounts.value.length > 0) {
            const accountData = tokenAccounts.value[0].account.data;
            const amountBytes = accountData.slice(64, 72);
            const rawAmount = new BN(amountBytes, "le");
            baseBalance = new Decimal(rawAmount.toString()).div(new Decimal(10).pow(baseDecimals));
          }
        } catch {
          // No token account found
        }
      }

      return { solBalance: solBalanceDecimal, otherBalance, baseBalance };
    });

    logInfo(`Your balances:`);
    logInfo(`  ${baseSymbol}: ${formatTokenAmount(balances.baseBalance)}`);
    logInfo(`  ${otherSymbol}: ${formatTokenAmount(balances.otherBalance)}`);
    logInfo("");

    // Check if we need to swap
    const otherShortfall = otherAmountRequired.sub(balances.otherBalance);

    if (otherShortfall.gt(0)) {
      logInfo(`Shortfall: ${formatTokenAmount(otherShortfall)} ${otherSymbol}`);

      // Find a swap pool and execute swap
      // Use Raydium API to find pools containing both tokens
      const swapPoolData = await withSpinner("Finding swap pool", async () => {
        // Search for pools with both tokens
        const poolsResult = await raydium.api.fetchPoolByMints({
          mint1: baseMint.address,
          mint2: otherMint.address
        });

        const pools = poolsResult.data || [];

        // Find an AMM V4 pool (standard swap pool)
        const ammPool = pools.find(
          (p: { programId: string }) => p.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
        );

        if (ammPool) {
          // Get RPC data for the pool
          return raydium.liquidity.getPoolInfoFromRpc({ poolId: ammPool.id });
        }
        return null;
      });

      if (!swapPoolData || !swapPoolData.poolInfo) {
        logError(`No swap pool found for ${baseSymbol}/${otherSymbol}`);
        logInfo("You can manually swap tokens first, then retry without --auto-swap");
        process.exitCode = 1;
        return;
      }

      const swapPoolInfo = swapPoolData.poolInfo;
      const swapPoolKeys = swapPoolData.poolKeys;
      const swapRpcData = swapPoolData.poolRpcData;

      logInfo(`Using swap pool: ${swapPoolInfo.id}`);

      // Calculate how much of base token to swap (add some buffer for slippage)
      const swapSlippage = slippagePercent / 100;
      const swapAmountNeeded = otherShortfall.mul(1 + swapSlippage); // Add buffer

      // Estimate how much base token we need to swap to get the required other token
      // Pool reserves are in raw units, need to account for decimals
      const poolMintA = swapPoolInfo.mintA;
      const poolMintB = swapPoolInfo.mintB;
      const poolDecimalsA = poolMintA.decimals;
      const poolDecimalsB = poolMintB.decimals;

      // Convert reserves to human-readable amounts
      const reserveA = new Decimal(swapRpcData.baseReserve.toString()).div(new Decimal(10).pow(poolDecimalsA));
      const reserveB = new Decimal(swapRpcData.quoteReserve.toString()).div(new Decimal(10).pow(poolDecimalsB));

      // Determine which pool token is our base token (the one we're swapping FROM)
      const baseMintIsPoolMintA = poolMintA.address === baseMint.address;

      // Price of baseMint in terms of otherMint
      // If baseMint is mintA: price = reserveB / reserveA (how much B per A)
      // If baseMint is mintB: price = reserveA / reserveB (how much A per B)
      const priceOfBaseInOther = baseMintIsPoolMintA
        ? reserveB.div(reserveA)
        : reserveA.div(reserveB);

      // To get swapAmountNeeded of otherMint, we need: swapAmountNeeded / priceOfBaseInOther of baseMint
      const estimatedSwapIn = swapAmountNeeded.div(priceOfBaseInOther).mul(1.05); // 5% buffer

      logInfo(`Swapping ~${formatTokenAmount(estimatedSwapIn)} ${baseSymbol} for ~${formatTokenAmount(swapAmountNeeded)} ${otherSymbol}`);
      logInfo("");

      const swapOk = await promptConfirm("Proceed with swap first?", false);
      if (!swapOk) {
        logInfo("Cancelled");
        return;
      }

      // Execute the swap
      try {
        const swapAmountRaw = new BN(estimatedSwapIn.mul(new Decimal(10).pow(baseDecimals)).floor().toString());

        const computeOut = raydium.liquidity.computeAmountOut({
          poolInfo: {
            ...swapPoolInfo,
            baseReserve: swapRpcData.baseReserve,
            quoteReserve: swapRpcData.quoteReserve,
            status: swapRpcData.status.toNumber(),
            version: 4
          },
          amountIn: swapAmountRaw,
          mintIn: baseMint.address,
          mintOut: otherMint.address,
          slippage: swapSlippage
        });

        const inputIsSol = baseMint.address === WRAPPED_SOL_MINT;
        const outputIsSol = otherMint.address === WRAPPED_SOL_MINT;

        const swapTxData = await withSpinner("Building swap transaction", () =>
          raydium.liquidity.swap({
            txVersion: TxVersion.V0,
            poolInfo: swapPoolInfo,
            poolKeys: swapPoolKeys,
            amountIn: swapAmountRaw,
            amountOut: computeOut.minAmountOut,
            inputMint: baseMint.address,
            fixedSide: "in",
            config: {
              associatedOnly: true,
              inputUseSolBalance: inputIsSol,
              outputUseSolBalance: outputIsSol
            },
            computeBudgetConfig
          })
        );

        const swapResult = await withSpinner("Executing swap", () =>
          swapTxData.execute({ sendAndConfirm: true })
        );

        logSuccess(`Swap completed: ${swapResult.txId}`);
        logInfo("");

        // Brief pause to let the transaction settle
        await new Promise((r) => setTimeout(r, 2000));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logErrorWithDebug("Swap failed", error, { fallback: msg });
        process.exitCode = 1;
        return;
      }
    }
  }

  // Show preview
  logInfo(`Pool: ${poolId.toBase58()}`);
  logInfo(`Pair: ${symbolA}/${symbolB}`);
  logInfo(`Tick spacing: ${tickSpacing}`);
  logInfo("");
  logInfo("Price Range:");
  logInfo(`  Lower: ${formatPrice(actualPriceLower)} ${symbolB}/${symbolA} (tick ${tickLower})`);
  logInfo(`  Upper: ${formatPrice(actualPriceUpper)} ${symbolB}/${symbolA} (tick ${tickUpper})`);
  logInfo(`  Current: ${formatPrice(currentPrice)} ${symbolB}/${symbolA} (tick ${computePoolInfo.tickCurrent})`);
  logInfo(`  Status: ${inRange ? "IN RANGE" : "OUT OF RANGE"}`);
  logInfo("");
  logInfo("Deposit:");
  logInfo(`  ${baseSymbol}: ${amount}`);
  logInfo(`  ${otherSymbol}: ${formatTokenAmount(new Decimal(otherAmount.amount.toString()).div(new Decimal(10).pow(otherDecimals)))}`);
  logInfo(`  Max ${otherSymbol} (with slippage): ${formatTokenAmount(new Decimal(otherSlippageAmount.amount.toString()).div(new Decimal(10).pow(otherDecimals)))}`);
  logInfo(`Slippage: ${slippagePercent}%`);
  logInfo("");

  const ok = await promptConfirm("Proceed with opening position?", false);
  if (!ok) {
    logInfo("Cancelled");
    return;
  }

  try {
    const txData = await withSpinner("Building transaction", () =>
      raydium.clmm.openPositionFromBase({
        poolInfo,
        ownerInfo: {
          useSOLBalance: true
        },
        tickLower,
        tickUpper,
        base: baseToken === "A" ? "MintA" : "MintB",
        baseAmount,
        otherAmountMax: otherSlippageAmount.amount,
        txVersion: TxVersion.V0,
        computeBudgetConfig
      })
    );

    const result = await withSpinner("Sending transaction", () =>
      txData.execute({ sendAndConfirm: true })
    );

    if (isJsonOutput()) {
      logJson({
        txId: result.txId,
        nftMint: txData.extInfo.nftMint.toBase58()
      });
    } else {
      logSuccess(`Position opened: ${result.txId}`);
      logInfo(`NFT Mint: ${txData.extInfo.nftMint.toBase58()}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to open position", msg);
    process.exitCode = 1;
  }
}

async function handleCreatePoolCommand(options: {
  mintA: string;
  mintB: string;
  feeTier: string;
  initialPrice: string;
  priorityFee?: string;
}): Promise<void> {
  const config = await loadConfig({ createIfMissing: true });
  const walletName = resolveWalletIdentifier(undefined, config.activeWallet);

  if (!walletName) {
    logError("No active wallet set");
    logInfo("Set an active wallet with: raydium wallet use <name>");
    process.exitCode = 1;
    return;
  }

  let mintAPubkey: PublicKey;
  let mintBPubkey: PublicKey;
  try {
    mintAPubkey = new PublicKey(options.mintA);
    mintBPubkey = new PublicKey(options.mintB);
  } catch {
    logError("Invalid mint address");
    process.exitCode = 1;
    return;
  }
  if (mintAPubkey.equals(mintBPubkey)) {
    logError("--mint-a and --mint-b must be different token mints");
    process.exitCode = 1;
    return;
  }

  const feeTierBps = Number(options.feeTier);
  if (!Number.isFinite(feeTierBps) || feeTierBps <= 0) {
    logError("Fee tier must be a positive number (in basis points)");
    process.exitCode = 1;
    return;
  }

  const initialPrice = Number(options.initialPrice);
  if (!Number.isFinite(initialPrice) || initialPrice <= 0) {
    logError("Initial price must be a positive number");
    process.exitCode = 1;
    return;
  }

  const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
  if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
    logError("Invalid priority fee");
    process.exitCode = 1;
    return;
  }

  const password = await promptPassword("Enter wallet password");
  let owner: Keypair;
  try {
    owner = await decryptWallet(walletName, password);
  } catch (error) {
    logError("Failed to decrypt wallet", (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const raydium = await withSpinner("Loading SDK", () =>
    loadRaydium({ owner, disableLoadToken: true })
  );

  // Fetch token info for both mints
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mintAInfo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mintBInfo: any;

  try {
    const tokenInfos = await withSpinner("Fetching token info", async () => {
      const [infoA, infoB] = await Promise.all([
        raydium.token.getTokenInfo(mintAPubkey),
        raydium.token.getTokenInfo(mintBPubkey)
      ]);
      return { infoA, infoB };
    });
    mintAInfo = tokenInfos.infoA;
    mintBInfo = tokenInfos.infoB;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch token info", msg);
    process.exitCode = 1;
    return;
  }

  if (!mintAInfo || !mintBInfo) {
    logError("Could not find token info for one or both mints");
    process.exitCode = 1;
    return;
  }

  const symbolA = mintAInfo.symbol || mintAPubkey.toBase58().slice(0, 6);
  const symbolB = mintBInfo.symbol || mintBPubkey.toBase58().slice(0, 6);
  const decimalsA = mintAInfo.decimals;
  const decimalsB = mintBInfo.decimals;

  // Fetch CLMM configs and find matching fee tier
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clmmConfigs: any[];
  try {
    clmmConfigs = await withSpinner("Fetching CLMM configs", () =>
      raydium.api.getClmmConfigs()
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to fetch CLMM configs", msg);
    process.exitCode = 1;
    return;
  }

  // Find config matching fee tier (tradeFeeRate is in 1e6 format)
  // e.g., 500 bps = 0.05% = 5000 in 1e6 format
  const targetFeeRate = feeTierBps * 10; // Convert bps to 1e6 format
  const matchingConfig = clmmConfigs.find(
    (c) => c.tradeFeeRate === targetFeeRate
  );

  if (!matchingConfig) {
    logError(`No CLMM config found for fee tier ${feeTierBps} bps`);
    logInfo("Available fee tiers:");
    for (const c of clmmConfigs) {
      const bps = c.tradeFeeRate / 10;
      logInfo(`  ${bps} bps (tick spacing: ${c.tickSpacing})`);
    }
    process.exitCode = 1;
    return;
  }

  const tickSpacing = matchingConfig.tickSpacing;

  // Show preview
  logInfo("Create CLMM Pool:");
  logInfo(`  Token A: ${symbolA} (${mintAPubkey.toBase58()})`);
  logInfo(`  Token B: ${symbolB} (${mintBPubkey.toBase58()})`);
  logInfo(`  Fee tier: ${feeTierBps / 100}% (${feeTierBps} bps)`);
  logInfo(`  Tick spacing: ${tickSpacing}`);
  logInfo(`  Initial price: ${initialPrice} ${symbolB}/${symbolA}`);
  logInfo("");

  const ok = await promptConfirm("Proceed with creating pool?", false);
  if (!ok) {
    logInfo("Cancelled");
    return;
  }

  const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);

  try {
    const isDevnet = raydium.cluster !== "mainnet";
    const clmmProgramId = isDevnet ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;

    const txData = await withSpinner("Building transaction", () =>
      raydium.clmm.createPool({
        programId: clmmProgramId,
        mint1: {
          address: mintAPubkey.toBase58(),
          decimals: decimalsA,
          symbol: symbolA,
          name: mintAInfo.name || symbolA,
          programId: mintAInfo.programId || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          chainId: 101,
          logoURI: "",
          tags: [],
          extensions: {}
        },
        mint2: {
          address: mintBPubkey.toBase58(),
          decimals: decimalsB,
          symbol: symbolB,
          name: mintBInfo.name || symbolB,
          programId: mintBInfo.programId || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          chainId: 101,
          logoURI: "",
          tags: [],
          extensions: {}
        },
        ammConfig: {
          id: new PublicKey(matchingConfig.id),
          index: matchingConfig.index,
          protocolFeeRate: matchingConfig.protocolFeeRate,
          tradeFeeRate: matchingConfig.tradeFeeRate,
          tickSpacing: matchingConfig.tickSpacing,
          fundFeeRate: matchingConfig.fundFeeRate,
          fundOwner: "",
          description: ""
        },
        initialPrice: new Decimal(initialPrice),
        txVersion: TxVersion.V0,
        computeBudgetConfig
      })
    );

    const result = await withSpinner("Sending transaction", () =>
      txData.execute({ sendAndConfirm: true })
    );

    const poolIdStr = txData.extInfo.address.id;
    const vaultA = txData.extInfo.address.vault.A;
    const vaultB = txData.extInfo.address.vault.B;

    if (isJsonOutput()) {
      logJson({
        txId: result.txId,
        poolId: poolIdStr,
        vaultA,
        vaultB
      });
    } else {
      logSuccess(`Pool created: ${result.txId}`);
      logInfo(`Pool ID: ${poolIdStr}`);
      logInfo(`Vault A: ${vaultA}`);
      logInfo(`Vault B: ${vaultB}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError("Failed to create pool", msg);
    process.exitCode = 1;
  }
}
