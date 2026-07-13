"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCpmmCommands = void 0;
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const raydium_sdk_v2_1 = require("@raydium-io/raydium-sdk-v2");
const bn_js_1 = __importDefault(require("bn.js"));
const decimal_js_1 = __importDefault(require("decimal.js"));
const api_urls_1 = require("../../lib/api-urls");
const cpmm_layout_1 = require("../../lib/cpmm-layout");
const connection_1 = require("../../lib/connection");
const config_manager_1 = require("../../lib/config-manager");
const raydium_client_1 = require("../../lib/raydium-client");
const wallet_manager_1 = require("../../lib/wallet-manager");
const prompt_1 = require("../../lib/prompt");
const output_1 = require("../../lib/output");
const help_1 = require("../../lib/help");
const explorer_1 = require("../../lib/explorer");
const safe_transaction_1 = require("../../lib/safe-transaction");
const swap_guards_1 = require("../../lib/swap-guards");
const quote_approval_1 = require("../../lib/quote-approval");
// Fetch lock position info from Raydium API
async function fetchCpmmLockPositionInfo(nftMint, cluster = "mainnet") {
    const url = `${(0, api_urls_1.getApiUrlsForCluster)(cluster).CPMM_LOCK}/${nftMint}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            return null;
        }
        return await response.json();
    }
    catch {
        return null;
    }
}
const DEFAULT_COMPUTE_UNITS = 600000;
const FEE_RATE_DENOMINATOR = 1000000;
const MAX_PRIORITY_FEE_LAMPORTS = 100000000n;
const SIGNATURE_FEE_LAMPORTS = 5000n;
// Headroom for rent spent on token accounts the swap may create (an ATA costs ~2_039_280 lamports).
const SWAP_RENT_ALLOWANCE_LAMPORTS = 10000000n;
const COMMON_TRANSACTION_PROGRAM_IDS = new Set([
    web3_js_1.ComputeBudgetProgram.programId.toBase58(),
    web3_js_1.SystemProgram.programId.toBase58(),
    spl_token_1.TOKEN_PROGRAM_ID.toBase58(),
    spl_token_1.TOKEN_2022_PROGRAM_ID.toBase58(),
    spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
]);
function parseUiAmount(value, decimals, label) {
    const normalized = value.trim();
    if (!/^\d+(\.\d+)?$/.test(normalized))
        throw new Error(`${label} must be a positive decimal number`);
    const amount = new decimal_js_1.default(normalized);
    if (!amount.isFinite() || amount.lte(0))
        throw new Error(`${label} must be greater than zero`);
    const raw = amount.mul(new decimal_js_1.default(10).pow(decimals));
    if (!raw.isInteger())
        throw new Error(`${label} has more than ${decimals} decimal places`);
    return new bn_js_1.default(raw.toFixed(0));
}
function formatRawAmount(raw, decimals) {
    return new decimal_js_1.default(raw.toString()).div(new decimal_js_1.default(10).pow(decimals)).toFixed();
}
function getCpmmSymbol(mint) {
    return mint.symbol || `${mint.address.slice(0, 6)}...`;
}
function formatCpmmFeeRate(rawRate) {
    if (!rawRate)
        return undefined;
    return {
        raw: rawRate.toString(),
        percent: new decimal_js_1.default(rawRate.toString()).mul(100).div(FEE_RATE_DENOMINATOR).toFixed()
    };
}
function getCpmmOperationError(error) {
    return (0, cpmm_layout_1.getUnsupportedCpmmLayoutMessage)(error) ?? error;
}
function isCpmmApiPool(pool) {
    return Boolean(pool &&
        typeof pool === "object" &&
        pool.type === "Standard" &&
        "config" in pool);
}
function applyCpmmSlippage(rawAmount, slippage, exactOut) {
    const multiplier = new bn_js_1.default((exactOut ? 1 + slippage : 1 - slippage) * 10000);
    return rawAmount.mul(multiplier).div(new bn_js_1.default(10000));
}
function toCpmmSlippageFraction(slippagePercent) {
    const decimal = new decimal_js_1.default(slippagePercent).div(100);
    const places = decimal.decimalPlaces();
    const denominator = new decimal_js_1.default(10).pow(places);
    return new raydium_sdk_v2_1.Percent(new bn_js_1.default(decimal.mul(denominator).toFixed(0)), new bn_js_1.default(denominator.toFixed(0)));
}
async function reviewAndExecuteCpmmTransaction(params) {
    const { transaction, owner } = params;
    (0, quote_approval_1.assertJsonQuoteApproval)({
        action: params.quoteAction,
        quote: params.quote,
        approvedQuoteId: params.approvedQuoteId
    });
    const connection = await (0, connection_1.getConnection)();
    const policyPreview = await (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, transaction, {
        owner: owner.publicKey,
        allowedProgramIds: params.allowedProgramIds
    });
    const feePreview = (0, safe_transaction_1.assertTransactionPriorityFeeBudget)(transaction, params.requestedPriorityFeeMicroLamports, MAX_PRIORITY_FEE_LAMPORTS);
    const preview = { ...feePreview, programIds: policyPreview.programIds };
    const simulation = await (0, output_1.withSpinner)("Simulating transaction", () => (0, safe_transaction_1.simulateVersionedTransaction)(connection, transaction, params.balanceGuards));
    if (!(0, output_1.isJsonOutput)()) {
        (0, output_1.logInfo)(`Transaction review: ${preview.instructionCount} instructions`);
        (0, output_1.logInfo)(`Programs: ${preview.programIds.join(", ") || "unavailable"}`);
        if (preview.computeBudget?.maximumPriorityFeeLamports) {
            (0, output_1.logInfo)(`Maximum priority fee: ${preview.computeBudget.maximumPriorityFeeLamports} lamports`);
        }
        (0, output_1.logInfo)(`Simulation: succeeded${simulation.unitsConsumed ? ` (${simulation.unitsConsumed} compute units)` : ""}`);
    }
    const ok = await (0, prompt_1.promptConfirm)("Send the simulated CPMM transaction?", false);
    if (!ok) {
        (0, output_1.logInfo)("Cancelled");
        return undefined;
    }
    transaction.sign([owner]);
    const txId = await (0, output_1.withSpinner)("Sending transaction", () => (0, safe_transaction_1.sendAndConfirmVersionedTransaction)(connection, transaction));
    const explorerUrl = (0, explorer_1.getTransactionExplorerUrl)({ ...params.explorer, signature: txId });
    if (!(0, output_1.isJsonOutput)()) {
        (0, output_1.logInfo)(`Explorer: ${explorerUrl}`);
        try {
            await (0, explorer_1.offerTransactionExplorer)({ ...params.explorer, signature: txId });
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("Transaction confirmed, but explorer could not be opened", error);
        }
    }
    if ((0, output_1.isJsonOutput)()) {
        (0, output_1.logJson)({
            action: params.action,
            ...(0, quote_approval_1.withQuoteApprovalId)(params.quoteAction, params.quote),
            transaction: preview,
            simulation: { unitsConsumed: simulation.unitsConsumed },
            txId,
            explorerUrl,
            confirmationStatus: "confirmed"
        });
    }
    else {
        (0, output_1.logSuccess)(`CPMM transaction confirmed: ${txId}`);
    }
    return txId;
}
function registerCpmmCommands(program) {
    const cpmm = program.command("cpmm").description("CPMM (constant product) pool commands");
    // List available CPMM configs
    (0, help_1.addRichHelp)(cpmm
        .command("configs")
        .description("List available CPMM pool fee configurations")
        .option("--devnet", "Use devnet API instead of the configured cluster"), {
        summary: "Shows the Raydium CPMM fee configs available for pool creation.",
        defaults: [
            "Uses the configured cluster unless --devnet is provided.",
            "The output explains how trade fees split across LPs, protocol, fund, and creator fees."
        ],
        automation: help_1.AUTOMATION_HELP,
        examples: [
            "raydium cpmm configs",
            "raydium cpmm configs --devnet",
            "raydium --json cpmm configs"
        ],
        notes: "--devnet is a command-local override and does not modify the saved cluster config."
    })
        .action(async (options) => {
        const configuredCluster = await (0, raydium_client_1.getConfiguredCluster)();
        const cluster = options.devnet ? "devnet" : configuredCluster;
        const baseUrl = cluster === "devnet"
            ? "https://api-v3.raydium.io/devnet/cpmm-config"
            : "https://api-v3.raydium.io/main/cpmm-config";
        let configData;
        try {
            configData = await (0, output_1.withSpinner)("Fetching CPMM configs", async () => {
                const response = await fetch(baseUrl);
                if (!response.ok) {
                    throw new Error(`API request failed: ${response.status}`);
                }
                return response.json();
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            (0, output_1.logError)("Failed to fetch CPMM configs", message);
            process.exitCode = 1;
            return;
        }
        if (!configData.success || !configData.data) {
            (0, output_1.logError)("Invalid API response");
            process.exitCode = 1;
            return;
        }
        // Sort by index
        const configs = configData.data.sort((a, b) => a.index - b.index);
        if ((0, output_1.isJsonOutput)()) {
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
            (0, output_1.logJson)({ configs: enrichedConfigs });
            return;
        }
        (0, output_1.logInfo)("");
        (0, output_1.logInfo)("Available CPMM Fee Configurations");
        (0, output_1.logInfo)("══════════════════════════════════════════════════════════════════════════════");
        (0, output_1.logInfo)("");
        (0, output_1.logInfo)("Fee Structure Explanation:");
        (0, output_1.logInfo)("  • tradeFeeRate: Fee charged on each swap (in bps)");
        (0, output_1.logInfo)("    └─ Split between: LP (compounds) + Protocol (Raydium) + Fund");
        (0, output_1.logInfo)("  • creatorFeeRate: Additional fee to pool creator (in bps)");
        (0, output_1.logInfo)("  • Total Fee = tradeFeeRate + creatorFeeRate");
        (0, output_1.logInfo)("");
        for (const config of configs) {
            const tradeBps = (config.tradeFeeRate / FEE_RATE_DENOMINATOR) * 10000;
            const creatorBps = (config.creatorFeeRate / FEE_RATE_DENOMINATOR) * 10000;
            const totalBps = tradeBps + creatorBps;
            const protocolPct = (config.protocolFeeRate / FEE_RATE_DENOMINATOR) * 100;
            const fundPct = (config.fundFeeRate / FEE_RATE_DENOMINATOR) * 100;
            const lpPct = 100 - protocolPct - fundPct;
            const createPoolSol = Number(config.createPoolFee) / 1e9;
            (0, output_1.logInfo)(`Config #${config.index}`);
            (0, output_1.logInfo)(`  ID: ${config.id}`);
            (0, output_1.logInfo)(`  Trade Fee: ${tradeBps} bps (${tradeBps / 100}%)`);
            (0, output_1.logInfo)(`    ├─ LP Fee: ~${(tradeBps * lpPct / 100).toFixed(1)} bps (${lpPct.toFixed(0)}% of trade fee → compounds into pool)`);
            (0, output_1.logInfo)(`    ├─ Protocol: ~${(tradeBps * protocolPct / 100).toFixed(1)} bps (${protocolPct.toFixed(0)}% of trade fee → Raydium)`);
            (0, output_1.logInfo)(`    └─ Fund: ~${(tradeBps * fundPct / 100).toFixed(1)} bps (${fundPct.toFixed(0)}% of trade fee)`);
            (0, output_1.logInfo)(`  Creator Fee: ${creatorBps} bps (${creatorBps / 100}%) → pool creator`);
            (0, output_1.logInfo)(`  Total Fee: ${totalBps} bps (${totalBps / 100}%)`);
            (0, output_1.logInfo)(`  Pool Creation Fee: ${createPoolSol} SOL`);
            (0, output_1.logInfo)("");
        }
        (0, output_1.logInfo)("──────────────────────────────────────────────────────────────────────────────");
        (0, output_1.logInfo)("Note: These are the only available configs. Custom configs require Raydium.");
    });
    // Collect creator fees command
    (0, help_1.addRichHelp)(cpmm
        .command("collect-creator-fees")
        .description("Collect creator fees from a CPMM pool you created")
        .option("--pool-id <address>", "Pool ID to collect from (prompted when omitted)")
        .option("--priority-fee <sol>", "Priority fee in SOL")
        .option("--debug", "Print full error on failure"), {
        auth: help_1.PASSWORD_AUTH_HELP,
        units: "--priority-fee is in SOL.",
        defaults: "Uses the active wallet unless --keystore overrides it.",
        automation: help_1.AUTOMATION_HELP,
        examples: [
            "raydium cpmm collect-creator-fees --pool-id <pool-id>",
            "printf '%s' 'wallet-password' | raydium --json --yes --password-stdin cpmm collect-creator-fees --pool-id <pool-id>"
        ]
    })
        .action(async (options) => {
        options.poolId = await (0, prompt_1.promptIfMissing)(options.poolId, "CPMM pool address");
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        // Validate pool ID
        let poolId;
        try {
            poolId = new web3_js_1.PublicKey(options.poolId);
        }
        catch {
            (0, output_1.logError)("Invalid pool ID address");
            process.exitCode = 1;
            return;
        }
        // Validate priority fee
        const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
        if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
            (0, output_1.logError)("Invalid priority fee");
            process.exitCode = 1;
            return;
        }
        const priorityFeeLamports = priorityFeeSol * 1e9;
        const priorityFeeMicroLamports = Math.round((priorityFeeLamports * 1e6) / DEFAULT_COMPUTE_UNITS);
        // Check wallet
        const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
        if (!walletName) {
            (0, output_1.logError)("No active wallet set. Use 'raydium wallet use <name>' to set one.");
            process.exitCode = 1;
            return;
        }
        // Prompt for password and decrypt wallet
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
        // Load Raydium with owner
        const raydium = await (0, output_1.withSpinner)("Loading Raydium", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
        // Fetch pool info
        let poolInfo;
        try {
            poolInfo = await (0, output_1.withSpinner)("Fetching pool info", async () => {
                const data = await raydium.api.fetchPoolById({ ids: poolId.toBase58() });
                if (!data || data.length === 0) {
                    throw new Error("Pool not found");
                }
                const pool = data[0];
                if (pool.type !== "Standard" || !("lpMint" in pool)) {
                    throw new Error("Not a CPMM pool");
                }
                return pool;
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            (0, output_1.logError)("Failed to fetch pool info", message);
            process.exitCode = 1;
            return;
        }
        // Show preview
        const mintA = poolInfo.mintA;
        const mintB = poolInfo.mintB;
        const symbolA = mintA.symbol || mintA.address.slice(0, 8) + "...";
        const symbolB = mintB.symbol || mintB.address.slice(0, 8) + "...";
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({
                action: "collect-creator-fees",
                poolId: poolId.toBase58(),
                pair: `${symbolA}/${symbolB}`
            });
        }
        else {
            (0, output_1.logInfo)("");
            (0, output_1.logInfo)(`Collecting Creator Fees`);
            (0, output_1.logInfo)(`  Pool: ${poolId.toBase58()}`);
            (0, output_1.logInfo)(`  Pair: ${symbolA}/${symbolB}`);
        }
        // Confirm
        const ok = await (0, prompt_1.promptConfirm)("Proceed with collecting creator fees?", false);
        if (!ok) {
            (0, output_1.logInfo)("Cancelled");
            return;
        }
        let txData;
        try {
            txData = await (0, output_1.withSpinner)("Building transaction", async () => {
                return raydium.cpmm.collectCreatorFees({
                    poolInfo,
                    programId: raydium_sdk_v2_1.CREATE_CPMM_POOL_PROGRAM,
                    txVersion: raydium_sdk_v2_1.TxVersion.V0,
                    computeBudgetConfig: priorityFeeMicroLamports > 0
                        ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
                        : undefined
                });
            });
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("Failed to build transaction", error, { debug: options.debug, fallback: "Failed to build transaction" });
            process.exitCode = 1;
            return;
        }
        let result;
        try {
            result = await (0, output_1.withSpinner)("Sending transaction", async () => {
                const executed = await txData.execute({ sendAndConfirm: true });
                return { txId: executed.txId };
            });
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("Collect fees failed", error, { debug: options.debug, fallback: "Collect fees failed" });
            process.exitCode = 1;
            return;
        }
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ txId: result.txId });
        }
        else {
            (0, output_1.logSuccess)(`Creator fees collected: ${result.txId}`);
        }
    });
    // Harvest LP fees command (for locked LP positions)
    (0, help_1.addRichHelp)(cpmm
        .command("harvest-lp-fees")
        .description("Harvest fees from a locked LP position")
        .option("--pool-id <address>", "Pool ID (prompted when omitted)")
        .option("--nft-mint <address>", "Fee Key NFT mint address (prompted when omitted)")
        .option("--lp-fee-amount <amount>", "LP fee amount to harvest (in raw units, overrides --percent)")
        .option("--percent <number>", "Percentage of available fees to harvest (default: 100)", "100")
        .option("--priority-fee <sol>", "Priority fee in SOL")
        .option("--debug", "Print full error on failure"), {
        auth: help_1.PASSWORD_AUTH_HELP,
        units: [
            "--lp-fee-amount is in raw units.",
            "--percent is a percentage from 1 to 100.",
            "--priority-fee is in SOL."
        ],
        defaults: [
            "If --lp-fee-amount is omitted, the command derives the harvest amount from the current available fees.",
            "--percent defaults to 100."
        ],
        automation: help_1.AUTOMATION_HELP,
        examples: [
            "raydium cpmm harvest-lp-fees --pool-id <pool-id> --nft-mint <lock-nft-mint>",
            "raydium cpmm harvest-lp-fees --pool-id <pool-id> --nft-mint <lock-nft-mint> --percent 50",
            "raydium cpmm harvest-lp-fees --pool-id <pool-id> --nft-mint <lock-nft-mint> --lp-fee-amount 123456"
        ]
    })
        .action(async (options) => {
        options.poolId = await (0, prompt_1.promptIfMissing)(options.poolId, "CPMM pool address");
        options.nftMint = await (0, prompt_1.promptIfMissing)(options.nftMint, "Fee Key NFT mint address");
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        // Validate pool ID
        let poolId;
        try {
            poolId = new web3_js_1.PublicKey(options.poolId);
        }
        catch {
            (0, output_1.logError)("Invalid pool ID address");
            process.exitCode = 1;
            return;
        }
        // Validate NFT mint
        let nftMint;
        try {
            nftMint = new web3_js_1.PublicKey(options.nftMint);
        }
        catch {
            (0, output_1.logError)("Invalid NFT mint address");
            process.exitCode = 1;
            return;
        }
        // Validate percent
        const percent = Number(options.percent ?? "100");
        if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
            (0, output_1.logError)("Invalid percent (must be 1-100)");
            process.exitCode = 1;
            return;
        }
        // Determine LP fee amount - either explicit or fetched from API
        let lpFeeAmount;
        let totalAvailableFee;
        if (options.lpFeeAmount) {
            // User provided explicit amount
            const lpFeeAmountNum = Number(options.lpFeeAmount);
            if (!Number.isFinite(lpFeeAmountNum) || lpFeeAmountNum < 0) {
                (0, output_1.logError)("Invalid LP fee amount");
                process.exitCode = 1;
                return;
            }
            lpFeeAmount = new bn_js_1.default(options.lpFeeAmount);
        }
        else {
            // Fetch from API using the configured cluster.
            const cluster = config.cluster;
            const lockInfo = await (0, output_1.withSpinner)("Fetching lock position info", () => fetchCpmmLockPositionInfo(nftMint.toBase58(), cluster));
            if (!lockInfo) {
                (0, output_1.logError)("Failed to fetch lock position info. Use --lp-fee-amount to specify manually.");
                process.exitCode = 1;
                return;
            }
            totalAvailableFee = lockInfo.positionInfo.unclaimedFee.lp;
            if (totalAvailableFee <= 0) {
                (0, output_1.logError)("No unclaimed LP fees available");
                process.exitCode = 1;
                return;
            }
            // Calculate amount based on percentage
            const amountToHarvest = Math.floor(totalAvailableFee * (percent / 100));
            if (amountToHarvest <= 0) {
                (0, output_1.logError)("Calculated harvest amount is zero");
                process.exitCode = 1;
                return;
            }
            lpFeeAmount = new bn_js_1.default(amountToHarvest);
        }
        // Validate priority fee
        const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
        if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
            (0, output_1.logError)("Invalid priority fee");
            process.exitCode = 1;
            return;
        }
        const priorityFeeLamports = priorityFeeSol * 1e9;
        const priorityFeeMicroLamports = Math.round((priorityFeeLamports * 1e6) / DEFAULT_COMPUTE_UNITS);
        // Check wallet
        const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
        if (!walletName) {
            (0, output_1.logError)("No active wallet set. Use 'raydium wallet use <name>' to set one.");
            process.exitCode = 1;
            return;
        }
        // Prompt for password and decrypt wallet
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
        // Load Raydium with owner
        const raydium = await (0, output_1.withSpinner)("Loading Raydium", () => (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true }));
        // Fetch pool info
        let poolInfo;
        try {
            poolInfo = await (0, output_1.withSpinner)("Fetching pool info", async () => {
                const data = await raydium.api.fetchPoolById({ ids: poolId.toBase58() });
                if (!data || data.length === 0) {
                    throw new Error("Pool not found");
                }
                const pool = data[0];
                if (pool.type !== "Standard" || !("lpMint" in pool)) {
                    throw new Error("Not a CPMM pool");
                }
                return pool;
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            (0, output_1.logError)("Failed to fetch pool info", message);
            process.exitCode = 1;
            return;
        }
        // Show preview
        const mintA = poolInfo.mintA;
        const mintB = poolInfo.mintB;
        const symbolA = mintA.symbol || mintA.address.slice(0, 8) + "...";
        const symbolB = mintB.symbol || mintB.address.slice(0, 8) + "...";
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({
                action: "harvest-lp-fees",
                poolId: poolId.toBase58(),
                pair: `${symbolA}/${symbolB}`,
                nftMint: nftMint.toBase58(),
                lpFeeAmount: lpFeeAmount.toString(),
                ...(totalAvailableFee !== undefined && { totalAvailableFee, percent })
            });
        }
        else {
            (0, output_1.logInfo)("");
            (0, output_1.logInfo)(`Harvesting LP Fees from Locked Position`);
            (0, output_1.logInfo)(`  Pool: ${poolId.toBase58()}`);
            (0, output_1.logInfo)(`  Pair: ${symbolA}/${symbolB}`);
            (0, output_1.logInfo)(`  NFT Mint: ${nftMint.toBase58()}`);
            if (totalAvailableFee !== undefined) {
                (0, output_1.logInfo)(`  Available LP Fees: ${totalAvailableFee}`);
                (0, output_1.logInfo)(`  Harvesting: ${percent}% (${lpFeeAmount.toString()} LP)`);
            }
            else {
                (0, output_1.logInfo)(`  LP Fee Amount: ${lpFeeAmount.toString()}`);
            }
        }
        // Confirm
        const ok = await (0, prompt_1.promptConfirm)("Proceed with harvesting LP fees?", false);
        if (!ok) {
            (0, output_1.logInfo)("Cancelled");
            return;
        }
        let txData;
        try {
            txData = await (0, output_1.withSpinner)("Building transaction", async () => {
                return raydium.cpmm.harvestLockLp({
                    poolInfo,
                    nftMint,
                    lpFeeAmount,
                    programId: raydium_sdk_v2_1.LOCK_CPMM_PROGRAM,
                    authProgram: raydium_sdk_v2_1.LOCK_CPMM_AUTH,
                    txVersion: raydium_sdk_v2_1.TxVersion.V0,
                    computeBudgetConfig: priorityFeeMicroLamports > 0
                        ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
                        : undefined
                });
            });
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("Failed to build transaction", error, { debug: options.debug, fallback: "Failed to build transaction" });
            process.exitCode = 1;
            return;
        }
        let result;
        try {
            result = await (0, output_1.withSpinner)("Sending transaction", async () => {
                const executed = await txData.execute({ sendAndConfirm: true });
                return { txId: executed.txId };
            });
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("Harvest failed", error, { debug: options.debug, fallback: "Harvest failed" });
            process.exitCode = 1;
            return;
        }
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ txId: result.txId });
        }
        else {
            (0, output_1.logSuccess)(`LP fees harvested: ${result.txId}`);
        }
    });
    cpmm
        .command("pool")
        .description("Show CPMM pool state from RPC, with indexed API fallback for unsupported layouts")
        .argument("[pool-id]", "CPMM pool address (prompted when omitted)")
        .action(async (poolId) => {
        poolId = await (0, prompt_1.promptIfMissing)(poolId, "CPMM pool address");
        let parsedPoolId;
        try {
            parsedPoolId = new web3_js_1.PublicKey(poolId);
        }
        catch {
            (0, output_1.logError)("Invalid CPMM pool address");
            process.exitCode = 1;
            return;
        }
        try {
            const raydium = await (0, output_1.withSpinner)("Loading Raydium", () => (0, raydium_client_1.loadRaydium)({ disableLoadToken: true }));
            let payload;
            try {
                const data = await (0, output_1.withSpinner)("Fetching CPMM pool state", () => raydium.cpmm.getPoolInfoFromRpc(parsedPoolId.toBase58()));
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
            }
            catch (error) {
                const layoutMessage = (0, cpmm_layout_1.getUnsupportedCpmmLayoutMessage)(error);
                if (!layoutMessage)
                    throw error;
                const pools = await (0, output_1.withSpinner)("Fetching indexed CPMM pool data", () => raydium.api.fetchPoolById({ ids: parsedPoolId.toBase58() }));
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
            if ((0, output_1.isJsonOutput)()) {
                (0, output_1.logJson)(payload);
            }
            else {
                (0, output_1.logInfo)(`CPMM pool: ${payload.pair}`);
                (0, output_1.logInfo)(`  Source: ${payload.source}`);
                (0, output_1.logInfo)(`  ID: ${payload.poolId}`);
                (0, output_1.logInfo)(`  Reserves: ${payload.reserves.mintA} / ${payload.reserves.mintB}`);
                (0, output_1.logInfo)(`  LP mint: ${payload.lpMint.address}`);
                if (payload.warning)
                    (0, output_1.logInfo)(`  Warning: ${payload.warning}`);
                if (payload.fees.trade)
                    (0, output_1.logInfo)(`  Trade fee: ${payload.fees.trade.percent}% (${payload.fees.trade.raw}/${FEE_RATE_DENOMINATOR})`);
                if (payload.fees.apiFeeRate !== undefined)
                    (0, output_1.logInfo)(`  API fee rate: ${payload.fees.apiFeeRate}`);
            }
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("Failed to fetch CPMM pool", getCpmmOperationError(error));
            process.exitCode = 1;
        }
    });
    cpmm
        .command("swap")
        .description("Quote or execute a direct CPMM swap")
        .option("--pool-id <address>", "CPMM pool address (prompted when omitted)")
        .option("--input-mint <address>", "Input token mint for an exact-input swap")
        .option("--output-mint <address>", "Requested output token mint for an exact-output swap")
        .option("--amount <number>", "Input amount, or requested output with --exact-out (prompted when omitted)")
        .option("--exact-out", "Treat --amount as the requested output amount")
        .option("--slippage <percent>", "Slippage tolerance")
        .option("--allow-high-slippage", "Allow slippage above the 5% safety cap")
        .option("--priority-fee <sol>", "Priority fee in SOL")
        .option("--allow-high-priority-fee", "Allow priority fee above the 0.01 SOL safety cap")
        .option("--execute", "Build, simulate, review, and send the swap")
        .option("--approve-quote <quote-id>", "Required with --json --execute; use quoteId from a fresh quote")
        .action(async (options) => {
        options.poolId = await (0, prompt_1.promptIfMissing)(options.poolId, "CPMM pool address");
        options.amount = await (0, prompt_1.promptNumberIfMissing)(options.amount, "Swap amount", (input) => Number.isFinite(Number(input)) && Number(input) > 0 ? true : "Enter a positive amount");
        if (options.exactOut) {
            options.outputMint = await (0, prompt_1.promptIfMissing)(options.outputMint, "Output token mint");
        }
        else {
            options.inputMint = await (0, prompt_1.promptIfMissing)(options.inputMint, "Input token mint");
        }
        let poolId;
        let specifiedMint;
        try {
            poolId = new web3_js_1.PublicKey(options.poolId);
            const requestedMint = options.exactOut ? options.outputMint : options.inputMint;
            if (!requestedMint) {
                throw new Error(options.exactOut
                    ? "--exact-out requires --output-mint"
                    : "An exact-input swap requires --input-mint");
            }
            specifiedMint = new web3_js_1.PublicKey(requestedMint);
        }
        catch {
            (0, output_1.logError)(options.exactOut
                ? "--exact-out requires a valid --output-mint address"
                : "A valid --pool-id and --input-mint address are required");
            process.exitCode = 1;
            return;
        }
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        let slippagePercent;
        let priorityFeeMicroLamports;
        try {
            slippagePercent = (0, swap_guards_1.parseSlippagePercent)(options.slippage ?? String(config["default-slippage"]), Boolean(options.allowHighSlippage)).toNumber();
            priorityFeeMicroLamports = (0, swap_guards_1.parsePriorityFeeMicroLamports)(options.priorityFee ?? String(config["priority-fee"]), Boolean(options.allowHighPriorityFee));
        }
        catch (error) {
            (0, output_1.logError)(error instanceof Error ? error.message : "Invalid swap safety setting");
            process.exitCode = 1;
            return;
        }
        const slippage = slippagePercent / 100;
        const buildQuote = async (raydium) => {
            const data = await raydium.cpmm.getPoolInfoFromRpc(poolId.toBase58());
            const { poolInfo, poolKeys, rpcData } = data;
            const mintA = new web3_js_1.PublicKey(poolInfo.mintA.address);
            const mintB = new web3_js_1.PublicKey(poolInfo.mintB.address);
            if (!specifiedMint.equals(mintA) && !specifiedMint.equals(mintB)) {
                throw new Error("Specified mint does not belong to this CPMM pool");
            }
            const baseIn = options.exactOut ? specifiedMint.equals(mintB) : specifiedMint.equals(mintA);
            const amountDecimals = specifiedMint.equals(mintA)
                ? poolInfo.mintA.decimals
                : poolInfo.mintB.decimals;
            const requestedAmount = parseUiAmount(options.amount, amountDecimals, "Amount");
            const sourceReserve = baseIn ? rpcData.baseReserve : rpcData.quoteReserve;
            const destinationReserve = baseIn ? rpcData.quoteReserve : rpcData.baseReserve;
            if (options.exactOut && requestedAmount.gte(destinationReserve)) {
                throw new Error("Requested output must be less than the current pool reserve");
            }
            const configInfo = rpcData.configInfo;
            if (!configInfo)
                throw new Error("CPMM pool is missing its fee configuration");
            const feeOnOutput = rpcData.feeOn === raydium_sdk_v2_1.FeeOn.BothToken || rpcData.feeOn === raydium_sdk_v2_1.FeeOn.OnlyTokenB;
            const swapResult = options.exactOut
                ? raydium_sdk_v2_1.CurveCalculator.swapBaseOutput(requestedAmount, sourceReserve, destinationReserve, configInfo.tradeFeeRate, configInfo.creatorFeeRate, configInfo.protocolFeeRate, configInfo.fundFeeRate, feeOnOutput)
                : raydium_sdk_v2_1.CurveCalculator.swapBaseInput(requestedAmount, sourceReserve, destinationReserve, configInfo.tradeFeeRate, configInfo.creatorFeeRate, configInfo.protocolFeeRate, configInfo.fundFeeRate, feeOnOutput);
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
                            maximumInput: formatRawAmount(applyCpmmSlippage(inputRaw, slippage, true), inputMint.decimals),
                            mint: inputMint.address
                        }
                        : {
                            minimumOutput: formatRawAmount(applyCpmmSlippage(outputRaw, slippage, false), outputMint.decimals),
                            mint: outputMint.address
                        },
                    slippagePercent
                }
            };
        };
        try {
            const raydium = await (0, output_1.withSpinner)("Loading Raydium", () => (0, raydium_client_1.loadRaydium)({ disableLoadToken: true }));
            const quoteData = await (0, output_1.withSpinner)("Fetching live CPMM quote", () => buildQuote(raydium));
            if (!options.execute) {
                const approvedQuote = (0, quote_approval_1.withQuoteApprovalId)("cpmm-swap-quote", quoteData.quote);
                if ((0, output_1.isJsonOutput)()) {
                    (0, output_1.logJson)({ action: "cpmm-swap-quote", ...approvedQuote });
                }
                else {
                    (0, output_1.logInfo)(`CPMM ${quoteData.quote.swapType}: ${quoteData.quote.input.amount} -> ${quoteData.quote.output.amount}`);
                    if ("minimumOutput" in quoteData.quote.protection) {
                        (0, output_1.logInfo)(`Minimum output: ${quoteData.quote.protection.minimumOutput}`);
                    }
                    else {
                        (0, output_1.logInfo)(`Maximum input: ${quoteData.quote.protection.maximumInput}`);
                    }
                    (0, output_1.logInfo)(`Quote ID: ${approvedQuote.quoteId}`);
                    (0, output_1.logInfo)("Quote only. Re-run with --execute to build, simulate, review, and send.");
                }
                return;
            }
            const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
            if (!walletName)
                throw new Error("No active wallet set");
            const password = await (0, prompt_1.promptPassword)("Enter wallet password");
            const owner = await (0, wallet_manager_1.decryptWallet)(walletName, password);
            const signingRaydium = await (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true });
            const fresh = await (0, output_1.withSpinner)("Refreshing CPMM quote", () => buildQuote(signingRaydium));
            const built = await (0, output_1.withSpinner)("Building CPMM swap", () => signingRaydium.cpmm.swap({
                poolInfo: fresh.poolInfo,
                poolKeys: fresh.poolKeys,
                inputAmount: options.exactOut ? new bn_js_1.default(0) : parseUiAmount(options.amount, specifiedMint.equals(new web3_js_1.PublicKey(fresh.poolInfo.mintA.address)) ? fresh.poolInfo.mintA.decimals : fresh.poolInfo.mintB.decimals, "Amount"),
                swapResult: fresh.swapResult,
                fixedOut: Boolean(options.exactOut),
                slippage,
                baseIn: fresh.baseIn,
                txVersion: raydium_sdk_v2_1.TxVersion.V0,
                computeBudgetConfig: priorityFeeMicroLamports > 0
                    ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
                    : undefined
            }));
            if (!(built.transaction instanceof web3_js_1.VersionedTransaction)) {
                throw new Error("CPMM safe execution requires a single V0 transaction");
            }
            const inputMintInfo = fresh.baseIn ? fresh.poolInfo.mintA : fresh.poolInfo.mintB;
            const outputMintInfo = fresh.baseIn ? fresh.poolInfo.mintB : fresh.poolInfo.mintA;
            const inputIsSol = inputMintInfo.address === spl_token_1.NATIVE_MINT.toBase58();
            const outputIsSol = outputMintInfo.address === spl_token_1.NATIVE_MINT.toBase58();
            const inputMaxAtomic = BigInt((options.exactOut
                ? applyCpmmSlippage(fresh.swapResult.inputAmount, slippage, true)
                : fresh.swapResult.inputAmount).toString());
            const minOutputAtomic = BigInt((options.exactOut
                ? fresh.swapResult.outputAmount
                : applyCpmmSlippage(fresh.swapResult.outputAmount, slippage, false)).toString());
            const feeAllowanceLamports = (BigInt(priorityFeeMicroLamports) * BigInt(DEFAULT_COMPUTE_UNITS) + 999999n) / 1000000n +
                SIGNATURE_FEE_LAMPORTS +
                SWAP_RENT_ALLOWANCE_LAMPORTS;
            const getAta = (mint) => (0, spl_token_1.getAssociatedTokenAddressSync)(new web3_js_1.PublicKey(mint.address), owner.publicKey, false, new web3_js_1.PublicKey(mint.programId));
            const balanceGuards = {
                owner: owner.publicKey,
                minOwnerLamportsDelta: (outputIsSol ? minOutputAtomic : 0n) -
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
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("CPMM swap failed", getCpmmOperationError(error));
            process.exitCode = 1;
        }
    });
    const liquidity = cpmm.command("liquidity").description("Quote or manage CPMM liquidity");
    liquidity
        .command("add")
        .description("Quote or add proportional liquidity to a CPMM pool")
        .option("--pool-id <address>", "CPMM pool address (prompted when omitted)")
        .option("--input-mint <address>", "Token mint whose amount you are specifying (prompted when omitted)")
        .option("--amount <number>", "Maximum input token amount (prompted when omitted)")
        .option("--slippage <percent>", "Minimum LP-token minting tolerance")
        .option("--allow-high-slippage", "Allow slippage above the 5% safety cap")
        .option("--priority-fee <sol>", "Priority fee in SOL")
        .option("--allow-high-priority-fee", "Allow priority fee above the 0.01 SOL safety cap")
        .option("--execute", "Build, simulate, review, and send the liquidity deposit")
        .option("--approve-quote <quote-id>", "Required with --json --execute; use quoteId from a fresh quote")
        .action(async (options) => {
        options.poolId = await (0, prompt_1.promptIfMissing)(options.poolId, "CPMM pool address");
        options.inputMint = await (0, prompt_1.promptIfMissing)(options.inputMint, "Input token mint");
        options.amount = await (0, prompt_1.promptNumberIfMissing)(options.amount, "Maximum input token amount", (input) => Number.isFinite(Number(input)) && Number(input) > 0 ? true : "Enter a positive amount");
        let poolId;
        let inputMint;
        try {
            poolId = new web3_js_1.PublicKey(options.poolId);
            inputMint = new web3_js_1.PublicKey(options.inputMint);
        }
        catch {
            (0, output_1.logError)("A valid --pool-id and --input-mint address are required");
            process.exitCode = 1;
            return;
        }
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        let slippagePercent;
        let priorityFeeMicroLamports;
        try {
            slippagePercent = (0, swap_guards_1.parseSlippagePercent)(options.slippage ?? String(config["default-slippage"]), Boolean(options.allowHighSlippage)).toNumber();
            priorityFeeMicroLamports = (0, swap_guards_1.parsePriorityFeeMicroLamports)(options.priorityFee ?? String(config["priority-fee"]), Boolean(options.allowHighPriorityFee));
        }
        catch (error) {
            (0, output_1.logError)(error instanceof Error ? error.message : "Invalid liquidity safety setting");
            process.exitCode = 1;
            return;
        }
        const slippage = toCpmmSlippageFraction(slippagePercent);
        const buildQuote = async (raydium) => {
            const data = await raydium.cpmm.getPoolInfoFromRpc(poolId.toBase58());
            const { poolInfo, poolKeys, rpcData } = data;
            const mintA = new web3_js_1.PublicKey(poolInfo.mintA.address);
            const mintB = new web3_js_1.PublicKey(poolInfo.mintB.address);
            if (!inputMint.equals(mintA) && !inputMint.equals(mintB)) {
                throw new Error("Input mint does not belong to this CPMM pool");
            }
            const baseIn = inputMint.equals(mintA);
            const inputToken = baseIn ? poolInfo.mintA : poolInfo.mintB;
            const otherToken = baseIn ? poolInfo.mintB : poolInfo.mintA;
            const inputAmount = parseUiAmount(options.amount, inputToken.decimals, "Amount");
            const compute = raydium.cpmm.computePairAmount({
                poolInfo,
                baseReserve: rpcData.baseReserve,
                quoteReserve: rpcData.quoteReserve,
                amount: options.amount,
                slippage: new raydium_sdk_v2_1.Percent(0),
                epochInfo: await raydium.fetchEpochInfo(),
                baseIn
            });
            const minimumLiquidity = new raydium_sdk_v2_1.Percent(new bn_js_1.default(1)).sub(slippage).mul(compute.liquidity).quotient;
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
            const raydium = await (0, output_1.withSpinner)("Loading Raydium", () => (0, raydium_client_1.loadRaydium)({ disableLoadToken: true }));
            const quoteData = await (0, output_1.withSpinner)("Fetching CPMM liquidity quote", () => buildQuote(raydium));
            if (!options.execute) {
                const approvedQuote = (0, quote_approval_1.withQuoteApprovalId)("cpmm-liquidity-add-quote", quoteData.quote);
                if ((0, output_1.isJsonOutput)()) {
                    (0, output_1.logJson)({ action: "cpmm-liquidity-add-quote", ...approvedQuote });
                }
                else {
                    (0, output_1.logInfo)(`CPMM liquidity quote for ${quoteData.quote.pair}`);
                    (0, output_1.logInfo)(`Input: ${quoteData.quote.input.amount}`);
                    (0, output_1.logInfo)(`Estimated other token: ${quoteData.quote.estimatedOtherToken.amount}`);
                    (0, output_1.logInfo)(`Minimum LP tokens: ${quoteData.quote.minimumLpTokens.amount}`);
                    (0, output_1.logInfo)(`Quote ID: ${approvedQuote.quoteId}`);
                    (0, output_1.logInfo)("Quote only. Re-run with --execute to build, simulate, review, and send.");
                }
                return;
            }
            const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
            if (!walletName)
                throw new Error("No active wallet set");
            const password = await (0, prompt_1.promptPassword)("Enter wallet password");
            const owner = await (0, wallet_manager_1.decryptWallet)(walletName, password);
            const signingRaydium = await (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true });
            const fresh = await (0, output_1.withSpinner)("Refreshing CPMM liquidity quote", () => buildQuote(signingRaydium));
            const built = await (0, output_1.withSpinner)("Building CPMM liquidity deposit", () => signingRaydium.cpmm.addLiquidity({
                poolInfo: fresh.poolInfo,
                poolKeys: fresh.poolKeys,
                inputAmount: fresh.inputAmount,
                baseIn: fresh.baseIn,
                slippage,
                txVersion: raydium_sdk_v2_1.TxVersion.V0,
                computeBudgetConfig: priorityFeeMicroLamports > 0
                    ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
                    : undefined
            }));
            if (!(built.transaction instanceof web3_js_1.VersionedTransaction)) {
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
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("CPMM liquidity deposit failed", getCpmmOperationError(error));
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
        .action(async (options) => {
        options.poolId = await (0, prompt_1.promptIfMissing)(options.poolId, "CPMM pool address");
        options.lpAmount = await (0, prompt_1.promptNumberIfMissing)(options.lpAmount, "LP token amount to burn", (input) => Number.isFinite(Number(input)) && Number(input) > 0 ? true : "Enter a positive amount");
        let poolId;
        try {
            poolId = new web3_js_1.PublicKey(options.poolId);
        }
        catch {
            (0, output_1.logError)("Invalid --pool-id address");
            process.exitCode = 1;
            return;
        }
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        let slippagePercent;
        let priorityFeeMicroLamports;
        try {
            slippagePercent = (0, swap_guards_1.parseSlippagePercent)(options.slippage ?? String(config["default-slippage"]), Boolean(options.allowHighSlippage)).toNumber();
            priorityFeeMicroLamports = (0, swap_guards_1.parsePriorityFeeMicroLamports)(options.priorityFee ?? String(config["priority-fee"]), Boolean(options.allowHighPriorityFee));
        }
        catch (error) {
            (0, output_1.logError)(error instanceof Error ? error.message : "Invalid liquidity safety setting");
            process.exitCode = 1;
            return;
        }
        const slippage = toCpmmSlippageFraction(slippagePercent);
        const buildQuote = async (raydium) => {
            const data = await raydium.cpmm.getPoolInfoFromRpc(poolId.toBase58());
            const { poolInfo, poolKeys, rpcData } = data;
            const lpAmount = parseUiAmount(options.lpAmount, poolInfo.lpMint.decimals, "LP amount");
            if (lpAmount.gt(rpcData.lpAmount))
                throw new Error("LP amount exceeds the pool LP-token supply");
            const epochInfo = await raydium.fetchEpochInfo();
            const minimumAmountA = new raydium_sdk_v2_1.Percent(new bn_js_1.default(1)).sub(slippage)
                .mul(lpAmount.mul(rpcData.baseReserve).div(rpcData.lpAmount)).quotient;
            const minimumAmountB = new raydium_sdk_v2_1.Percent(new bn_js_1.default(1)).sub(slippage)
                .mul(lpAmount.mul(rpcData.quoteReserve).div(rpcData.lpAmount)).quotient;
            const receivedA = minimumAmountA.sub((0, raydium_sdk_v2_1.getTransferAmountFeeV2)(minimumAmountA, poolInfo.mintA.extensions.feeConfig, epochInfo, false).fee ?? new bn_js_1.default(0));
            const receivedB = minimumAmountB.sub((0, raydium_sdk_v2_1.getTransferAmountFeeV2)(minimumAmountB, poolInfo.mintB.extensions.feeConfig, epochInfo, false).fee ?? new bn_js_1.default(0));
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
            const raydium = await (0, output_1.withSpinner)("Loading Raydium", () => (0, raydium_client_1.loadRaydium)({ disableLoadToken: true }));
            const quoteData = await (0, output_1.withSpinner)("Fetching CPMM withdrawal quote", () => buildQuote(raydium));
            if (!options.execute) {
                const approvedQuote = (0, quote_approval_1.withQuoteApprovalId)("cpmm-liquidity-remove-quote", quoteData.quote);
                if ((0, output_1.isJsonOutput)()) {
                    (0, output_1.logJson)({ action: "cpmm-liquidity-remove-quote", ...approvedQuote });
                }
                else {
                    (0, output_1.logInfo)(`CPMM withdrawal quote for ${quoteData.quote.pair}`);
                    (0, output_1.logInfo)(`Burn LP tokens: ${quoteData.quote.lpTokensBurned.amount}`);
                    (0, output_1.logInfo)(`Minimum receipts: ${quoteData.quote.minimumReceipts.mintA.amount} / ${quoteData.quote.minimumReceipts.mintB.amount}`);
                    (0, output_1.logInfo)(`Quote ID: ${approvedQuote.quoteId}`);
                    (0, output_1.logInfo)("Quote only. Re-run with --execute to build, simulate, review, and send.");
                }
                return;
            }
            const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
            if (!walletName)
                throw new Error("No active wallet set");
            const password = await (0, prompt_1.promptPassword)("Enter wallet password");
            const owner = await (0, wallet_manager_1.decryptWallet)(walletName, password);
            const signingRaydium = await (0, raydium_client_1.loadRaydium)({ owner, disableLoadToken: true });
            const fresh = await (0, output_1.withSpinner)("Refreshing CPMM withdrawal quote", () => buildQuote(signingRaydium));
            const built = await (0, output_1.withSpinner)("Building CPMM liquidity withdrawal", () => signingRaydium.cpmm.withdrawLiquidity({
                poolInfo: fresh.poolInfo,
                poolKeys: fresh.poolKeys,
                lpAmount: fresh.lpAmount,
                slippage,
                closeWsol: !options.keepWsol,
                txVersion: raydium_sdk_v2_1.TxVersion.V0,
                computeBudgetConfig: priorityFeeMicroLamports > 0
                    ? { units: DEFAULT_COMPUTE_UNITS, microLamports: priorityFeeMicroLamports }
                    : undefined
            }));
            if (!(built.transaction instanceof web3_js_1.VersionedTransaction)) {
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
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("CPMM liquidity withdrawal failed", getCpmmOperationError(error));
            process.exitCode = 1;
        }
    });
}
exports.registerCpmmCommands = registerCpmmCommands;
