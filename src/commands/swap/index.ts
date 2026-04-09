import { Command } from "commander";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import Decimal from "decimal.js";
import {
  AMM_STABLE,
  AMM_V4,
  ApiV3PoolInfoStandardItem,
  AmmRpcData,
  AmmV4Keys,
  DEVNET_PROGRAM_ID,
  Token,
  TokenAmount,
  TxVersion
} from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { loadConfig } from "../../lib/config-manager";
import { decryptWallet, resolveWalletIdentifier } from "../../lib/wallet-manager";
import { promptConfirm, promptPassword } from "../../lib/prompt";
import { isJsonOutput, logError, logErrorWithDebug, logInfo, logJson, logSuccess, withSpinner } from "../../lib/output";
import { loadRaydium } from "../../lib/raydium-client";
import { getConnection } from "../../lib/connection";
import { getApiUrlsForCluster } from "../../lib/api-urls";
import { addRichHelp, NON_INTERACTIVE_HELP, PASSWORD_AUTH_HELP } from "../../lib/help";

// Trade API types
interface TradeApiQuoteResponse {
  id: string;
  success: boolean;
  data: {
    swapType: "BaseIn" | "BaseOut";
    inputMint: string;
    inputAmount: string;
    outputMint: string;
    outputAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
    priceImpactPct: number;
    routePlan: Array<{
      poolId: string;
      inputMint: string;
      outputMint: string;
      feeRate: number;
      feeAmount: string;
    }>;
  };
}

interface TradeApiTxResponse {
  id: string;
  success: boolean;
  data: Array<{ transaction: string }>;
}

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const VALID_AMM_PROGRAM_IDS = new Set([
  AMM_V4.toBase58(),
  AMM_STABLE.toBase58(),
  DEVNET_PROGRAM_ID.AMM_V4.toBase58(),
  DEVNET_PROGRAM_ID.AMM_STABLE.toBase58()
]);

function buildTokenFromInfo(info: {
  address: string;
  decimals: number;
  symbol?: string;
  name?: string;
  programId?: string;
}): Token {
  const isToken2022 = info.programId === TOKEN_2022_PROGRAM_ID.toBase58();
  return new Token({
    mint: info.address,
    decimals: info.decimals,
    symbol: info.symbol,
    name: info.name,
    isToken2022
  });
}

// Trade API functions
const DEFAULT_COMPUTE_UNITS = 600_000;
const CONFIRMATION_POLL_INTERVAL_MS = 1_200;
const CONFIRMATION_TIMEOUT_MS = 60_000;
const SEND_RETRY_COUNT = 3;

function parseUiAmountToAtomic(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("Amount must be a positive decimal number");
  }

  const parsed = new Decimal(normalized);
  if (!parsed.isFinite() || parsed.lte(0)) {
    throw new Error("Amount must be greater than zero");
  }

  const scaled = parsed.mul(new Decimal(10).pow(decimals));
  if (!scaled.isInteger()) {
    throw new Error(`Amount has more than ${decimals} decimal places`);
  }

  return BigInt(scaled.toFixed(0));
}

function formatAtomicAmount(rawAmount: string, decimals: number): string {
  const negative = rawAmount.startsWith("-");
  const digits = negative ? rawAmount.slice(1) : rawAmount;
  if (decimals <= 0) return rawAmount;

  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fractional = padded.slice(-decimals).replace(/0+$/, "");
  const formatted = fractional ? `${whole}.${fractional}` : whole;
  return negative ? `-${formatted}` : formatted;
}

