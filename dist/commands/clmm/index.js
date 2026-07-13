"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerClmmCommands = void 0;
const web3_js_1 = require("@solana/web3.js");
const raydium_sdk_v2_1 = require("@raydium-io/raydium-sdk-v2");
const decimal_js_1 = __importDefault(require("decimal.js"));
const bn_js_1 = __importDefault(require("bn.js"));
const config_manager_1 = require("../../lib/config-manager");
const wallet_manager_1 = require("../../lib/wallet-manager");
const prompt_1 = require("../../lib/prompt");
const output_1 = require("../../lib/output");
const raydium_client_1 = require("../../lib/raydium-client");
const clmm_utils_1 = require("../../lib/clmm-utils");
const token_price_1 = require("../../lib/token-price");
const help_1 = require("../../lib/help");
const csv_1 = require("../../lib/csv");
const VALID_CLMM_PROGRAM_IDS = new Set([
    raydium_sdk_v2_1.CLMM_PROGRAM_ID.toBase58(),
    raydium_sdk_v2_1.DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID.toBase58()
]);
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
function rawToUiAmount(value, decimals) {
    const raw = value && typeof value.toString === "function"
        ? String(value)
        : "0";
    return new decimal_js_1.default(raw).div(new decimal_js_1.default(10).pow(decimals)).toString();
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addressString(value) {
    if (typeof value === "string")
        return value;
    if (typeof value?.address === "string")
        return value.address;
    if (typeof value?.toBase58 === "function")
        return value.toBase58();
    return "unknown";
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildRewardReports(position, poolInfo) {
    const positionRewards = Array.isArray(position.rewardInfos) ? position.rewardInfos : [];
    const poolRewards = Array.isArray(poolInfo?.rewardInfos) ? poolInfo.rewardInfos : [];
    const defaultRewards = Array.isArray(poolInfo?.rewardDefaultInfos)
        ? poolInfo.rewardDefaultInfos
        : [];
    return positionRewards
        .map((reward, index) => {
        const poolReward = poolRewards[index] ?? {};
        const defaultReward = defaultRewards[index] ?? {};
        const mint = addressString(defaultReward.mint?.address ?? defaultReward.mint ?? poolReward.tokenMint);
        const decimalsValue = defaultReward.mint?.decimals ?? defaultReward.decimals ?? poolReward.decimals;
        const decimals = decimalsValue === undefined ? null : Number(decimalsValue);
        const amountOwedRaw = reward.rewardAmountOwed?.toString?.() ?? "0";
        return {
            mint,
            symbol: defaultReward.mint?.symbol ??
                defaultReward.symbol ??
                (mint === "unknown" ? `reward${index + 1}` : mint.slice(0, 6)),
            amountOwed: decimals !== null && Number.isFinite(decimals)
                ? rawToUiAmount(amountOwedRaw, decimals)
                : amountOwedRaw,
            amountOwedRaw,
            decimals: decimals !== null && Number.isFinite(decimals) ? decimals : null
        };
    })
        .filter((reward) => reward.amountOwedRaw !== "0");
}
function parsePositiveDecimalInput(value, label) {
    const normalized = value.trim();
    if (!/^\d+(\.\d+)?$/.test(normalized)) {
        throw new Error(`${label} must be a positive decimal number`);
    }
    const decimal = new decimal_js_1.default(normalized);
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
function populateRewardDefaultInfos(poolInfo) {
    if (poolInfo.rewardDefaultInfos && poolInfo.rewardDefaultInfos.length > 0) {
        return; // Already populated
    }
    const rewardInfos = poolInfo.rewardInfos || [];
    const activeRewards = [];
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
async function getTokenBalance(connection, owner, mintAddress) {
    if (mintAddress === WRAPPED_SOL_MINT) {
        const balance = await connection.getBalance(owner);
        return new bn_js_1.default(balance);
    }
    try {
        const tokenAccounts = await connection.getTokenAccountsByOwner(owner, {
            mint: new web3_js_1.PublicKey(mintAddress)
        });
        if (tokenAccounts.value.length > 0) {
            const accountData = tokenAccounts.value[0].account.data;
            // Token account: first 32 bytes mint, next 32 bytes owner, next 8 bytes amount
            const amountBytes = accountData.slice(64, 72);
            return new bn_js_1.default(amountBytes, "le");
        }
    }
    catch {
        // Return 0 on error
    }
    return new bn_js_1.default(0);
}
function registerClmmCommands(program) {
    const clmm = program.command("clmm").description("CLMM (concentrated liquidity) commands");
    const withPasswordOptions = (cmd, sections) => (0, help_1.addRichHelp)(cmd, {
        auth: help_1.PASSWORD_AUTH_HELP,
        automation: help_1.AUTOMATION_HELP,
        ...sections
    });
    // clmm pool <pool-id>
    clmm
        .command("pool")
        .description("Show CLMM pool state")
        .argument("[pool-id]", "Pool address (prompted when omitted)")
        .action(handlePoolCommand);
    // clmm ticks <pool-id>
    clmm
        .command("ticks")
        .description("List initialized ticks with liquidity")
        .argument("[pool-id]", "Pool address (prompted when omitted)")
        .option("--min-tick <tick>", "Minimum tick index")
        .option("--max-tick <tick>", "Maximum tick index")
        .option("--limit <number>", "Maximum ticks to display", "50")
        .action(handleTicksCommand);
    // clmm positions
    clmm
        .command("positions")
        .description("List all positions for the active wallet")
        .option("--wallet <name>", "Wallet name to use (defaults to active wallet)")
        .option("--pool-id <address>", "Only include positions in this pool")
        .option("--format <format>", "table|json|csv", "table")
        .option("--output <path>", "Write JSON or CSV to a file; use - for stdout")
        .option("--force", "Overwrite an existing output file")
        .action(handlePositionsCommand);
    // clmm position <nft-mint>
    clmm
        .command("position")
        .description("Show detailed position state")
        .argument("[nft-mint]", "Position NFT mint address (prompted when omitted)")
        .action(handlePositionCommand);
    // clmm collect-fees
    withPasswordOptions(clmm
        .command("collect-fees")
        .description("Collect accumulated fees from position(s)")
        .option("--nft-mint <address>", "Position NFT mint address (prompted when omitted)")
        .option("--all", "Collect fees from all positions with unclaimed fees")
        .option("--priority-fee <sol>", "Priority fee in SOL")).action(handleCollectFeesCommand);
    // clmm close-position
    withPasswordOptions(clmm
        .command("close-position")
        .description("Close a CLMM position")
        .option("--nft-mint <address>", "Position NFT mint address (prompted when omitted)")
        .option("--force", "Remove all liquidity first, then close")
        .option("--slippage <percent>", "Slippage tolerance for force mode")
        .option("--priority-fee <sol>", "Priority fee in SOL")).action(handleClosePositionCommand);
    // clmm decrease-liquidity
    withPasswordOptions(clmm
        .command("decrease-liquidity")
        .description("Remove liquidity from a position")
        .option("--nft-mint <address>", "Position NFT mint address (prompted when omitted)")
        .option("--percent <number>", "Percentage of liquidity to remove (1-100; prompted when omitted)")
        .option("--slippage <percent>", "Slippage tolerance")
        .option("--priority-fee <sol>", "Priority fee in SOL")
        .option("--swap-to-sol", "Swap both withdrawn tokens to SOL after removing liquidity")).action(handleDecreaseLiquidityCommand);
    // clmm increase-liquidity
    withPasswordOptions(clmm
        .command("increase-liquidity")
        .description("Add liquidity to an existing position")
        .option("--nft-mint <address>", "Position NFT mint address (prompted when omitted)")
        .option("--amount <number>", "Amount to add (prompted when omitted)")
        .option("--token <A|B>", "Which token the amount refers to", "A")
        .option("--slippage <percent>", "Slippage tolerance")
        .option("--priority-fee <sol>", "Priority fee in SOL")
        .option("--auto-swap", "Automatically swap tokens if you don't have enough of the other token"), {
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
    }).action(handleIncreaseLiquidityCommand);
    // clmm open-position
    withPasswordOptions(clmm
        .command("open-position")
        .description("Open a new liquidity position")
        .option("--pool-id <address>", "Pool address (prompted when omitted)")
        .option("--price-lower <number>", "Lower price bound (prompted when omitted)")
        .option("--price-upper <number>", "Upper price bound (prompted when omitted)")
        .option("--amount <number>", "Deposit amount (prompted when omitted)")
        .option("--token <A|B>", "Which token the amount refers to", "A")
        .option("--slippage <percent>", "Slippage tolerance")
        .option("--priority-fee <sol>", "Priority fee in SOL")
        .option("--auto-swap", "Automatically swap to get required tokens if balance is insufficient"), {
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
    }).action(handleOpenPositionCommand);
    // clmm create-pool
    withPasswordOptions(clmm
        .command("create-pool")
        .description("Create a new CLMM pool")
        .option("--mint-a <address>", "Token A mint address (prompted when omitted)")
        .option("--mint-b <address>", "Token B mint address (prompted when omitted)")
        .option("--fee-tier <bps>", "Fee tier in basis points (e.g., 500, 3000, 10000; prompted when omitted)")
        .option("--initial-price <number>", "Initial price of token A in terms of token B (prompted when omitted)")
        .option("--priority-fee <sol>", "Priority fee in SOL")).action(handleCreatePoolCommand);
}
exports.registerClmmCommands = registerClmmCommands;
async function handlePoolCommand(poolIdStr) {
    poolIdStr = await (0, prompt_1.promptIfMissing)(poolIdStr, "Pool address");
    let poolId;
    try {
        poolId = new web3_js_1.PublicKey(poolIdStr);
    }
    catch {
        (0, output_1.logError)("Invalid pool ID");
        process.exitCode = 1;
        return;
    }
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ disableLoadToken: true }));
    let poolInfo;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let computePoolInfo;
    try {
        const data = await (0, output_1.withSpinner)("Fetching pool info", async () => {
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
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch pool info", msg);
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
    const currentPrice = (0, clmm_utils_1.sqrtPriceX64ToPrice)(sqrtPriceX64, decimalsA, decimalsB);
    const symbolA = mintA.symbol || mintA.address.slice(0, 6);
    const symbolB = mintB.symbol || mintB.address.slice(0, 6);
    // Fee rate is in the poolInfo from API
    const feeRate = poolInfo.feeRate;
    const protocolFeeRate = computePoolInfo.ammConfig?.protocolFeeRate ?? 0;
    const fundFeeRate = computePoolInfo.ammConfig?.fundFeeRate ?? 0;
    // Pool reserves (raw amounts from API, need to adjust for decimals)
    const mintAmountARaw = poolInfo.mintAmountA;
    const mintAmountBRaw = poolInfo.mintAmountB;
    const amountA = new decimal_js_1.default(mintAmountARaw).div(new decimal_js_1.default(10).pow(decimalsA));
    const amountB = new decimal_js_1.default(mintAmountBRaw).div(new decimal_js_1.default(10).pow(decimalsB));
    const tvl = poolInfo.tvl;
    // Fetch optional USD prices
    const prices = await (0, output_1.withSpinner)("Fetching token prices", () => (0, token_price_1.getTokenPrices)([mintA.address, mintB.address]));
    const priceA = prices.get(mintA.address) ?? null;
    const priceB = prices.get(mintB.address) ?? null;
    const calculatedTvl = (0, clmm_utils_1.calculateUsdValue)(amountA, amountB, priceA, priceB);
    if ((0, output_1.isJsonOutput)()) {
        (0, output_1.logJson)({
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
    (0, output_1.logInfo)(`Pool: ${poolId.toBase58()}`);
    (0, output_1.logInfo)(`Program: ${poolInfo.programId}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Tokens:");
    (0, output_1.logInfo)(`  ${symbolA}: ${mintA.address} (${decimalsA} decimals)`);
    if (priceA !== null)
        (0, output_1.logInfo)(`    Price: ${(0, clmm_utils_1.formatUsd)(priceA)}`);
    (0, output_1.logInfo)(`  ${symbolB}: ${mintB.address} (${decimalsB} decimals)`);
    if (priceB !== null)
        (0, output_1.logInfo)(`    Price: ${(0, clmm_utils_1.formatUsd)(priceB)}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Price:");
    (0, output_1.logInfo)(`  Current tick: ${tickCurrent}`);
    (0, output_1.logInfo)(`  sqrtPriceX64: ${sqrtPriceX64}`);
    (0, output_1.logInfo)(`  Price: ${(0, clmm_utils_1.formatPrice)(currentPrice)} ${symbolB}/${symbolA}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Liquidity:");
    (0, output_1.logInfo)(`  In-range liquidity: ${liquidity}`);
    (0, output_1.logInfo)(`  ${symbolA} in pool: ${(0, clmm_utils_1.formatTokenAmount)(amountA)}`);
    (0, output_1.logInfo)(`  ${symbolB} in pool: ${(0, clmm_utils_1.formatTokenAmount)(amountB)}`);
    if (tvl > 0)
        (0, output_1.logInfo)(`  TVL: $${tvl.toLocaleString()}`);
    if (calculatedTvl !== null && tvl <= 0)
        (0, output_1.logInfo)(`  TVL: ${(0, clmm_utils_1.formatUsd)(calculatedTvl)}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Fees:");
    (0, output_1.logInfo)(`  Fee rate: ${(0, clmm_utils_1.formatFeeRate)(feeRate)}`);
    (0, output_1.logInfo)(`  Tick spacing: ${tickSpacing}`);
    (0, output_1.logInfo)(`  Protocol fee rate: ${protocolFeeRate / 10000}%`);
    (0, output_1.logInfo)(`  Fund fee rate: ${fundFeeRate / 10000}%`);
}
async function handleTicksCommand(poolIdStr, options) {
    poolIdStr = await (0, prompt_1.promptIfMissing)(poolIdStr, "Pool address");
    let poolId;
    try {
        poolId = new web3_js_1.PublicKey(poolIdStr);
    }
    catch {
        (0, output_1.logError)("Invalid pool ID");
        process.exitCode = 1;
        return;
    }
    const limit = options.limit ? Number(options.limit) : 50;
    if (!Number.isFinite(limit) || limit < 1) {
        (0, output_1.logError)("Invalid limit");
        process.exitCode = 1;
        return;
    }
    const minTick = options.minTick ? Number(options.minTick) : undefined;
    const maxTick = options.maxTick ? Number(options.maxTick) : undefined;
    if ((minTick !== undefined && !Number.isFinite(minTick)) ||
        (maxTick !== undefined && !Number.isFinite(maxTick))) {
        (0, output_1.logError)("--min-tick and --max-tick must be numeric tick indexes");
        process.exitCode = 1;
        return;
    }
    if (minTick !== undefined && maxTick !== undefined && minTick > maxTick) {
        (0, output_1.logError)("--min-tick cannot be greater than --max-tick");
        process.exitCode = 1;
        return;
    }
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ disableLoadToken: true }));
    let poolInfo;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let computePoolInfo;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tickData;
    try {
        const data = await (0, output_1.withSpinner)("Fetching pool and tick data", async () => {
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
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch pool info", msg);
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
    const initializedTicks = [];
    if (tickData && typeof tickData === "object") {
        // Get the pool's tick data
        const poolTickData = tickData[poolId.toBase58()];
        if (poolTickData && typeof poolTickData === "object") {
            // Iterate over tick arrays (keyed by start index)
            for (const tickArray of Object.values(poolTickData)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const ticks = tickArray?.ticks;
                if (ticks && Array.isArray(ticks)) {
                    for (const tick of ticks) {
                        if (tick && tick.liquidityGross && !tick.liquidityGross.isZero()) {
                            const tickIndex = tick.tick;
                            if (minTick !== undefined && tickIndex < minTick)
                                continue;
                            if (maxTick !== undefined && tickIndex > maxTick)
                                continue;
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
    const prices = await (0, output_1.withSpinner)("Fetching token prices", () => (0, token_price_1.getTokenPrices)([mintA.address, mintB.address]));
    const priceA = prices.get(mintA.address) ?? null;
    const priceB = prices.get(mintB.address) ?? null;
    // Calculate amounts for each tick
    const ticksWithAmounts = displayTicks.map((t) => {
        const price = (0, clmm_utils_1.tickToPrice)(t.tick, decimalsA, decimalsB);
        const amounts = (0, clmm_utils_1.getAmountsForTickRange)(t.liquidityNet, t.tick, tickSpacing, currentTick, sqrtPriceX64, decimalsA, decimalsB);
        const usdValue = (0, clmm_utils_1.calculateUsdValue)(amounts.amount0, amounts.amount1, priceA, priceB);
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
    if ((0, output_1.isJsonOutput)()) {
        (0, output_1.logJson)({
            poolId: poolId.toBase58(),
            currentTick,
            tickSpacing,
            totalInitialized: initializedTicks.length,
            displayed: displayTicks.length,
            ticks: ticksWithAmounts
        });
        return;
    }
    (0, output_1.logInfo)(`Pool: ${poolId.toBase58()}`);
    (0, output_1.logInfo)(`Current tick: ${currentTick}`);
    (0, output_1.logInfo)(`Tick spacing: ${tickSpacing}`);
    (0, output_1.logInfo)(`Initialized ticks: ${initializedTicks.length} (showing ${displayTicks.length})`);
    (0, output_1.logInfo)("");
    if (displayTicks.length === 0) {
        (0, output_1.logInfo)("No initialized ticks found in range");
        return;
    }
    for (const t of ticksWithAmounts) {
        const isNearCurrent = Math.abs(t.tick - currentTick) <= tickSpacing;
        const marker = isNearCurrent ? " <-- current" : "";
        const price = new decimal_js_1.default(t.price);
        (0, output_1.logInfo)(`Tick ${t.tick}${marker}`);
        (0, output_1.logInfo)(`  Price: ${(0, clmm_utils_1.formatPrice)(price)} ${symbolB}/${symbolA}`);
        (0, output_1.logInfo)(`  Liquidity net: ${t.liquidityNet}`);
        (0, output_1.logInfo)(`  Liquidity gross: ${t.liquidityGross}`);
        (0, output_1.logInfo)(`  ${symbolA}: ${(0, clmm_utils_1.formatTokenAmount)(new decimal_js_1.default(t.amount0))}`);
        (0, output_1.logInfo)(`  ${symbolB}: ${(0, clmm_utils_1.formatTokenAmount)(new decimal_js_1.default(t.amount1))}`);
        if (t.usdValue !== undefined)
            (0, output_1.logInfo)(`  Value: ${(0, clmm_utils_1.formatUsd)(t.usdValue)}`);
    }
}
async function handlePositionsCommand(options) {
    if (!["table", "json", "csv"].includes(options.format)) {
        (0, output_1.logError)("Invalid format. Use table, json, or csv.");
        process.exitCode = 1;
        return;
    }
    if (options.format === "table" && options.output && !(0, output_1.isJsonOutput)()) {
        (0, output_1.logError)("--output requires --format json or --format csv");
        process.exitCode = 1;
        return;
    }
    let poolFilter;
    if (options.poolId) {
        try {
            poolFilter = new web3_js_1.PublicKey(options.poolId).toBase58();
        }
        catch {
            (0, output_1.logError)("Invalid pool ID");
            process.exitCode = 1;
            return;
        }
    }
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(options.wallet, config.activeWallet);
    if (!walletName) {
        (0, output_1.logError)("No wallet specified and no active wallet set");
        (0, output_1.logInfo)("Use --wallet <name> or set an active wallet with: raydium wallet use <name>");
        process.exitCode = 1;
        return;
    }
    const owner = await (0, wallet_manager_1.getWalletPublicKey)(walletName);
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
    const isDevnet = raydium.cluster !== "mainnet";
    const clmmProgramId = isDevnet ? raydium_sdk_v2_1.DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : raydium_sdk_v2_1.CLMM_PROGRAM_ID;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let positions;
    try {
        positions = await (0, output_1.withSpinner)("Fetching positions", () => raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId }));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch positions", msg);
        process.exitCode = 1;
        return;
    }
    if (poolFilter) {
        positions = positions.filter((position) => position.poolId?.toBase58() === poolFilter);
    }
    // Collect unique pool IDs
    const poolIds = new Set();
    for (const pos of positions) {
        if (pos.poolId)
            poolIds.add(pos.poolId.toBase58());
    }
    // Fetch fresh pool data from RPC for accurate current tick
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poolDataMap = new Map();
    if (poolIds.size > 0) {
        try {
            const poolDataResults = await (0, output_1.withSpinner)("Fetching pool data", async () => {
                const results = await Promise.all(Array.from(poolIds).map(async (poolId) => {
                    try {
                        const data = await raydium.clmm.getPoolInfoFromRpc(poolId);
                        return { poolId, data };
                    }
                    catch {
                        return { poolId, data: null };
                    }
                }));
                return results;
            });
            for (const { poolId, data } of poolDataResults) {
                if (data?.poolInfo) {
                    poolDataMap.set(poolId, data);
                }
            }
        }
        catch {
            // Continue without fresh pool data
        }
    }
    // Collect unique mint addresses for price fetching
    const uniqueMints = new Set();
    for (const pos of positions) {
        const freshPoolData = poolDataMap.get(pos.poolId?.toBase58() ?? "");
        const poolInfo = freshPoolData?.poolInfo ?? pos.poolInfo;
        if (poolInfo?.mintA?.address)
            uniqueMints.add(poolInfo.mintA.address);
        if (poolInfo?.mintB?.address)
            uniqueMints.add(poolInfo.mintB.address);
    }
    // Fetch optional USD prices
    const tokenPrices = await (0, output_1.withSpinner)("Fetching token prices", () => (0, token_price_1.getTokenPrices)(Array.from(uniqueMints)));
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
        const inRange = (0, clmm_utils_1.isPositionInRange)(pos.tickLower, pos.tickUpper, currentTick);
        const amounts = (0, clmm_utils_1.getAmountsFromLiquidity)(pos.liquidity?.toString() ?? "0", sqrtPriceX64, pos.tickLower, pos.tickUpper, decimalsA, decimalsB);
        const priceA = mintA?.address ? (tokenPrices.get(mintA.address) ?? null) : null;
        const priceB = mintB?.address ? (tokenPrices.get(mintB.address) ?? null) : null;
        const usdValue = (0, clmm_utils_1.calculateUsdValue)(amounts.amount0, amounts.amount1, priceA, priceB);
        const priceLower = (0, clmm_utils_1.tickToPrice)(pos.tickLower, decimalsA, decimalsB);
        const priceUpper = (0, clmm_utils_1.tickToPrice)(pos.tickUpper, decimalsA, decimalsB);
        const currentPrice = (0, clmm_utils_1.sqrtPriceX64ToPrice)(sqrtPriceX64, decimalsA, decimalsB);
        const feesOwed0Raw = pos.tokenFeesOwedA?.toString() ?? "0";
        const feesOwed1Raw = pos.tokenFeesOwedB?.toString() ?? "0";
        return {
            nftMint: pos.nftMint?.toBase58() ?? "unknown",
            poolId: poolIdStr || "unknown",
            tickLower: pos.tickLower,
            tickUpper: pos.tickUpper,
            currentTick,
            priceLower: priceLower.toString(),
            priceUpper: priceUpper.toString(),
            currentPrice: currentPrice.toString(),
            inRange,
            liquidity: pos.liquidity?.toString() ?? "0",
            amount0: amounts.amount0.toString(),
            amount1: amounts.amount1.toString(),
            symbol0: mintA?.symbol || mintA?.address?.slice(0, 6) || "token0",
            symbol1: mintB?.symbol || mintB?.address?.slice(0, 6) || "token1",
            feesOwed0: rawToUiAmount(feesOwed0Raw, decimalsA),
            feesOwed1: rawToUiAmount(feesOwed1Raw, decimalsB),
            feesOwed0Raw,
            feesOwed1Raw,
            rewards: buildRewardReports(pos, poolInfo),
            ...(usdValue !== null && { usdValue: usdValue.toNumber() })
        };
    });
    const report = {
        wallet: owner.toBase58(),
        walletName,
        poolId: poolFilter ?? null,
        positions: positionsData,
        count: positionsData.length
    };
    if ((0, output_1.isJsonOutput)()) {
        if (options.output) {
            const resolved = await (0, csv_1.writeExport)(`${JSON.stringify(report, null, 2)}\n`, options.output, Boolean(options.force));
            if (resolved)
                process.stderr.write(`Wrote ${resolved}\n`);
        }
        else {
            (0, output_1.logJson)(report);
        }
        return;
    }
    if (options.format === "csv") {
        const csv = (0, csv_1.serializeCsv)(positionsData, [
            { header: "wallet", value: () => owner.toBase58() },
            { header: "nftMint", value: (position) => position.nftMint },
            { header: "poolId", value: (position) => position.poolId },
            { header: "inRange", value: (position) => position.inRange },
            { header: "tickLower", value: (position) => position.tickLower },
            { header: "tickUpper", value: (position) => position.tickUpper },
            { header: "currentTick", value: (position) => position.currentTick },
            { header: "priceLower", value: (position) => position.priceLower },
            { header: "priceUpper", value: (position) => position.priceUpper },
            { header: "currentPrice", value: (position) => position.currentPrice },
            { header: "token0", value: (position) => position.symbol0 },
            { header: "amount0", value: (position) => position.amount0 },
            { header: "feesOwed0", value: (position) => position.feesOwed0 },
            { header: "token1", value: (position) => position.symbol1 },
            { header: "amount1", value: (position) => position.amount1 },
            { header: "feesOwed1", value: (position) => position.feesOwed1 },
            { header: "usdValue", value: (position) => position.usdValue },
            {
                header: "rewards",
                value: (position) => position.rewards
                    .map((reward) => reward.decimals === null
                    ? `${reward.symbol}:${reward.amountOwedRaw} raw units`
                    : `${reward.symbol}:${reward.amountOwed}`)
                    .join(";")
            }
        ]);
        const resolved = await (0, csv_1.writeExport)(csv, options.output, Boolean(options.force));
        if (resolved)
            process.stderr.write(`Wrote ${resolved}\n`);
        return;
    }
    if (positionsData.length === 0) {
        const suffix = poolFilter ? ` in pool ${poolFilter}` : "";
        (0, output_1.logInfo)(`No CLMM positions found for wallet ${owner.toBase58()}${suffix}`);
        return;
    }
    (0, output_1.logInfo)(`Wallet: ${owner.toBase58()}`);
    (0, output_1.logInfo)(`Positions: ${positionsData.length}`);
    (0, output_1.logInfo)("");
    for (const pos of positionsData) {
        const rangeStatus = pos.inRange ? "IN RANGE" : "OUT OF RANGE";
        (0, output_1.logInfo)(`Position: ${pos.nftMint}`);
        (0, output_1.logInfo)(`  Pool: ${pos.poolId}`);
        (0, output_1.logInfo)(`  Range: ${(0, clmm_utils_1.formatPrice)(new decimal_js_1.default(pos.priceLower))} - ${(0, clmm_utils_1.formatPrice)(new decimal_js_1.default(pos.priceUpper))} ${pos.symbol1}/${pos.symbol0}`);
        (0, output_1.logInfo)(`  Current: ${(0, clmm_utils_1.formatPrice)(new decimal_js_1.default(pos.currentPrice))} (${rangeStatus})`);
        (0, output_1.logInfo)(`  Ticks: [${pos.tickLower}, ${pos.tickUpper}] (current: ${pos.currentTick})`);
        (0, output_1.logInfo)(`  Liquidity: ${pos.liquidity}`);
        (0, output_1.logInfo)(`  ${pos.symbol0}: ${(0, clmm_utils_1.formatTokenAmount)(new decimal_js_1.default(pos.amount0))}`);
        (0, output_1.logInfo)(`  ${pos.symbol1}: ${(0, clmm_utils_1.formatTokenAmount)(new decimal_js_1.default(pos.amount1))}`);
        if (pos.usdValue !== undefined)
            (0, output_1.logInfo)(`  Value: ${(0, clmm_utils_1.formatUsd)(pos.usdValue)}`);
        if (pos.feesOwed0Raw !== "0" || pos.feesOwed1Raw !== "0") {
            (0, output_1.logInfo)(`  Fees owed: ${pos.feesOwed0} ${pos.symbol0}, ${pos.feesOwed1} ${pos.symbol1}`);
        }
        if (pos.rewards.length > 0) {
            (0, output_1.logInfo)(`  Rewards: ${pos.rewards.map((reward) => reward.decimals === null
                ? `${reward.amountOwedRaw} raw units ${reward.symbol}`
                : `${reward.amountOwed} ${reward.symbol}`).join(", ")}`);
        }
        (0, output_1.logInfo)("");
    }
}
async function handlePositionCommand(nftMintStr) {
    nftMintStr = await (0, prompt_1.promptIfMissing)(nftMintStr, "Position NFT mint address");
    let nftMint;
    try {
        nftMint = new web3_js_1.PublicKey(nftMintStr);
    }
    catch {
        (0, output_1.logError)("Invalid NFT mint address");
        process.exitCode = 1;
        return;
    }
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
    if (!walletName) {
        (0, output_1.logError)("No active wallet set. Required to fetch position info.");
        (0, output_1.logInfo)("Set an active wallet with: raydium wallet use <name>");
        process.exitCode = 1;
        return;
    }
    const owner = await (0, wallet_manager_1.getWalletPublicKey)(walletName);
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
    const isDevnet = raydium.cluster !== "mainnet";
    const clmmProgramId = isDevnet ? raydium_sdk_v2_1.DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : raydium_sdk_v2_1.CLMM_PROGRAM_ID;
    // Fetch all positions and find the one with matching NFT mint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let positions;
    try {
        positions = await (0, output_1.withSpinner)("Fetching positions", () => raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId }));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch positions", msg);
        process.exitCode = 1;
        return;
    }
    const position = positions.find((p) => p.nftMint?.toBase58() === nftMint.toBase58());
    if (!position) {
        (0, output_1.logError)(`Position not found for NFT mint: ${nftMint.toBase58()}`);
        (0, output_1.logInfo)("Make sure the NFT is owned by the active wallet");
        process.exitCode = 1;
        return;
    }
    // Fetch fresh pool data from RPC for accurate current tick
    const poolIdStr = position.poolId?.toBase58();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let freshPoolData = null;
    if (poolIdStr) {
        try {
            freshPoolData = await (0, output_1.withSpinner)("Fetching pool data", () => raydium.clmm.getPoolInfoFromRpc(poolIdStr));
        }
        catch {
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
    const inRange = (0, clmm_utils_1.isPositionInRange)(position.tickLower, position.tickUpper, currentTick);
    const amounts = (0, clmm_utils_1.getAmountsFromLiquidity)(position.liquidity?.toString() ?? "0", sqrtPriceX64, position.tickLower, position.tickUpper, decimalsA, decimalsB);
    const priceLower = (0, clmm_utils_1.tickToPrice)(position.tickLower, decimalsA, decimalsB);
    const priceUpper = (0, clmm_utils_1.tickToPrice)(position.tickUpper, decimalsA, decimalsB);
    const currentPrice = (0, clmm_utils_1.sqrtPriceX64ToPrice)(sqrtPriceX64, decimalsA, decimalsB);
    const symbolA = mintA?.symbol || mintA?.address?.slice(0, 6) || "token0";
    const symbolB = mintB?.symbol || mintB?.address?.slice(0, 6) || "token1";
    // Fetch optional USD prices
    const mintAddresses = [];
    if (mintA?.address)
        mintAddresses.push(mintA.address);
    if (mintB?.address)
        mintAddresses.push(mintB.address);
    const tokenPrices = await (0, output_1.withSpinner)("Fetching token prices", () => (0, token_price_1.getTokenPrices)(mintAddresses));
    const priceAUsd = mintA?.address ? (tokenPrices.get(mintA.address) ?? null) : null;
    const priceBUsd = mintB?.address ? (tokenPrices.get(mintB.address) ?? null) : null;
    const usdValue = (0, clmm_utils_1.calculateUsdValue)(amounts.amount0, amounts.amount1, priceAUsd, priceBUsd);
    const feesOwed0Raw = position.tokenFeesOwedA?.toString() ?? "0";
    const feesOwed1Raw = position.tokenFeesOwedB?.toString() ?? "0";
    const feesOwed0 = rawToUiAmount(feesOwed0Raw, decimalsA);
    const feesOwed1 = rawToUiAmount(feesOwed1Raw, decimalsB);
    const rewards = buildRewardReports(position, poolInfo);
    if ((0, output_1.isJsonOutput)()) {
        (0, output_1.logJson)({
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
            feesOwed0,
            feesOwed1,
            feesOwed0Raw,
            feesOwed1Raw,
            rewards
        });
        return;
    }
    (0, output_1.logInfo)(`Position: ${nftMint.toBase58()}`);
    (0, output_1.logInfo)(`Pool: ${position.poolId?.toBase58() ?? "unknown"}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Tokens:");
    (0, output_1.logInfo)(`  ${symbolA}: ${mintA?.address} (${decimalsA} decimals)`);
    if (priceAUsd !== null)
        (0, output_1.logInfo)(`    Price: ${(0, clmm_utils_1.formatUsd)(priceAUsd)}`);
    (0, output_1.logInfo)(`  ${symbolB}: ${mintB?.address} (${decimalsB} decimals)`);
    if (priceBUsd !== null)
        (0, output_1.logInfo)(`    Price: ${(0, clmm_utils_1.formatUsd)(priceBUsd)}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Range:");
    (0, output_1.logInfo)(`  Tick range: [${position.tickLower}, ${position.tickUpper}]`);
    (0, output_1.logInfo)(`  Price range: ${(0, clmm_utils_1.formatPrice)(priceLower)} - ${(0, clmm_utils_1.formatPrice)(priceUpper)} ${symbolB}/${symbolA}`);
    (0, output_1.logInfo)(`  Current tick: ${currentTick}`);
    (0, output_1.logInfo)(`  Current price: ${(0, clmm_utils_1.formatPrice)(currentPrice)} ${symbolB}/${symbolA}`);
    (0, output_1.logInfo)(`  Status: ${inRange ? "IN RANGE" : "OUT OF RANGE"}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Liquidity:");
    (0, output_1.logInfo)(`  Total: ${position.liquidity?.toString() ?? "0"}`);
    (0, output_1.logInfo)(`  ${symbolA}: ${(0, clmm_utils_1.formatTokenAmount)(amounts.amount0)}`);
    (0, output_1.logInfo)(`  ${symbolB}: ${(0, clmm_utils_1.formatTokenAmount)(amounts.amount1)}`);
    if (usdValue !== null)
        (0, output_1.logInfo)(`  Value: ${(0, clmm_utils_1.formatUsd)(usdValue)}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Fees Owed:");
    (0, output_1.logInfo)(`  ${symbolA}: ${feesOwed0}`);
    (0, output_1.logInfo)(`  ${symbolB}: ${feesOwed1}`);
    if (rewards.length > 0) {
        (0, output_1.logInfo)("");
        (0, output_1.logInfo)("Rewards:");
        for (const reward of rewards) {
            const amount = reward.decimals === null
                ? `${reward.amountOwedRaw} raw units`
                : reward.amountOwed;
            (0, output_1.logInfo)(`  ${reward.symbol}: ${amount}`);
        }
    }
}
// Helper function to get priority fee config
function getPriorityFeeConfig(priorityFeeSol) {
    if (priorityFeeSol <= 0)
        return undefined;
    const DEFAULT_COMPUTE_UNITS = 600000;
    const priorityFeeLamports = priorityFeeSol * 1e9;
    const priorityFeeMicroLamports = Math.round((priorityFeeLamports * 1e6) / DEFAULT_COMPUTE_UNITS);
    return { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports };
}
// Helper to find position by NFT mint
function findPositionByNftMint(positions, nftMint) {
    const nftMintStr = nftMint.toBase58();
    return positions.find((p) => p.nftMint?.toBase58() === nftMintStr);
}
// Helper to check if position has unclaimed fees
function hasUnclaimedFees(position) {
    const feesA = position.tokenFeesOwedA;
    const feesB = position.tokenFeesOwedB;
    const hasFeesA = feesA && !feesA.isZero();
    const hasFeesB = feesB && !feesB.isZero();
    return hasFeesA || hasFeesB;
}
async function handleCollectFeesCommand(options) {
    if (!options.nftMint && !options.all) {
        const selection = await (0, prompt_1.promptIfMissing)(undefined, "Position NFT mint address (or type all)");
        if (selection.trim().toLowerCase() === "all")
            options.all = true;
        else
            options.nftMint = selection;
    }
    if (options.nftMint && options.all) {
        (0, output_1.logError)("Choose either --nft-mint <address> or --all, not both");
        process.exitCode = 1;
        return;
    }
    if (!options.nftMint && !options.all) {
        (0, output_1.logError)("Must specify --nft-mint <address> or --all");
        process.exitCode = 1;
        return;
    }
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
    if (!walletName) {
        (0, output_1.logError)("No active wallet set");
        (0, output_1.logInfo)("Set an active wallet with: raydium wallet use <name>");
        process.exitCode = 1;
        return;
    }
    const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
    if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
        (0, output_1.logError)("Invalid priority fee");
        process.exitCode = 1;
        return;
    }
    let nftMint;
    if (options.nftMint) {
        try {
            nftMint = new web3_js_1.PublicKey(options.nftMint);
        }
        catch {
            (0, output_1.logError)("Invalid NFT mint address");
            process.exitCode = 1;
            return;
        }
    }
    const password = await (0, prompt_1.promptPassword)("Enter wallet password");
    let owner;
    try {
        owner = await (0, wallet_manager_1.decryptWallet)(walletName, password);
    }
    catch (error) {
        (0, output_1.logError)("Failed to decrypt wallet", error.message);
        process.exitCode = 1;
        return;
    }
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
    const isDevnet = raydium.cluster !== "mainnet";
    const clmmProgramId = isDevnet ? raydium_sdk_v2_1.DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : raydium_sdk_v2_1.CLMM_PROGRAM_ID;
    // Fetch all positions
    let positions;
    try {
        positions = await (0, output_1.withSpinner)("Fetching positions", () => raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId }));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch positions", msg);
        process.exitCode = 1;
        return;
    }
    if (!positions || positions.length === 0) {
        (0, output_1.logError)("No CLMM positions found");
        process.exitCode = 1;
        return;
    }
    // Filter positions
    let targetPositions;
    if (options.all) {
        targetPositions = positions.filter(hasUnclaimedFees);
        if (targetPositions.length === 0) {
            (0, output_1.logInfo)("No positions with unclaimed fees found");
            return;
        }
    }
    else {
        const position = findPositionByNftMint(positions, nftMint);
        if (!position) {
            (0, output_1.logError)(`Position not found for NFT mint: ${nftMint.toBase58()}`);
            process.exitCode = 1;
            return;
        }
        if (!hasUnclaimedFees(position)) {
            (0, output_1.logInfo)("No fees to collect for this position");
            return;
        }
        targetPositions = [position];
    }
    // Show preview
    (0, output_1.logInfo)(`Positions to collect fees from: ${targetPositions.length}`);
    (0, output_1.logInfo)("");
    for (const pos of targetPositions) {
        const mintA = pos.poolInfo?.mintA;
        const mintB = pos.poolInfo?.mintB;
        const symbolA = mintA?.symbol || mintA?.address?.slice(0, 6) || "token0";
        const symbolB = mintB?.symbol || mintB?.address?.slice(0, 6) || "token1";
        (0, output_1.logInfo)(`Position: ${pos.nftMint.toBase58()}`);
        (0, output_1.logInfo)(`  Fees owed: ${pos.tokenFeesOwedA?.toString() ?? "0"} ${symbolA}, ${pos.tokenFeesOwedB?.toString() ?? "0"} ${symbolB}`);
    }
    (0, output_1.logInfo)("");
    const ok = await (0, prompt_1.promptConfirm)("Proceed with collecting fees?", false);
    if (!ok) {
        (0, output_1.logInfo)("Cancelled");
        return;
    }
    const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);
    const results = [];
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
            const txData = await (0, output_1.withSpinner)(`Building transaction for ${pos.nftMint.toBase58().slice(0, 8)}...`, () => raydium.clmm.decreaseLiquidity({
                poolInfo: poolData.poolInfo,
                ownerPosition: pos,
                ownerInfo: {
                    useSOLBalance: true,
                    closePosition: false
                },
                liquidity: new bn_js_1.default(0), // 0 liquidity = collect fees only
                amountMinA: new bn_js_1.default(0),
                amountMinB: new bn_js_1.default(0),
                txVersion: raydium_sdk_v2_1.TxVersion.V0,
                computeBudgetConfig
            }));
            const result = await (0, output_1.withSpinner)(`Sending transaction for ${pos.nftMint.toBase58().slice(0, 8)}...`, () => txData.execute({ sendAndConfirm: true }));
            results.push({ nftMint: pos.nftMint.toBase58(), txId: result.txId });
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            results.push({ nftMint: pos.nftMint.toBase58(), error: msg });
        }
    }
    // Output results
    if ((0, output_1.isJsonOutput)()) {
        (0, output_1.logJson)({ results });
    }
    else {
        (0, output_1.logInfo)("");
        for (const r of results) {
            if (r.txId) {
                (0, output_1.logSuccess)(`${r.nftMint}: ${r.txId}`);
            }
            else {
                (0, output_1.logError)(`${r.nftMint}: ${r.error}`);
            }
        }
    }
}
async function handleClosePositionCommand(options) {
    options.nftMint = await (0, prompt_1.promptIfMissing)(options.nftMint, "Position NFT mint address");
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
    if (!walletName) {
        (0, output_1.logError)("No active wallet set");
        (0, output_1.logInfo)("Set an active wallet with: raydium wallet use <name>");
        process.exitCode = 1;
        return;
    }
    let nftMint;
    try {
        nftMint = new web3_js_1.PublicKey(options.nftMint);
    }
    catch {
        (0, output_1.logError)("Invalid NFT mint address");
        process.exitCode = 1;
        return;
    }
    const slippagePercent = options.slippage ? Number(options.slippage) : config["default-slippage"];
    if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
        (0, output_1.logError)("Invalid slippage percent");
        process.exitCode = 1;
        return;
    }
    if (options.slippage && !options.force) {
        (0, output_1.logError)("--slippage is only used with --force because closing an empty position does not remove liquidity");
        process.exitCode = 1;
        return;
    }
    const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
    if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
        (0, output_1.logError)("Invalid priority fee");
        process.exitCode = 1;
        return;
    }
    const password = await (0, prompt_1.promptPassword)("Enter wallet password");
    let owner;
    try {
        owner = await (0, wallet_manager_1.decryptWallet)(walletName, password);
    }
    catch (error) {
        (0, output_1.logError)("Failed to decrypt wallet", error.message);
        process.exitCode = 1;
        return;
    }
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
    const isDevnet = raydium.cluster !== "mainnet";
    const clmmProgramId = isDevnet ? raydium_sdk_v2_1.DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : raydium_sdk_v2_1.CLMM_PROGRAM_ID;
    // Fetch positions
    let positions;
    try {
        positions = await (0, output_1.withSpinner)("Fetching positions", () => raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId }));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch positions", msg);
        process.exitCode = 1;
        return;
    }
    const position = findPositionByNftMint(positions, nftMint);
    if (!position) {
        (0, output_1.logError)(`Position not found for NFT mint: ${nftMint.toBase58()}`);
        process.exitCode = 1;
        return;
    }
    const hasLiquidity = position.liquidity && !position.liquidity.isZero();
    if (hasLiquidity && !options.force) {
        (0, output_1.logError)("Position still has liquidity. Use --force to remove liquidity and close.");
        (0, output_1.logInfo)(`Current liquidity: ${position.liquidity.toString()}`);
        process.exitCode = 1;
        return;
    }
    // Fetch pool info
    const poolData = await (0, output_1.withSpinner)("Fetching pool info", () => raydium.clmm.getPoolInfoFromRpc(position.poolId.toBase58()));
    if (!poolData.poolInfo) {
        (0, output_1.logError)("Pool not found");
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
    (0, output_1.logInfo)(`Position: ${nftMint.toBase58()}`);
    (0, output_1.logInfo)(`Pool: ${position.poolId.toBase58()}`);
    if (hasLiquidity) {
        const decimalsA = mintA.decimals;
        const decimalsB = mintB.decimals;
        const amounts = (0, clmm_utils_1.getAmountsFromLiquidity)(position.liquidity.toString(), computePoolInfo.sqrtPriceX64.toString(), position.tickLower, position.tickUpper, decimalsA, decimalsB);
        (0, output_1.logInfo)(`Liquidity to remove: ${position.liquidity.toString()}`);
        (0, output_1.logInfo)(`Expected ${symbolA}: ${(0, clmm_utils_1.formatTokenAmount)(amounts.amount0)}`);
        (0, output_1.logInfo)(`Expected ${symbolB}: ${(0, clmm_utils_1.formatTokenAmount)(amounts.amount1)}`);
        (0, output_1.logInfo)(`Slippage: ${slippagePercent}%`);
    }
    if (hasUnclaimedFees(position)) {
        (0, output_1.logInfo)(`Fees to collect: ${position.tokenFeesOwedA?.toString() ?? "0"} ${symbolA}, ${position.tokenFeesOwedB?.toString() ?? "0"} ${symbolB}`);
    }
    (0, output_1.logInfo)("");
    const ok = await (0, prompt_1.promptConfirm)("Proceed with closing position?", false);
    if (!ok) {
        (0, output_1.logInfo)("Cancelled");
        return;
    }
    const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);
    try {
        let result;
        if (hasLiquidity) {
            // Calculate minimum amounts with slippage
            const decimalsA = mintA.decimals;
            const decimalsB = mintB.decimals;
            const amounts = (0, clmm_utils_1.getAmountsFromLiquidity)(position.liquidity.toString(), computePoolInfo.sqrtPriceX64.toString(), position.tickLower, position.tickUpper, decimalsA, decimalsB);
            const amountARaw = amounts.amount0.mul(new decimal_js_1.default(10).pow(decimalsA));
            const amountBRaw = amounts.amount1.mul(new decimal_js_1.default(10).pow(decimalsB));
            const amountMinA = (0, clmm_utils_1.applySlippage)(new bn_js_1.default(amountARaw.floor().toString()), slippagePercent, true);
            const amountMinB = (0, clmm_utils_1.applySlippage)(new bn_js_1.default(amountBRaw.floor().toString()), slippagePercent, true);
            // Decrease liquidity with closePosition flag
            const txData = await (0, output_1.withSpinner)("Building transaction", () => raydium.clmm.decreaseLiquidity({
                poolInfo,
                ownerPosition: position,
                ownerInfo: {
                    useSOLBalance: true,
                    closePosition: true
                },
                liquidity: position.liquidity,
                amountMinA,
                amountMinB,
                txVersion: raydium_sdk_v2_1.TxVersion.V0,
                computeBudgetConfig
            }));
            result = await (0, output_1.withSpinner)("Sending transaction", () => txData.execute({ sendAndConfirm: true }));
        }
        else {
            // Just close the empty position
            const txData = await (0, output_1.withSpinner)("Building transaction", () => raydium.clmm.closePosition({
                poolInfo,
                ownerPosition: position,
                txVersion: raydium_sdk_v2_1.TxVersion.V0,
                computeBudgetConfig
            }));
            result = await (0, output_1.withSpinner)("Sending transaction", () => txData.execute({ sendAndConfirm: true }));
        }
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ txId: result.txId });
        }
        else {
            (0, output_1.logSuccess)(`Position closed: ${result.txId}`);
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to close position", msg);
        process.exitCode = 1;
    }
}
async function handleDecreaseLiquidityCommand(options) {
    options.nftMint = await (0, prompt_1.promptIfMissing)(options.nftMint, "Position NFT mint address");
    options.percent = await (0, prompt_1.promptNumberIfMissing)(options.percent, "Percentage of liquidity to remove (1-100)", (input) => {
        const value = Number(input);
        return Number.isFinite(value) && value >= 1 && value <= 100
            ? true
            : "Enter a percentage from 1 to 100";
    });
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
    if (!walletName) {
        (0, output_1.logError)("No active wallet set");
        (0, output_1.logInfo)("Set an active wallet with: raydium wallet use <name>");
        process.exitCode = 1;
        return;
    }
    let nftMint;
    try {
        nftMint = new web3_js_1.PublicKey(options.nftMint);
    }
    catch {
        (0, output_1.logError)("Invalid NFT mint address");
        process.exitCode = 1;
        return;
    }
    const percent = Number(options.percent);
    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
        (0, output_1.logError)("Percent must be between 1 and 100");
        process.exitCode = 1;
        return;
    }
    const slippagePercent = options.slippage ? Number(options.slippage) : config["default-slippage"];
    if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
        (0, output_1.logError)("Invalid slippage percent");
        process.exitCode = 1;
        return;
    }
    const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
    if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
        (0, output_1.logError)("Invalid priority fee");
        process.exitCode = 1;
        return;
    }
    const password = await (0, prompt_1.promptPassword)("Enter wallet password");
    let owner;
    try {
        owner = await (0, wallet_manager_1.decryptWallet)(walletName, password);
    }
    catch (error) {
        (0, output_1.logError)("Failed to decrypt wallet", error.message);
        process.exitCode = 1;
        return;
    }
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
    const isDevnet = raydium.cluster !== "mainnet";
    const clmmProgramId = isDevnet ? raydium_sdk_v2_1.DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : raydium_sdk_v2_1.CLMM_PROGRAM_ID;
    // Fetch positions
    let positions;
    try {
        positions = await (0, output_1.withSpinner)("Fetching positions", () => raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId }));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch positions", msg);
        process.exitCode = 1;
        return;
    }
    const position = findPositionByNftMint(positions, nftMint);
    if (!position) {
        (0, output_1.logError)(`Position not found for NFT mint: ${nftMint.toBase58()}`);
        process.exitCode = 1;
        return;
    }
    if (!position.liquidity || position.liquidity.isZero()) {
        (0, output_1.logError)("Position has no liquidity to remove");
        process.exitCode = 1;
        return;
    }
    // Fetch pool info
    const poolData = await (0, output_1.withSpinner)("Fetching pool info", () => raydium.clmm.getPoolInfoFromRpc(position.poolId.toBase58()));
    if (!poolData.poolInfo) {
        (0, output_1.logError)("Pool not found");
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
    const liquidityToRemove = position.liquidity.mul(new bn_js_1.default(percent)).div(new bn_js_1.default(100));
    // Calculate expected amounts
    const amounts = (0, clmm_utils_1.getAmountsFromLiquidity)(liquidityToRemove.toString(), computePoolInfo.sqrtPriceX64.toString(), position.tickLower, position.tickUpper, decimalsA, decimalsB);
    // Show preview
    (0, output_1.logInfo)(`Position: ${nftMint.toBase58()}`);
    (0, output_1.logInfo)(`Pool: ${position.poolId.toBase58()}`);
    (0, output_1.logInfo)(`Removing: ${percent}% of liquidity`);
    (0, output_1.logInfo)(`Current liquidity: ${position.liquidity.toString()}`);
    (0, output_1.logInfo)(`Liquidity to remove: ${liquidityToRemove.toString()}`);
    (0, output_1.logInfo)(`Expected ${symbolA}: ${(0, clmm_utils_1.formatTokenAmount)(amounts.amount0)}`);
    (0, output_1.logInfo)(`Expected ${symbolB}: ${(0, clmm_utils_1.formatTokenAmount)(amounts.amount1)}`);
    (0, output_1.logInfo)(`Slippage: ${slippagePercent}%`);
    (0, output_1.logInfo)("");
    const ok = await (0, prompt_1.promptConfirm)("Proceed with removing liquidity?", false);
    if (!ok) {
        (0, output_1.logInfo)("Cancelled");
        return;
    }
    const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);
    try {
        // Calculate minimum amounts with slippage
        const amountARaw = amounts.amount0.mul(new decimal_js_1.default(10).pow(decimalsA));
        const amountBRaw = amounts.amount1.mul(new decimal_js_1.default(10).pow(decimalsB));
        const amountMinA = (0, clmm_utils_1.applySlippage)(new bn_js_1.default(amountARaw.floor().toString()), slippagePercent, true);
        const amountMinB = (0, clmm_utils_1.applySlippage)(new bn_js_1.default(amountBRaw.floor().toString()), slippagePercent, true);
        const txData = await (0, output_1.withSpinner)("Building transaction", () => raydium.clmm.decreaseLiquidity({
            poolInfo,
            ownerPosition: position,
            ownerInfo: {
                useSOLBalance: true,
                closePosition: false
            },
            liquidity: liquidityToRemove,
            amountMinA,
            amountMinB,
            txVersion: raydium_sdk_v2_1.TxVersion.V0,
            computeBudgetConfig
        }));
        const result = await (0, output_1.withSpinner)("Sending transaction", () => txData.execute({ sendAndConfirm: true }));
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ txId: result.txId, liquidityRemoved: liquidityToRemove.toString() });
        }
        else {
            (0, output_1.logSuccess)(`Liquidity removed: ${result.txId}`);
        }
        // Swap to SOL if requested
        if (options.swapToSol) {
            (0, output_1.logInfo)("");
            (0, output_1.logInfo)("Swapping withdrawn tokens to SOL...");
            // Brief pause to let the withdrawal settle
            await new Promise((r) => setTimeout(r, 2000));
            const swapSlippage = slippagePercent / 100;
            const tokensToSwap = [];
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
                    const swapPoolData = await (0, output_1.withSpinner)(`Finding ${tokenToSwap.symbol}/SOL swap pool`, async () => {
                        const poolsResult = await raydium.api.fetchPoolByMints({
                            mint1: tokenToSwap.mint.address,
                            mint2: WRAPPED_SOL_MINT
                        });
                        const pools = poolsResult.data || [];
                        const ammPool = pools.find((p) => p.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
                        if (ammPool) {
                            return raydium.liquidity.getPoolInfoFromRpc({ poolId: ammPool.id });
                        }
                        return null;
                    });
                    if (!swapPoolData || !swapPoolData.poolInfo) {
                        (0, output_1.logError)(`No swap pool found for ${tokenToSwap.symbol}/SOL, skipping swap`);
                        continue;
                    }
                    const swapPoolInfo = swapPoolData.poolInfo;
                    const swapPoolKeys = swapPoolData.poolKeys;
                    const swapRpcData = swapPoolData.poolRpcData;
                    // Get actual balance (might differ from expected due to fees/slippage)
                    const actualBalance = await getTokenBalance(raydium.connection, owner.publicKey, tokenToSwap.mint.address);
                    const actualBalanceDecimal = new decimal_js_1.default(actualBalance.toString()).div(new decimal_js_1.default(10).pow(tokenToSwap.decimals));
                    if (actualBalanceDecimal.lte(0)) {
                        (0, output_1.logInfo)(`No ${tokenToSwap.symbol} balance to swap`);
                        continue;
                    }
                    // Calculate expected SOL output
                    const poolMintA = swapPoolInfo.mintA;
                    const poolMintB = swapPoolInfo.mintB;
                    const poolDecimalsA = poolMintA.decimals;
                    const poolDecimalsB = poolMintB.decimals;
                    const reserveA = new decimal_js_1.default(swapRpcData.baseReserve.toString()).div(new decimal_js_1.default(10).pow(poolDecimalsA));
                    const reserveB = new decimal_js_1.default(swapRpcData.quoteReserve.toString()).div(new decimal_js_1.default(10).pow(poolDecimalsB));
                    const tokenIsPoolMintA = poolMintA.address === tokenToSwap.mint.address;
                    const priceOfTokenInSol = tokenIsPoolMintA
                        ? reserveB.div(reserveA)
                        : reserveA.div(reserveB);
                    const estimatedSolOut = actualBalanceDecimal.mul(priceOfTokenInSol);
                    (0, output_1.logInfo)(`Swapping ~${(0, clmm_utils_1.formatTokenAmount)(actualBalanceDecimal)} ${tokenToSwap.symbol} for ~${(0, clmm_utils_1.formatTokenAmount)(estimatedSolOut)} SOL`);
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
                    const swapTxData = await (0, output_1.withSpinner)(`Building ${tokenToSwap.symbol} swap`, () => raydium.liquidity.swap({
                        txVersion: raydium_sdk_v2_1.TxVersion.V0,
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
                    }));
                    const swapResult = await (0, output_1.withSpinner)(`Executing ${tokenToSwap.symbol} swap`, () => swapTxData.execute({ sendAndConfirm: true }));
                    (0, output_1.logSuccess)(`${tokenToSwap.symbol} swapped to SOL: ${swapResult.txId}`);
                    // Brief pause between swaps
                    await new Promise((r) => setTimeout(r, 1000));
                }
                catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    (0, output_1.logError)(`Failed to swap ${tokenToSwap.symbol} to SOL`, msg);
                    // Continue with other swaps
                }
            }
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logErrorWithDebug)("Failed to remove liquidity", error, {
            fallback: msg || "(no message)"
        });
        process.exitCode = 1;
    }
}
async function handleIncreaseLiquidityCommand(options) {
    options.nftMint = await (0, prompt_1.promptIfMissing)(options.nftMint, "Position NFT mint address");
    options.amount = await (0, prompt_1.promptNumberIfMissing)(options.amount, "Amount to add", (input) => {
        try {
            return parsePositiveDecimalInput(input, "Amount").gt(0) ? true : "Enter a positive amount";
        }
        catch {
            return "Enter a positive amount";
        }
    });
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
    if (!walletName) {
        (0, output_1.logError)("No active wallet set");
        (0, output_1.logInfo)("Set an active wallet with: raydium wallet use <name>");
        process.exitCode = 1;
        return;
    }
    let nftMint;
    try {
        nftMint = new web3_js_1.PublicKey(options.nftMint);
    }
    catch {
        (0, output_1.logError)("Invalid NFT mint address");
        process.exitCode = 1;
        return;
    }
    let amount;
    try {
        amount = parsePositiveDecimalInput(options.amount, "Amount");
    }
    catch (error) {
        (0, output_1.logError)(error.message);
        process.exitCode = 1;
        return;
    }
    const baseToken = (options.token?.toUpperCase() ?? "A");
    if (baseToken !== "A" && baseToken !== "B") {
        (0, output_1.logError)("Token must be A or B");
        process.exitCode = 1;
        return;
    }
    const slippagePercent = options.slippage ? Number(options.slippage) : config["default-slippage"];
    if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
        (0, output_1.logError)("Invalid slippage percent");
        process.exitCode = 1;
        return;
    }
    const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
    if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
        (0, output_1.logError)("Invalid priority fee");
        process.exitCode = 1;
        return;
    }
    const password = await (0, prompt_1.promptPassword)("Enter wallet password");
    let owner;
    try {
        owner = await (0, wallet_manager_1.decryptWallet)(walletName, password);
    }
    catch (error) {
        (0, output_1.logError)("Failed to decrypt wallet", error.message);
        process.exitCode = 1;
        return;
    }
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
    const isDevnet = raydium.cluster !== "mainnet";
    const clmmProgramId = isDevnet ? raydium_sdk_v2_1.DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : raydium_sdk_v2_1.CLMM_PROGRAM_ID;
    // Fetch positions
    let positions;
    try {
        positions = await (0, output_1.withSpinner)("Fetching positions", () => raydium.clmm.getOwnerPositionInfo({ programId: clmmProgramId }));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch positions", msg);
        process.exitCode = 1;
        return;
    }
    const position = findPositionByNftMint(positions, nftMint);
    if (!position) {
        (0, output_1.logError)(`Position not found for NFT mint: ${nftMint.toBase58()}`);
        process.exitCode = 1;
        return;
    }
    // Fetch pool info
    const poolData = await (0, output_1.withSpinner)("Fetching pool info", () => raydium.clmm.getPoolInfoFromRpc(position.poolId.toBase58()));
    if (!poolData.poolInfo) {
        (0, output_1.logError)("Pool not found");
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
    const inRange = (0, clmm_utils_1.isPositionInRange)(position.tickLower, position.tickUpper, computePoolInfo.tickCurrent);
    // Calculate base amount in raw units
    const baseDecimals = baseToken === "A" ? decimalsA : decimalsB;
    const baseAmount = new bn_js_1.default(amount.mul(new decimal_js_1.default(10).pow(baseDecimals)).floor().toString());
    // Use SDK to calculate liquidity and other amount
    const epochInfo = await raydium.connection.getEpochInfo();
    const liquidityInfo = await (0, output_1.withSpinner)("Calculating liquidity", () => raydium_sdk_v2_1.PoolUtils.getLiquidityAmountOutFromAmountIn({
        poolInfo,
        inputA: baseToken === "A",
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        amount: baseAmount,
        slippage: slippagePercent / 100,
        add: true,
        epochInfo,
        amountHasFee: false
    }));
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
        const otherAmountRequired = new decimal_js_1.default(otherSlippageAmount.amount.toString()).div(new decimal_js_1.default(10).pow(otherDecimals));
        // Check balances
        const balances = await (0, output_1.withSpinner)("Checking token balances", async () => {
            const baseBalance = await getTokenBalance(raydium.connection, owner.publicKey, baseMint.address);
            const otherBalance = await getTokenBalance(raydium.connection, owner.publicKey, otherMint.address);
            return {
                baseBalance: new decimal_js_1.default(baseBalance.toString()).div(new decimal_js_1.default(10).pow(baseDecimals)),
                otherBalance: new decimal_js_1.default(otherBalance.toString()).div(new decimal_js_1.default(10).pow(otherDecimals))
            };
        });
        (0, output_1.logInfo)(`Your balances:`);
        (0, output_1.logInfo)(`  ${baseSymbol}: ${(0, clmm_utils_1.formatTokenAmount)(balances.baseBalance)}`);
        (0, output_1.logInfo)(`  ${otherSymbol}: ${(0, clmm_utils_1.formatTokenAmount)(balances.otherBalance)}`);
        (0, output_1.logInfo)("");
        const otherShortfall = otherAmountRequired.sub(balances.otherBalance);
        if (otherShortfall.gt(0)) {
            (0, output_1.logInfo)(`Shortfall: ${(0, clmm_utils_1.formatTokenAmount)(otherShortfall)} ${otherSymbol}`);
            // Find a swap pool
            const swapPoolData = await (0, output_1.withSpinner)("Finding swap pool", async () => {
                const poolsResult = await raydium.api.fetchPoolByMints({
                    mint1: baseMint.address,
                    mint2: otherMint.address
                });
                const pools = poolsResult.data || [];
                const ammPool = pools.find((p) => p.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
                if (ammPool) {
                    return raydium.liquidity.getPoolInfoFromRpc({ poolId: ammPool.id });
                }
                return null;
            });
            if (!swapPoolData || !swapPoolData.poolInfo) {
                (0, output_1.logError)(`No swap pool found for ${baseSymbol}/${otherSymbol}`);
                (0, output_1.logInfo)("You can manually swap tokens first, then retry without --auto-swap");
                process.exitCode = 1;
                return;
            }
            const swapPoolInfo = swapPoolData.poolInfo;
            const swapPoolKeys = swapPoolData.poolKeys;
            const swapRpcData = swapPoolData.poolRpcData;
            (0, output_1.logInfo)(`Using swap pool: ${swapPoolInfo.id}`);
            const swapSlippage = slippagePercent / 100;
            const swapAmountNeeded = otherShortfall.mul(1 + swapSlippage);
            const poolMintA = swapPoolInfo.mintA;
            const poolMintB = swapPoolInfo.mintB;
            const poolDecimalsA = poolMintA.decimals;
            const poolDecimalsB = poolMintB.decimals;
            const reserveA = new decimal_js_1.default(swapRpcData.baseReserve.toString()).div(new decimal_js_1.default(10).pow(poolDecimalsA));
            const reserveB = new decimal_js_1.default(swapRpcData.quoteReserve.toString()).div(new decimal_js_1.default(10).pow(poolDecimalsB));
            const baseMintIsPoolMintA = poolMintA.address === baseMint.address;
            const priceOfBaseInOther = baseMintIsPoolMintA
                ? reserveB.div(reserveA)
                : reserveA.div(reserveB);
            const estimatedSwapIn = swapAmountNeeded.div(priceOfBaseInOther).mul(1.05);
            (0, output_1.logInfo)(`Swapping ~${(0, clmm_utils_1.formatTokenAmount)(estimatedSwapIn)} ${baseSymbol} for ~${(0, clmm_utils_1.formatTokenAmount)(swapAmountNeeded)} ${otherSymbol}`);
            (0, output_1.logInfo)("");
            const swapOk = await (0, prompt_1.promptConfirm)("Proceed with swap first?", false);
            if (!swapOk) {
                (0, output_1.logInfo)("Cancelled");
                return;
            }
            try {
                const swapAmountRaw = new bn_js_1.default(estimatedSwapIn.mul(new decimal_js_1.default(10).pow(baseDecimals)).floor().toString());
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
                const swapTxData = await (0, output_1.withSpinner)("Building swap transaction", () => raydium.liquidity.swap({
                    txVersion: raydium_sdk_v2_1.TxVersion.V0,
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
                }));
                const swapResult = await (0, output_1.withSpinner)("Executing swap", () => swapTxData.execute({ sendAndConfirm: true }));
                (0, output_1.logSuccess)(`Swap completed: ${swapResult.txId}`);
                (0, output_1.logInfo)("");
                await new Promise((r) => setTimeout(r, 2000));
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                (0, output_1.logError)("Swap failed", msg);
                process.exitCode = 1;
                return;
            }
        }
    }
    // Show preview
    (0, output_1.logInfo)(`Position: ${nftMint.toBase58()}`);
    (0, output_1.logInfo)(`Pool: ${position.poolId.toBase58()}`);
    (0, output_1.logInfo)(`Status: ${inRange ? "IN RANGE" : "OUT OF RANGE"}`);
    (0, output_1.logInfo)(`Current liquidity: ${position.liquidity.toString()}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)(`Adding:`);
    (0, output_1.logInfo)(`  ${baseSymbol}: ${amount}`);
    (0, output_1.logInfo)(`  ${otherSymbol}: ${(0, clmm_utils_1.formatTokenAmount)(new decimal_js_1.default(otherAmount.amount.toString()).div(new decimal_js_1.default(10).pow(otherDecimals)))}`);
    (0, output_1.logInfo)(`  Max ${otherSymbol} (with slippage): ${(0, clmm_utils_1.formatTokenAmount)(new decimal_js_1.default(otherSlippageAmount.amount.toString()).div(new decimal_js_1.default(10).pow(otherDecimals)))}`);
    (0, output_1.logInfo)(`Slippage: ${slippagePercent}%`);
    (0, output_1.logInfo)("");
    const ok = await (0, prompt_1.promptConfirm)("Proceed with adding liquidity?", false);
    if (!ok) {
        (0, output_1.logInfo)("Cancelled");
        return;
    }
    try {
        // The SDK types expect ClmmPoolPersonalPosition but only uses tickLower, tickUpper, nftMint
        // which all exist on ClmmPositionLayout, so we can safely cast
        const txData = await (0, output_1.withSpinner)("Building transaction", () => raydium.clmm.increasePositionFromBase({
            poolInfo,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ownerPosition: position,
            ownerInfo: {
                useSOLBalance: true
            },
            base: baseToken === "A" ? "MintA" : "MintB",
            baseAmount,
            otherAmountMax: otherSlippageAmount.amount,
            txVersion: raydium_sdk_v2_1.TxVersion.V0,
            computeBudgetConfig
        }));
        const result = await (0, output_1.withSpinner)("Sending transaction", () => txData.execute({ sendAndConfirm: true }));
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ txId: result.txId });
        }
        else {
            (0, output_1.logSuccess)(`Liquidity added: ${result.txId}`);
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to add liquidity", msg);
        process.exitCode = 1;
    }
}
async function handleOpenPositionCommand(options) {
    options.poolId = await (0, prompt_1.promptIfMissing)(options.poolId, "Pool address");
    options.priceLower = await (0, prompt_1.promptNumberIfMissing)(options.priceLower, "Lower price", (input) => {
        try {
            return parsePositiveDecimalInput(input, "Lower price").gt(0) ? true : "Enter a positive price";
        }
        catch {
            return "Enter a positive price";
        }
    });
    options.priceUpper = await (0, prompt_1.promptNumberIfMissing)(options.priceUpper, "Upper price", (input) => {
        try {
            return parsePositiveDecimalInput(input, "Upper price").gt(0) ? true : "Enter a positive price";
        }
        catch {
            return "Enter a positive price";
        }
    });
    options.amount = await (0, prompt_1.promptNumberIfMissing)(options.amount, "Deposit amount", (input) => {
        try {
            return parsePositiveDecimalInput(input, "Amount").gt(0) ? true : "Enter a positive amount";
        }
        catch {
            return "Enter a positive amount";
        }
    });
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
    if (!walletName) {
        (0, output_1.logError)("No active wallet set");
        (0, output_1.logInfo)("Set an active wallet with: raydium wallet use <name>");
        process.exitCode = 1;
        return;
    }
    let poolId;
    try {
        poolId = new web3_js_1.PublicKey(options.poolId);
    }
    catch {
        (0, output_1.logError)("Invalid pool ID");
        process.exitCode = 1;
        return;
    }
    let priceLower;
    let priceUpper;
    try {
        priceLower = parsePositiveDecimalInput(options.priceLower, "Lower price");
        priceUpper = parsePositiveDecimalInput(options.priceUpper, "Upper price");
    }
    catch (error) {
        (0, output_1.logError)(error.message);
        process.exitCode = 1;
        return;
    }
    if (priceLower.gte(priceUpper)) {
        (0, output_1.logError)("Lower price must be less than upper price");
        process.exitCode = 1;
        return;
    }
    let amount;
    try {
        amount = parsePositiveDecimalInput(options.amount, "Amount");
    }
    catch (error) {
        (0, output_1.logError)(error.message);
        process.exitCode = 1;
        return;
    }
    const baseToken = (options.token?.toUpperCase() ?? "A");
    if (baseToken !== "A" && baseToken !== "B") {
        (0, output_1.logError)("Token must be A or B");
        process.exitCode = 1;
        return;
    }
    const slippagePercent = options.slippage ? Number(options.slippage) : config["default-slippage"];
    if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
        (0, output_1.logError)("Invalid slippage percent");
        process.exitCode = 1;
        return;
    }
    const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
    if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
        (0, output_1.logError)("Invalid priority fee");
        process.exitCode = 1;
        return;
    }
    const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);
    const password = await (0, prompt_1.promptPassword)("Enter wallet password");
    let owner;
    try {
        owner = await (0, wallet_manager_1.decryptWallet)(walletName, password);
    }
    catch (error) {
        (0, output_1.logError)("Failed to decrypt wallet", error.message);
        process.exitCode = 1;
        return;
    }
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
    // Fetch pool info
    const poolData = await (0, output_1.withSpinner)("Fetching pool info", () => raydium.clmm.getPoolInfoFromRpc(poolId.toBase58()));
    if (!poolData.poolInfo) {
        (0, output_1.logError)("Pool not found");
        process.exitCode = 1;
        return;
    }
    if (!VALID_CLMM_PROGRAM_IDS.has(poolData.poolInfo.programId)) {
        (0, output_1.logError)("Not a CLMM pool");
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
    const tickLower = (0, clmm_utils_1.priceToAlignedTick)(priceLower, tickSpacing, decimalsA, decimalsB);
    const tickUpper = (0, clmm_utils_1.priceToAlignedTick)(priceUpper, tickSpacing, decimalsA, decimalsB);
    // Calculate actual prices from aligned ticks
    const actualPriceLower = (0, clmm_utils_1.tickToPrice)(tickLower, decimalsA, decimalsB);
    const actualPriceUpper = (0, clmm_utils_1.tickToPrice)(tickUpper, decimalsA, decimalsB);
    const currentPrice = (0, clmm_utils_1.sqrtPriceX64ToPrice)(computePoolInfo.sqrtPriceX64.toString(), decimalsA, decimalsB);
    const inRange = computePoolInfo.tickCurrent >= tickLower && computePoolInfo.tickCurrent < tickUpper;
    // Calculate base amount in raw units
    const baseDecimals = baseToken === "A" ? decimalsA : decimalsB;
    const baseAmount = new bn_js_1.default(amount.mul(new decimal_js_1.default(10).pow(baseDecimals)).floor().toString());
    // Use SDK to calculate liquidity and other amount
    const epochInfo = await raydium.connection.getEpochInfo();
    const liquidityInfo = await (0, output_1.withSpinner)("Calculating liquidity", () => raydium_sdk_v2_1.PoolUtils.getLiquidityAmountOutFromAmountIn({
        poolInfo,
        inputA: baseToken === "A",
        tickLower,
        tickUpper,
        amount: baseAmount,
        slippage: slippagePercent / 100,
        add: true,
        epochInfo,
        amountHasFee: false
    }));
    const otherAmount = baseToken === "A" ? liquidityInfo.amountB : liquidityInfo.amountA;
    const otherSlippageAmount = baseToken === "A" ? liquidityInfo.amountSlippageB : liquidityInfo.amountSlippageA;
    const otherDecimals = baseToken === "A" ? decimalsB : decimalsA;
    const otherSymbol = baseToken === "A" ? symbolB : symbolA;
    const baseSymbol = baseToken === "A" ? symbolA : symbolB;
    const otherMint = baseToken === "A" ? mintB : mintA;
    const baseMint = baseToken === "A" ? mintA : mintB;
    // Calculate required amounts in human-readable format
    const otherAmountRequired = new decimal_js_1.default(otherSlippageAmount.amount.toString()).div(new decimal_js_1.default(10).pow(otherDecimals));
    const baseAmountRequired = amount;
    // Check balances if auto-swap is enabled
    if (options.autoSwap) {
        const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
        // Get user's token balances
        const balances = await (0, output_1.withSpinner)("Checking token balances", async () => {
            const solBalance = await raydium.connection.getBalance(owner.publicKey);
            const solBalanceDecimal = new decimal_js_1.default(solBalance).div(1e9);
            // Check for the "other" token balance
            let otherBalance = new decimal_js_1.default(0);
            if (otherMint.address === WRAPPED_SOL_MINT) {
                otherBalance = solBalanceDecimal;
            }
            else {
                try {
                    const tokenAccounts = await raydium.connection.getTokenAccountsByOwner(owner.publicKey, {
                        mint: new web3_js_1.PublicKey(otherMint.address)
                    });
                    if (tokenAccounts.value.length > 0) {
                        // Parse token account data to get balance
                        const accountData = tokenAccounts.value[0].account.data;
                        // Token account: first 32 bytes mint, next 32 bytes owner, next 8 bytes amount
                        const amountBytes = accountData.slice(64, 72);
                        const rawAmount = new bn_js_1.default(amountBytes, "le");
                        otherBalance = new decimal_js_1.default(rawAmount.toString()).div(new decimal_js_1.default(10).pow(otherDecimals));
                    }
                }
                catch {
                    // No token account found
                }
            }
            // Check base token balance
            let baseBalance = new decimal_js_1.default(0);
            if (baseMint.address === WRAPPED_SOL_MINT) {
                baseBalance = solBalanceDecimal;
            }
            else {
                try {
                    const tokenAccounts = await raydium.connection.getTokenAccountsByOwner(owner.publicKey, {
                        mint: new web3_js_1.PublicKey(baseMint.address)
                    });
                    if (tokenAccounts.value.length > 0) {
                        const accountData = tokenAccounts.value[0].account.data;
                        const amountBytes = accountData.slice(64, 72);
                        const rawAmount = new bn_js_1.default(amountBytes, "le");
                        baseBalance = new decimal_js_1.default(rawAmount.toString()).div(new decimal_js_1.default(10).pow(baseDecimals));
                    }
                }
                catch {
                    // No token account found
                }
            }
            return { solBalance: solBalanceDecimal, otherBalance, baseBalance };
        });
        (0, output_1.logInfo)(`Your balances:`);
        (0, output_1.logInfo)(`  ${baseSymbol}: ${(0, clmm_utils_1.formatTokenAmount)(balances.baseBalance)}`);
        (0, output_1.logInfo)(`  ${otherSymbol}: ${(0, clmm_utils_1.formatTokenAmount)(balances.otherBalance)}`);
        (0, output_1.logInfo)("");
        // Check if we need to swap
        const otherShortfall = otherAmountRequired.sub(balances.otherBalance);
        if (otherShortfall.gt(0)) {
            (0, output_1.logInfo)(`Shortfall: ${(0, clmm_utils_1.formatTokenAmount)(otherShortfall)} ${otherSymbol}`);
            // Find a swap pool and execute swap
            // Use Raydium API to find pools containing both tokens
            const swapPoolData = await (0, output_1.withSpinner)("Finding swap pool", async () => {
                // Search for pools with both tokens
                const poolsResult = await raydium.api.fetchPoolByMints({
                    mint1: baseMint.address,
                    mint2: otherMint.address
                });
                const pools = poolsResult.data || [];
                // Find an AMM V4 pool (standard swap pool)
                const ammPool = pools.find((p) => p.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
                if (ammPool) {
                    // Get RPC data for the pool
                    return raydium.liquidity.getPoolInfoFromRpc({ poolId: ammPool.id });
                }
                return null;
            });
            if (!swapPoolData || !swapPoolData.poolInfo) {
                (0, output_1.logError)(`No swap pool found for ${baseSymbol}/${otherSymbol}`);
                (0, output_1.logInfo)("You can manually swap tokens first, then retry without --auto-swap");
                process.exitCode = 1;
                return;
            }
            const swapPoolInfo = swapPoolData.poolInfo;
            const swapPoolKeys = swapPoolData.poolKeys;
            const swapRpcData = swapPoolData.poolRpcData;
            (0, output_1.logInfo)(`Using swap pool: ${swapPoolInfo.id}`);
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
            const reserveA = new decimal_js_1.default(swapRpcData.baseReserve.toString()).div(new decimal_js_1.default(10).pow(poolDecimalsA));
            const reserveB = new decimal_js_1.default(swapRpcData.quoteReserve.toString()).div(new decimal_js_1.default(10).pow(poolDecimalsB));
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
            (0, output_1.logInfo)(`Swapping ~${(0, clmm_utils_1.formatTokenAmount)(estimatedSwapIn)} ${baseSymbol} for ~${(0, clmm_utils_1.formatTokenAmount)(swapAmountNeeded)} ${otherSymbol}`);
            (0, output_1.logInfo)("");
            const swapOk = await (0, prompt_1.promptConfirm)("Proceed with swap first?", false);
            if (!swapOk) {
                (0, output_1.logInfo)("Cancelled");
                return;
            }
            // Execute the swap
            try {
                const swapAmountRaw = new bn_js_1.default(estimatedSwapIn.mul(new decimal_js_1.default(10).pow(baseDecimals)).floor().toString());
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
                const swapTxData = await (0, output_1.withSpinner)("Building swap transaction", () => raydium.liquidity.swap({
                    txVersion: raydium_sdk_v2_1.TxVersion.V0,
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
                }));
                const swapResult = await (0, output_1.withSpinner)("Executing swap", () => swapTxData.execute({ sendAndConfirm: true }));
                (0, output_1.logSuccess)(`Swap completed: ${swapResult.txId}`);
                (0, output_1.logInfo)("");
                // Brief pause to let the transaction settle
                await new Promise((r) => setTimeout(r, 2000));
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                (0, output_1.logErrorWithDebug)("Swap failed", error, { fallback: msg });
                process.exitCode = 1;
                return;
            }
        }
    }
    // Show preview
    (0, output_1.logInfo)(`Pool: ${poolId.toBase58()}`);
    (0, output_1.logInfo)(`Pair: ${symbolA}/${symbolB}`);
    (0, output_1.logInfo)(`Tick spacing: ${tickSpacing}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Price Range:");
    (0, output_1.logInfo)(`  Lower: ${(0, clmm_utils_1.formatPrice)(actualPriceLower)} ${symbolB}/${symbolA} (tick ${tickLower})`);
    (0, output_1.logInfo)(`  Upper: ${(0, clmm_utils_1.formatPrice)(actualPriceUpper)} ${symbolB}/${symbolA} (tick ${tickUpper})`);
    (0, output_1.logInfo)(`  Current: ${(0, clmm_utils_1.formatPrice)(currentPrice)} ${symbolB}/${symbolA} (tick ${computePoolInfo.tickCurrent})`);
    (0, output_1.logInfo)(`  Status: ${inRange ? "IN RANGE" : "OUT OF RANGE"}`);
    (0, output_1.logInfo)("");
    (0, output_1.logInfo)("Deposit:");
    (0, output_1.logInfo)(`  ${baseSymbol}: ${amount}`);
    (0, output_1.logInfo)(`  ${otherSymbol}: ${(0, clmm_utils_1.formatTokenAmount)(new decimal_js_1.default(otherAmount.amount.toString()).div(new decimal_js_1.default(10).pow(otherDecimals)))}`);
    (0, output_1.logInfo)(`  Max ${otherSymbol} (with slippage): ${(0, clmm_utils_1.formatTokenAmount)(new decimal_js_1.default(otherSlippageAmount.amount.toString()).div(new decimal_js_1.default(10).pow(otherDecimals)))}`);
    (0, output_1.logInfo)(`Slippage: ${slippagePercent}%`);
    (0, output_1.logInfo)("");
    const ok = await (0, prompt_1.promptConfirm)("Proceed with opening position?", false);
    if (!ok) {
        (0, output_1.logInfo)("Cancelled");
        return;
    }
    try {
        const txData = await (0, output_1.withSpinner)("Building transaction", () => raydium.clmm.openPositionFromBase({
            poolInfo,
            ownerInfo: {
                useSOLBalance: true
            },
            tickLower,
            tickUpper,
            base: baseToken === "A" ? "MintA" : "MintB",
            baseAmount,
            otherAmountMax: otherSlippageAmount.amount,
            txVersion: raydium_sdk_v2_1.TxVersion.V0,
            computeBudgetConfig
        }));
        const result = await (0, output_1.withSpinner)("Sending transaction", () => txData.execute({ sendAndConfirm: true }));
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({
                txId: result.txId,
                nftMint: txData.extInfo.nftMint.toBase58()
            });
        }
        else {
            (0, output_1.logSuccess)(`Position opened: ${result.txId}`);
            (0, output_1.logInfo)(`NFT Mint: ${txData.extInfo.nftMint.toBase58()}`);
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to open position", msg);
        process.exitCode = 1;
    }
}
async function handleCreatePoolCommand(options) {
    options.mintA = await (0, prompt_1.promptIfMissing)(options.mintA, "Token A mint address");
    options.mintB = await (0, prompt_1.promptIfMissing)(options.mintB, "Token B mint address");
    options.feeTier = await (0, prompt_1.promptNumberIfMissing)(options.feeTier, "Fee tier (bps)", (input) => Number.isFinite(Number(input)) && Number(input) > 0
        ? true
        : "Enter a positive fee tier in basis points");
    options.initialPrice = await (0, prompt_1.promptNumberIfMissing)(options.initialPrice, "Initial price (token B per token A)", (input) => Number.isFinite(Number(input)) && Number(input) > 0
        ? true
        : "Enter a positive initial price");
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
    if (!walletName) {
        (0, output_1.logError)("No active wallet set");
        (0, output_1.logInfo)("Set an active wallet with: raydium wallet use <name>");
        process.exitCode = 1;
        return;
    }
    let mintAPubkey;
    let mintBPubkey;
    try {
        mintAPubkey = new web3_js_1.PublicKey(options.mintA);
        mintBPubkey = new web3_js_1.PublicKey(options.mintB);
    }
    catch {
        (0, output_1.logError)("Invalid mint address");
        process.exitCode = 1;
        return;
    }
    if (mintAPubkey.equals(mintBPubkey)) {
        (0, output_1.logError)("--mint-a and --mint-b must be different token mints");
        process.exitCode = 1;
        return;
    }
    const feeTierBps = Number(options.feeTier);
    if (!Number.isFinite(feeTierBps) || feeTierBps <= 0) {
        (0, output_1.logError)("Fee tier must be a positive number (in basis points)");
        process.exitCode = 1;
        return;
    }
    const initialPrice = Number(options.initialPrice);
    if (!Number.isFinite(initialPrice) || initialPrice <= 0) {
        (0, output_1.logError)("Initial price must be a positive number");
        process.exitCode = 1;
        return;
    }
    const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
    if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
        (0, output_1.logError)("Invalid priority fee");
        process.exitCode = 1;
        return;
    }
    const password = await (0, prompt_1.promptPassword)("Enter wallet password");
    let owner;
    try {
        owner = await (0, wallet_manager_1.decryptWallet)(walletName, password);
    }
    catch (error) {
        (0, output_1.logError)("Failed to decrypt wallet", error.message);
        process.exitCode = 1;
        return;
    }
    const raydium = await (0, output_1.withSpinner)("Loading SDK", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
    // Fetch token info for both mints
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mintAInfo;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mintBInfo;
    try {
        const tokenInfos = await (0, output_1.withSpinner)("Fetching token info", async () => {
            const [infoA, infoB] = await Promise.all([
                raydium.token.getTokenInfo(mintAPubkey),
                raydium.token.getTokenInfo(mintBPubkey)
            ]);
            return { infoA, infoB };
        });
        mintAInfo = tokenInfos.infoA;
        mintBInfo = tokenInfos.infoB;
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch token info", msg);
        process.exitCode = 1;
        return;
    }
    if (!mintAInfo || !mintBInfo) {
        (0, output_1.logError)("Could not find token info for one or both mints");
        process.exitCode = 1;
        return;
    }
    const symbolA = mintAInfo.symbol || mintAPubkey.toBase58().slice(0, 6);
    const symbolB = mintBInfo.symbol || mintBPubkey.toBase58().slice(0, 6);
    const decimalsA = mintAInfo.decimals;
    const decimalsB = mintBInfo.decimals;
    // Fetch CLMM configs and find matching fee tier
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let clmmConfigs;
    try {
        clmmConfigs = await (0, output_1.withSpinner)("Fetching CLMM configs", () => raydium.api.getClmmConfigs());
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to fetch CLMM configs", msg);
        process.exitCode = 1;
        return;
    }
    // Find config matching fee tier (tradeFeeRate is in 1e6 format)
    // e.g., 500 bps = 0.05% = 5000 in 1e6 format
    const targetFeeRate = feeTierBps * 10; // Convert bps to 1e6 format
    const matchingConfig = clmmConfigs.find((c) => c.tradeFeeRate === targetFeeRate);
    if (!matchingConfig) {
        (0, output_1.logError)(`No CLMM config found for fee tier ${feeTierBps} bps`);
        (0, output_1.logInfo)("Available fee tiers:");
        for (const c of clmmConfigs) {
            const bps = c.tradeFeeRate / 10;
            (0, output_1.logInfo)(`  ${bps} bps (tick spacing: ${c.tickSpacing})`);
        }
        process.exitCode = 1;
        return;
    }
    const tickSpacing = matchingConfig.tickSpacing;
    // Show preview
    (0, output_1.logInfo)("Create CLMM Pool:");
    (0, output_1.logInfo)(`  Token A: ${symbolA} (${mintAPubkey.toBase58()})`);
    (0, output_1.logInfo)(`  Token B: ${symbolB} (${mintBPubkey.toBase58()})`);
    (0, output_1.logInfo)(`  Fee tier: ${feeTierBps / 100}% (${feeTierBps} bps)`);
    (0, output_1.logInfo)(`  Tick spacing: ${tickSpacing}`);
    (0, output_1.logInfo)(`  Initial price: ${initialPrice} ${symbolB}/${symbolA}`);
    (0, output_1.logInfo)("");
    const ok = await (0, prompt_1.promptConfirm)("Proceed with creating pool?", false);
    if (!ok) {
        (0, output_1.logInfo)("Cancelled");
        return;
    }
    const computeBudgetConfig = getPriorityFeeConfig(priorityFeeSol);
    try {
        const isDevnet = raydium.cluster !== "mainnet";
        const clmmProgramId = isDevnet ? raydium_sdk_v2_1.DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : raydium_sdk_v2_1.CLMM_PROGRAM_ID;
        const txData = await (0, output_1.withSpinner)("Building transaction", () => raydium.clmm.createPool({
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
                id: new web3_js_1.PublicKey(matchingConfig.id),
                index: matchingConfig.index,
                protocolFeeRate: matchingConfig.protocolFeeRate,
                tradeFeeRate: matchingConfig.tradeFeeRate,
                tickSpacing: matchingConfig.tickSpacing,
                fundFeeRate: matchingConfig.fundFeeRate,
                fundOwner: "",
                description: ""
            },
            initialPrice: new decimal_js_1.default(initialPrice),
            txVersion: raydium_sdk_v2_1.TxVersion.V0,
            computeBudgetConfig
        }));
        const result = await (0, output_1.withSpinner)("Sending transaction", () => txData.execute({ sendAndConfirm: true }));
        const poolIdStr = txData.extInfo.address.id;
        const vaultA = txData.extInfo.address.vault.A;
        const vaultB = txData.extInfo.address.vault.B;
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({
                txId: result.txId,
                poolId: poolIdStr,
                vaultA,
                vaultB
            });
        }
        else {
            (0, output_1.logSuccess)(`Pool created: ${result.txId}`);
            (0, output_1.logInfo)(`Pool ID: ${poolIdStr}`);
            (0, output_1.logInfo)(`Vault A: ${vaultA}`);
            (0, output_1.logInfo)(`Vault B: ${vaultB}`);
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        (0, output_1.logError)("Failed to create pool", msg);
        process.exitCode = 1;
    }
}