function formatDisplayAmount(rawAmount: string, decimals: number, places = 6): string {
  const exact = formatAtomicAmount(rawAmount, decimals);
  const decimal = new Decimal(exact);
  if (decimal.isZero()) return "0";
  return decimal.toDecimalPlaces(places, Decimal.ROUND_DOWN).toString();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmedSignature(
  connection: Awaited<ReturnType<typeof getConnection>>,
  signature: string,
  blockhash: string
): Promise<void> {
  const startedAt = Date.now();

  for (;;) {
    const statusResponse = await connection.getSignatureStatuses([signature]);
    const status = statusResponse.value[0];
    if (status?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }

    const blockhashValid = await connection.isBlockhashValid(blockhash, {
      commitment: "confirmed"
    });
    if (!blockhashValid) {
      throw new Error(`Transaction blockhash expired before confirmation: ${signature}`);
    }

    if (Date.now() - startedAt > CONFIRMATION_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for confirmation: ${signature}`);
    }

    await sleep(CONFIRMATION_POLL_INTERVAL_MS);
  }
}

async function sendAndConfirmVersionedTransaction(
  connection: Awaited<ReturnType<typeof getConnection>>,
  tx: VersionedTransaction
): Promise<string> {
  const serialized = tx.serialize();
  const blockhash = tx.message.recentBlockhash;
  let lastError: unknown;

  for (let attempt = 1; attempt <= SEND_RETRY_COUNT; attempt += 1) {
    try {
      const signature = await connection.sendRawTransaction(serialized, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3
      });
      await waitForConfirmedSignature(connection, signature, blockhash);
      return signature;
    } catch (error) {
      lastError = error;
      const blockhashValid = await connection.isBlockhashValid(blockhash, {
        commitment: "confirmed"
      });
      if (!blockhashValid || attempt === SEND_RETRY_COUNT) {
        throw error;
      }
      await sleep(CONFIRMATION_POLL_INTERVAL_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Transaction failed");
}

async function fetchTradeQuote(params: {
  host: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}): Promise<TradeApiQuoteResponse> {
  const url = `${params.host}/compute/swap-base-in?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps}&txVersion=V0`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trade API error: HTTP ${res.status} - ${text}`);
  }
  const json = await res.json() as TradeApiQuoteResponse & { msg?: string; message?: string; error?: string };
  if (!json.success) {
    const errDetail = json.msg || json.message || json.error || JSON.stringify(json);
    throw new Error(`Trade API quote failed: ${errDetail}`);
  }
  return json;
}

async function serializeSwapTx(params: {
  host: string;
  swapResponse: TradeApiQuoteResponse;
  wallet: string;
  wrapSol: boolean;
  unwrapSol: boolean;
  inputAccount?: string;
  outputAccount?: string;
  computeUnitPriceMicroLamports: number;
}): Promise<TradeApiTxResponse> {
  const res = await fetch(`${params.host}/transaction/swap-base-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      swapResponse: params.swapResponse,
      wallet: params.wallet,
      txVersion: "V0",
      wrapSol: params.wrapSol,
      unwrapSol: params.unwrapSol,
      inputAccount: params.inputAccount,
      outputAccount: params.outputAccount,
      computeUnitPriceMicroLamports: String(params.computeUnitPriceMicroLamports)
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trade API serialize error: HTTP ${res.status} - ${text}`);
  }
  const json = await res.json() as TradeApiTxResponse & { msg?: string; message?: string; error?: string };
  if (!json.success) {
    const errDetail = json.msg || json.message || json.error || JSON.stringify(json);
    throw new Error(`Trade API serialize failed: ${errDetail}`);
  }
  return json;
}

async function getTokenDecimals(mint: string): Promise<number> {
  if (mint === WRAPPED_SOL_MINT) return 9;
  const connection = await getConnection();
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  if (!info.value || !("parsed" in info.value.data)) {
    throw new Error(`Could not fetch mint info for ${mint}`);
  }
  return (info.value.data as { parsed: { info: { decimals: number } } }).parsed.info.decimals;
}

export function registerSwapCommands(program: Command): void {
  // Trade API swap (auto-routing)
  const tradeApiSwap = async (options: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippage: number;
    slippagePercent: number;
    priorityFeeMicroLamports: number;
    owner: Keypair;
    debug?: boolean;
  }) => {
    const inputMintStr = options.inputMint;
    const outputMintStr = options.outputMint;
    const config = await loadConfig({ createIfMissing: true });
    const tradeApiHost = getApiUrlsForCluster(config.cluster).SWAP_HOST;

    // Get input token decimals and convert amount to lamports
    const inputDecimals = await withSpinner("Fetching token info", () =>
      getTokenDecimals(inputMintStr)
    );
    const amountLamports = parseUiAmountToAtomic(options.amount, inputDecimals);

    // Fetch quote from Trade API
    const slippageBps = Math.round(options.slippage * 10000);
    let quote: TradeApiQuoteResponse;
    try {
      quote = await withSpinner("Fetching swap quote", () =>
        fetchTradeQuote({
          host: tradeApiHost,
          inputMint: inputMintStr,
          outputMint: outputMintStr,
          amount: amountLamports.toString(),
          slippageBps
        })
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError("Failed to fetch quote", msg);
      process.exitCode = 1;
      return;
    }

    // Get output token decimals for display
    const outputDecimals = await getTokenDecimals(outputMintStr);
    const estimatedOutput = formatAtomicAmount(quote.data.outputAmount, outputDecimals);
    const minimumOutput = formatAtomicAmount(quote.data.otherAmountThreshold, outputDecimals);

    // Format route display
    const routeDisplay = quote.data.routePlan.length > 1
      ? `${quote.data.routePlan.length}-hop via ${quote.data.routePlan.map(r => r.poolId.slice(0, 4) + "..." + r.poolId.slice(-3)).join(" -> ")}`
      : `Direct via ${quote.data.routePlan[0]?.poolId.slice(0, 4)}...${quote.data.routePlan[0]?.poolId.slice(-3)}`;

    if (isJsonOutput()) {
      logJson({
        route: quote.data.routePlan.map(r => r.poolId),
        input: { amount: options.amount, mint: inputMintStr },
        output: {
          estimated: estimatedOutput,
          minimum: minimumOutput,
          mint: outputMintStr
        },
        priceImpactPct: quote.data.priceImpactPct,
        slippage: options.slippage
      });
    } else {
      logInfo(`Route: ${routeDisplay}`);
      logInfo(`Input: ${options.amount} (${inputMintStr.slice(0, 6)}...)`);
      logInfo(
        `Estimated output: ${formatDisplayAmount(quote.data.outputAmount, outputDecimals)} (${outputMintStr.slice(0, 6)}...)`
      );
      logInfo(
        `Minimum output: ${formatDisplayAmount(quote.data.otherAmountThreshold, outputDecimals)}`
      );
      logInfo(`Price impact: ${quote.data.priceImpactPct.toFixed(2)}%`);
      logInfo(`Slippage: ${options.slippagePercent}%`);
    }

    const ok = await promptConfirm("Proceed with swap?", false);
    if (!ok) {
      logInfo("Cancelled");
      return;
    }

    // Serialize transaction
    const inputIsSol = inputMintStr === WRAPPED_SOL_MINT;
    const outputIsSol = outputMintStr === WRAPPED_SOL_MINT;

    // Get token accounts (ATAs) for non-SOL tokens
    const inputAccount = inputIsSol
      ? undefined
      : getAssociatedTokenAddressSync(new PublicKey(inputMintStr), options.owner.publicKey).toBase58();
    const outputAccount = outputIsSol
      ? undefined
      : getAssociatedTokenAddressSync(new PublicKey(outputMintStr), options.owner.publicKey).toBase58();

    let txResponse: TradeApiTxResponse;
    try {
      txResponse = await withSpinner("Building swap transaction", () =>
        serializeSwapTx({
          host: tradeApiHost,
          swapResponse: quote,
          wallet: options.owner.publicKey.toBase58(),
          wrapSol: inputIsSol,
          unwrapSol: outputIsSol,
          inputAccount,
          outputAccount,
          computeUnitPriceMicroLamports: options.priorityFeeMicroLamports
        })
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError("Failed to build transaction", msg);
      process.exitCode = 1;
      return;
    }

    // Sign and send transactions
    const connection = await getConnection();
    const txIds: string[] = [];

    try {
      for (const txData of txResponse.data) {
        const txBuf = Buffer.from(txData.transaction, "base64");
        const tx = VersionedTransaction.deserialize(txBuf);
        tx.sign([options.owner]);

        const txId = await withSpinner("Sending transaction", () =>
          sendAndConfirmVersionedTransaction(connection, tx)
        );
        txIds.push(txId);
      }
    } catch (error) {
      logErrorWithDebug("Swap failed", error, { debug: options.debug, fallback: "Swap failed" });
      process.exitCode = 1;
      return;
    }

    if (isJsonOutput()) {
      logJson({ txIds });
    } else {
      for (const txId of txIds) {
        logSuccess(`Swap submitted: ${txId}`);
      }
    }
  };

  // Direct AMM swap (existing logic)
  const directAmmSwap = async (options: {
    poolId: string;
    inputMint: string;
    outputMint?: string;
    amount: string;
    slippage: number;
    slippagePercent: number;
    priorityFeeMicroLamports: number;
    owner: Keypair;
    debug?: boolean;
  }) => {
    let poolId: string;
    let inputMint: PublicKey;
    let outputMint: PublicKey | undefined;
    try {
      poolId = new PublicKey(options.poolId).toBase58();
      inputMint = new PublicKey(options.inputMint);
      outputMint = options.outputMint ? new PublicKey(options.outputMint) : undefined;
    } catch {
      logError("Invalid pool or mint address");
      process.exitCode = 1;
      return;
    }

    const raydium = await withSpinner("Loading Raydium", () => loadRaydium({ owner: options.owner, disableLoadToken: true }));

    let poolInfo: ApiV3PoolInfoStandardItem;
    let poolKeys: AmmV4Keys;
    let rpcData: AmmRpcData;

    if (raydium.cluster === "mainnet") {
      try {
        const data = await withSpinner("Fetching pool info", async () => {
          const apiData = await raydium.api.fetchPoolById({ ids: poolId });
          const info = apiData[0] as ApiV3PoolInfoStandardItem;
          if (!info) throw new Error("Pool not found");
          if (!VALID_AMM_PROGRAM_IDS.has(info.programId)) throw new Error("Pool is not a standard AMM pool");
          const keys = await raydium.liquidity.getAmmPoolKeys(poolId);
          const rpc = await raydium.liquidity.getRpcPoolInfo(poolId);
          return { info, keys, rpc };
        });
        poolInfo = data.info;
        poolKeys = data.keys;
        rpcData = data.rpc;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logError("Failed to fetch pool info", msg);
        process.exitCode = 1;
        return;
      }
    } else {
      const data = await withSpinner("Fetching pool info", () =>
        raydium.liquidity.getPoolInfoFromRpc({ poolId })
      );
      if (!data.poolInfo) {
        logError("Pool not found");
        process.exitCode = 1;
        return;
      }
      if (!VALID_AMM_PROGRAM_IDS.has(data.poolInfo.programId)) {
        logError("Pool is not a standard AMM pool");
        process.exitCode = 1;
        return;
      }
      poolInfo = data.poolInfo as ApiV3PoolInfoStandardItem;
      poolKeys = data.poolKeys as AmmV4Keys;
      rpcData = data.poolRpcData as AmmRpcData;
    }

    const mintA = poolInfo.mintA;
    const mintB = poolInfo.mintB;
    const mintAAddress = mintA.address;
    const mintBAddress = mintB.address;

    const inputMintStr = inputMint.toBase58();
    if (inputMintStr !== mintAAddress && inputMintStr !== mintBAddress) {
      logError("Input mint does not match pool mints");
      process.exitCode = 1;
      return;
    }

    const derivedOutputMint = inputMintStr === mintAAddress ? mintBAddress : mintAAddress;
    const outputMintStr = outputMint ? outputMint.toBase58() : derivedOutputMint;
    if (outputMintStr !== derivedOutputMint) {
      logError("Output mint does not match pool mints");
      process.exitCode = 1;
      return;
    }

    const inputTokenInfo = inputMintStr === mintAAddress ? mintA : mintB;
    const outputTokenInfo = inputMintStr === mintAAddress ? mintB : mintA;

    const inputToken = buildTokenFromInfo(inputTokenInfo);
    const inputTokenAmount = new TokenAmount(inputToken, options.amount, false);

    const computeOut = raydium.liquidity.computeAmountOut({
      poolInfo: {
        ...poolInfo,
        baseReserve: rpcData.baseReserve,
        quoteReserve: rpcData.quoteReserve,
        status: rpcData.status.toNumber(),
        version: 4
      },
      amountIn: inputTokenAmount.raw,
      mintIn: inputMintStr,
      mintOut: outputMintStr,
      slippage: options.slippage
    });

    const outputToken = buildTokenFromInfo(outputTokenInfo);
    const estimatedOut = new TokenAmount(outputToken, computeOut.amountOut, true);
    const minOut = new TokenAmount(outputToken, computeOut.minAmountOut, true);
    const outSymbol =
      outputTokenInfo.symbol || outputTokenInfo.name || outputTokenInfo.address.slice(0, 6);
    const inSymbol =
      inputTokenInfo.symbol || inputTokenInfo.name || inputTokenInfo.address.slice(0, 6);

    if (isJsonOutput()) {
      logJson({
        poolId,
        input: { amount: options.amount, symbol: inSymbol, mint: inputTokenInfo.address },
        output: {
          estimated: estimatedOut.toExact(),
          minimum: minOut.toExact(),
          symbol: outSymbol,
          mint: outputTokenInfo.address
        },
        slippage: options.slippage
      });
    } else {
      logInfo(`Pool: ${poolId}`);
      logInfo(`Input: ${options.amount} ${inSymbol}`);
      logInfo(`Estimated output: ${estimatedOut.toExact()} ${outSymbol}`);
      logInfo(`Minimum output: ${minOut.toExact()} ${outSymbol}`);
      logInfo(`Slippage: ${options.slippagePercent}%`);
    }

    const ok = await promptConfirm("Proceed with swap?", false);
    if (!ok) {
      logInfo("Cancelled");
      return;
    }

    const computeBudgetConfig =
      options.priorityFeeMicroLamports > 0 ? { units: DEFAULT_COMPUTE_UNITS, microLamports: options.priorityFeeMicroLamports } : undefined;

    const inputIsSol = inputMintStr === WRAPPED_SOL_MINT;
    const outputIsSol = outputMintStr === WRAPPED_SOL_MINT;
    const txData = await withSpinner("Building swap transaction", () =>
      raydium.liquidity.swap({
        txVersion: TxVersion.V0,
        poolInfo,
        poolKeys,
        amountIn: inputTokenAmount.raw,
        amountOut: computeOut.minAmountOut,
        inputMint: inputMintStr,
        fixedSide: "in",
        config: {
          associatedOnly: true,
          inputUseSolBalance: inputIsSol,
          outputUseSolBalance: outputIsSol
        },
        computeBudgetConfig
      }),
    );

    let result: { txId: string };
    try {
      result = await withSpinner("Sending transaction", () => txData.execute({ sendAndConfirm: true }));
    } catch (error) {
      logErrorWithDebug("Swap failed", error, { debug: options.debug, fallback: "Swap failed" });
      process.exitCode = 1;
      return;
    }

    if (isJsonOutput()) {
      logJson({ txId: result.txId });
    } else {
      logSuccess(`Swap submitted: ${result.txId}`);
    }
  };

  const swapAction = async (options: {
    poolId?: string;
    inputMint?: string;
    outputMint?: string;
    amount?: string;
    slippage?: string;
    priorityFee?: string;
    debug?: boolean;
  }) => {
    // Validate required options based on mode
    if (!options.inputMint || !options.amount) {
      logError("Missing required options: --input-mint, --amount");
      process.exitCode = 1;
      return;
    }

    // If no pool-id, require output-mint for Trade API routing
    if (!options.poolId && !options.outputMint) {
      logError("--output-mint is required when --pool-id is not provided");
      process.exitCode = 1;
      return;
    }

    const config = await loadConfig({ createIfMissing: true });
    const slippagePercent = options.slippage ? Number(options.slippage) : config["default-slippage"];
    if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
      logError("Invalid slippage percent");
      process.exitCode = 1;
      return;
    }
    const slippage = slippagePercent / 100;

    const priorityFeeSol = options.priorityFee ? Number(options.priorityFee) : config["priority-fee"];
    if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0) {
      logError("Invalid priority fee");
      process.exitCode = 1;
      return;
    }
    const DEFAULT_COMPUTE_UNITS = 600_000;
    const priorityFeeLamports = priorityFeeSol * 1e9;
    const priorityFeeMicroLamports = Math.round((priorityFeeLamports * 1e6) / DEFAULT_COMPUTE_UNITS);

    const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
    if (!walletName) {
      logError("No active wallet set");
      process.exitCode = 1;
      return;
    }

    // Validate mint addresses
    try {
      new PublicKey(options.inputMint);
      if (options.outputMint) new PublicKey(options.outputMint);
      if (options.poolId) new PublicKey(options.poolId);
    } catch {
      logError("Invalid mint or pool address");
      process.exitCode = 1;
      return;
    }

    try {
      const parsedAmount = new Decimal(options.amount);
      if (!parsedAmount.isFinite() || parsedAmount.lte(0)) {
        throw new Error("Amount must be greater than zero");
      }
    } catch (error) {
      logError(error instanceof Error ? error.message : "Invalid amount");
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

    // Route to appropriate swap method
    if (options.poolId) {
      // Direct AMM swap
      await directAmmSwap({
        poolId: options.poolId,
        inputMint: options.inputMint,
        outputMint: options.outputMint,
        amount: options.amount,
        slippage,
        slippagePercent,
        priorityFeeMicroLamports,
        owner,
        debug: options.debug
      });
    } else {
      // Trade API swap (auto-routing)
      await tradeApiSwap({
        inputMint: options.inputMint,
        outputMint: options.outputMint!,
        amount: options.amount,
        slippage,
        slippagePercent,
        priorityFeeMicroLamports,
        owner,
        debug: options.debug
      });
    }
  };

  addRichHelp(
    program
      .command("swap")
    .description("Swap tokens (omit --pool-id for auto-routing via Trade API)")
    .option("--pool-id <pool>", "AMM pool address (omit for auto-routing)")
    .requiredOption("--input-mint <mint>", "Input token mint")
    .requiredOption("--amount <number>", "Amount to swap")
    .option("--output-mint <mint>", "Output token mint (required if --pool-id not provided)")
    .option("--slippage <percent>", "Slippage tolerance")
    .option("--priority-fee <sol>", "Priority fee in SOL")
    .option("--debug", "Print full error object on failure"),
    {
      summary: [
        "Omit --pool-id to use Raydium Trade API auto-routing.",
        "Provide --pool-id for a direct standard AMM swap against a specific pool."
      ],
      auth: PASSWORD_AUTH_HELP,
      units: [
        "--amount is a decimal UI amount in input-token units, not raw atomic units.",
        "--slippage is a percent such as 0.5 for 0.5%.",
        "--priority-fee is in SOL."
      ],
      defaults: [
        "Cluster-aware Trade API and RPC behavior follows the configured cluster.",
        "--output-mint is required only when auto-routing without --pool-id.",
        "Use So11111111111111111111111111111111111111112 for SOL."
      ],
      nonInteractive: NON_INTERACTIVE_HELP,
      examples: [
        "raydium swap --input-mint So11111111111111111111111111111111111111112 --output-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --amount 0.001",
        "raydium swap --pool-id <amm-pool-id> --input-mint <mint-a> --amount 12.5",
        "printf '%s' 'wallet-password' | raydium --json --yes --password-stdin swap --input-mint <mint-a> --output-mint <mint-b> --amount 1.25"
      ]
    }
  )
    .action(swapAction);
}
