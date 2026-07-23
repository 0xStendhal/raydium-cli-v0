import { Command, Option } from "commander";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import Decimal from "decimal.js";
import {
  AMM_STABLE,
  AMM_V4,
  CLMM_PROGRAM_ID,
  CREATE_CPMM_POOL_PROGRAM,
  ApiV3PoolInfoStandardItem,
  AmmRpcData,
  AmmV4Keys,
  AmmV5Keys,
  DEVNET_PROGRAM_ID,
  Token,
  TokenAmount,
  TxVersion,
  Router
} from "@raydium-io/raydium-sdk-v2";
import {
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";

import { loadConfig } from "../../lib/config-manager";
import { decryptWallet, getWalletPublicKey, resolveWalletIdentifier } from "../../lib/wallet-manager";
import {
  canPromptInteractively,
  promptActionConfirmation,
  promptPassword
} from "../../lib/prompt";
import { isJsonOutput, logError, logErrorWithDebug, logGuidedError, logInfo, logJson, logSuccess, withSpinner } from "../../lib/output";
import { loadRaydium } from "../../lib/raydium-client";
import { getConnection } from "../../lib/connection";
import { getApiUrlsForCluster } from "../../lib/api-urls";
import { resolveMintAddress } from "../../lib/mint-resolver";
import {
  addRichHelp,
  AUTOMATION_HELP,
  outputHelpWithAdvancedOptions,
  PASSWORD_AUTH_HELP
} from "../../lib/help";
import { getTransactionExplorerUrl, offerTransactionExplorer } from "../../lib/explorer";
import {
  assertTransactionPriorityFeeBudget,
  sendAndConfirmVersionedTransaction,
  simulateVersionedTransaction,
  summarizeVersionedTransaction,
  validateVersionedTransactionPolicy
} from "../../lib/safe-transaction";
import {
  MAX_SAFE_PRIORITY_FEE_SOL,
  MAX_SAFE_SLIPPAGE_PERCENT,
  parsePriorityFeeMicroLamports,
  parseSlippagePercent
} from "../../lib/swap-guards";
import { assertJsonQuoteApproval, withQuoteApprovalId } from "../../lib/quote-approval";
import { fetchRpcBalances, RpcBalance } from "../../lib/balances";
import { shortenAddress } from "../../lib/context";
import { explainError } from "../../lib/errors";
import { renderReviewPanel, ReviewRow } from "../../lib/review";
import {
  isWizardNavigation,
  promptWizardInput,
  promptWizardSelect,
  runWizard,
  WIZARD_BACK,
  WizardNavigation,
  WizardStep
} from "../../lib/wizard";

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

type TradeApiSwapMode = "base-in" | "base-out";

interface TradeApiTxResponse {
  id: string;
  success: boolean;
  data: Array<{ transaction: string }>;
}

const MAX_PRIORITY_FEE_LAMPORTS = 100_000_000n;
const SIGNATURE_FEE_LAMPORTS = 5_000n;
// Headroom for rent the route may spend on token accounts it creates
// (an ATA costs ~2_039_280 lamports; multi-hop routes may create several).
const SWAP_RENT_ALLOWANCE_LAMPORTS = 10_000_000n;

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CUSTOM_MINT = "__custom_mint__";
const HIGH_PRICE_IMPACT_PERCENT = 5;
const VALID_AMM_PROGRAM_IDS = new Set([
  AMM_V4.toBase58(),
  AMM_STABLE.toBase58(),
  DEVNET_PROGRAM_ID.AMM_V4.toBase58(),
  DEVNET_PROGRAM_ID.AMM_STABLE.toBase58()
]);

type SwapTokenChoice = {
  mint: string;
  label: string;
};

type SwapWizardValues = {
  inputMint: string;
  outputMint: string;
  amount: string;
  execute: boolean;
};

type SwapConfirmationPolicy = {
  dangerous: boolean;
  warnings: string[];
};

type OwnerTokenAccount = {
  address: string;
  amount: bigint;
  isAssociated: boolean;
};

type OwnerTokenAccountResolution = {
  associatedAddress: string;
  account?: OwnerTokenAccount;
};

function reportSwapError(fallback: string, error: unknown, debug?: boolean): void {
  const guidance = explainError(error, fallback);
  logGuidedError({
    message: guidance.message,
    code: guidance.code,
    details: guidance.details,
    hints: guidance.hints,
    debug
  });
}

function buildSwapTokenChoices(
  balances: RpcBalance[],
  cluster: "mainnet" | "devnet",
  includeCommonTokens: boolean
): SwapTokenChoice[] {
  const choices = new Map<string, SwapTokenChoice>();

  for (const balance of balances) {
    const mint = balance.mint === "SOL" ? WRAPPED_SOL_MINT : balance.mint;
    const knownSymbol = mint === WRAPPED_SOL_MINT
      ? "SOL"
      : mint === MAINNET_USDC_MINT
        ? "USDC"
        : balance.symbol;
    choices.set(mint, {
      mint,
      label: `${knownSymbol} - ${balance.amount} available (${shortenAddress(mint)})`
    });
  }

  if (!choices.has(WRAPPED_SOL_MINT)) {
    choices.set(WRAPPED_SOL_MINT, {
      mint: WRAPPED_SOL_MINT,
      label: `SOL (${shortenAddress(WRAPPED_SOL_MINT)})`
    });
  }
  if (includeCommonTokens && cluster === "mainnet" && !choices.has(MAINNET_USDC_MINT)) {
    choices.set(MAINNET_USDC_MINT, {
      mint: MAINNET_USDC_MINT,
      label: `USDC (${shortenAddress(MAINNET_USDC_MINT)})`
    });
  }

  return Array.from(choices.values());
}

async function promptForSwapToken(
  message: string,
  choices: SwapTokenChoice[],
  options: { excludedMint?: string; allowBack?: boolean }
): Promise<string | WizardNavigation> {
  for (;;) {
    const available = choices.filter((choice) => choice.mint !== options.excludedMint);
    const selected = await promptWizardSelect(message, [
      ...available.map((choice) => ({ name: choice.label, value: choice.mint })),
      { name: "Enter a token mint...", value: CUSTOM_MINT }
    ], { allowBack: options.allowBack });

    if (isWizardNavigation(selected) || selected !== CUSTOM_MINT) return selected;
    const customMint = await promptWizardInput("Token mint", {
      allowBack: true,
      validate: (value) => {
        try {
          const mint = new PublicKey(value).toBase58();
          return mint === options.excludedMint
            ? "Input and output tokens must be different"
            : true;
        } catch {
          return "Enter a valid Solana mint address";
        }
      }
    });
    if (customMint === WIZARD_BACK) continue;
    return customMint;
  }
}

function wizardMessage(label: string, index: number, total: number): string {
  return `Swap ${index + 1}/${total} - ${label}`;
}

async function runSwapWizard(
  options: {
    poolId?: string;
    inputMint?: string;
    outputMint?: string;
    amount?: string;
    execute?: boolean;
    quote?: boolean;
  },
  choices: SwapTokenChoice[]
): Promise<Partial<SwapWizardValues> | undefined> {
  const steps: Array<WizardStep<SwapWizardValues>> = [];
  if (!options.inputMint) {
    steps.push({
      key: "inputMint",
      prompt: (_values, context) =>
        promptForSwapToken(wizardMessage("Input token", context.index, context.total), choices, {
          allowBack: context.canGoBack
        })
    });
  }
  if (!options.poolId && !options.outputMint) {
    steps.push({
      key: "outputMint",
      prompt: (values, context) =>
        promptForSwapToken(wizardMessage("Output token", context.index, context.total), choices, {
          excludedMint: values.inputMint ?? options.inputMint,
          allowBack: context.canGoBack
        })
    });
  }
  if (!options.amount) {
    steps.push({
      key: "amount",
      prompt: (_values, context) =>
        promptWizardInput(wizardMessage("Amount", context.index, context.total), {
          allowBack: context.canGoBack,
          validate: (value) => {
            const parsed = new Decimal(value);
            return parsed.isFinite() && parsed.gt(0) ? true : "Enter a positive amount";
          }
        })
    });
  }
  if (!options.execute && !options.quote) {
    steps.push({
      key: "execute",
      prompt: async (_values, context) => {
        const selected = await promptWizardSelect(
          wizardMessage("Next action", context.index, context.total),
          [
            { name: "Review quote only (recommended)", value: "quote" },
            { name: "Review, simulate, and send", value: "execute" }
          ],
          { allowBack: context.canGoBack }
        );
        if (isWizardNavigation(selected)) return selected;
        return selected === "execute";
      }
    });
  }

  const result = await runWizard<SwapWizardValues>(
    {
      inputMint: options.inputMint,
      outputMint: options.outputMint,
      amount: options.amount,
      execute: options.execute
    },
    steps
  );
  return result.status === "cancelled" ? undefined : result.values;
}

function tokenLabel(mint: string, fallback?: string): string {
  if (mint === WRAPPED_SOL_MINT) return "SOL";
  if (mint === MAINNET_USDC_MINT) return "USDC";
  return fallback || shortenAddress(mint);
}

function transactionReviewRows(options: {
  wallet?: string;
  walletAddress: PublicKey;
  instructionCount: number;
  programCount: number;
  maximumPriorityFeeLamports?: string;
  unitsConsumed?: number | null;
}): ReviewRow[] {
  return [
    {
      label: "Wallet",
      value: `${options.wallet ?? "active"} (${shortenAddress(options.walletAddress.toBase58())})`
    },
    { label: "Instructions", value: String(options.instructionCount) },
    { label: "Programs", value: `${options.programCount} approved` },
    ...(options.maximumPriorityFeeLamports
      ? [{
          label: "Max priority fee",
          value: `${options.maximumPriorityFeeLamports} lamports`,
          tone: "muted" as const
        }]
      : []),
    {
      label: "Simulation",
      value: `Passed${options.unitsConsumed ? ` (${options.unitsConsumed} compute units)` : ""}`,
      tone: "positive"
    }
  ];
}

const COMMON_TRANSACTION_PROGRAM_IDS = new Set([
  ComputeBudgetProgram.programId.toBase58(),
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
]);
const ROUTED_SWAP_PROGRAM_IDS = new Set([
  ...COMMON_TRANSACTION_PROGRAM_IDS,
  AMM_V4.toBase58(),
  AMM_STABLE.toBase58(),
  CLMM_PROGRAM_ID.toBase58(),
  CREATE_CPMM_POOL_PROGRAM.toBase58(),
  Router.toBase58(),
  DEVNET_PROGRAM_ID.AMM_V4.toBase58(),
  DEVNET_PROGRAM_ID.AMM_STABLE.toBase58(),
  DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID.toBase58(),
  DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM.toBase58(),
  DEVNET_PROGRAM_ID.Router.toBase58()
]);

async function handleConfirmedTransactionExplorer(
  config: Awaited<ReturnType<typeof loadConfig>>,
  signature: string
): Promise<string> {
  const options = { explorer: config.explorer, cluster: config.cluster, signature };
  const explorerUrl = getTransactionExplorerUrl(options);
  if (!isJsonOutput()) {
    logInfo(`Explorer: ${explorerUrl}`);
    try {
      await offerTransactionExplorer(options);
    } catch (error) {
      logErrorWithDebug("Transaction confirmed, but explorer could not be opened", error);
    }
  }
  return explorerUrl;
}

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

async function fetchTradeQuote(params: {
  host: string;
  mode: TradeApiSwapMode;
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}): Promise<TradeApiQuoteResponse> {
  const url = `${params.host}/compute/swap-${params.mode}?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps}&txVersion=V0`;
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
  mode: TradeApiSwapMode;
  swapResponse: TradeApiQuoteResponse;
  wallet: string;
  wrapSol: boolean;
  unwrapSol: boolean;
  inputAccount?: string;
  outputAccount?: string;
  computeUnitPriceMicroLamports: number;
}): Promise<TradeApiTxResponse> {
  const res = await fetch(`${params.host}/transaction/swap-${params.mode}`, {
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

function decodeOwnerTokenAccount(params: {
  address: PublicKey;
  data: Buffer;
  mint: PublicKey;
  owner: PublicKey;
  associatedAddress: PublicKey;
}): OwnerTokenAccount | undefined {
  const decoded = AccountLayout.decode(params.data);
  if (!decoded.mint.equals(params.mint) || !decoded.owner.equals(params.owner)) return undefined;
  return {
    address: params.address.toBase58(),
    amount: decoded.amount,
    isAssociated: params.address.equals(params.associatedAddress)
  };
}

async function getTokenProgramForMint(mint: PublicKey): Promise<PublicKey> {
  const connection = await getConnection();
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`Could not fetch mint account for ${mint}`);

  const tokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : mintInfo.owner.equals(TOKEN_PROGRAM_ID)
      ? TOKEN_PROGRAM_ID
      : undefined;
  if (!tokenProgram) throw new Error(`Mint ${mint} is not owned by a supported token program`);
  return tokenProgram;
}

async function getAssociatedTokenAccount(mint: string, owner: PublicKey): Promise<string | undefined> {
  if (mint === WRAPPED_SOL_MINT) return undefined;

  const mintPublicKey = new PublicKey(mint);
  const tokenProgram = await getTokenProgramForMint(mintPublicKey);
  return getAssociatedTokenAddressSync(mintPublicKey, owner, false, tokenProgram).toBase58();
}

async function resolveOwnerTokenAccount(
  mint: string,
  owner: PublicKey
): Promise<OwnerTokenAccountResolution | undefined> {
  if (mint === WRAPPED_SOL_MINT) return undefined;

  const connection = await getConnection();
  const mintPublicKey = new PublicKey(mint);
  const tokenProgram = await getTokenProgramForMint(mintPublicKey);
  const associatedAddress = getAssociatedTokenAddressSync(
    mintPublicKey,
    owner,
    false,
    tokenProgram
  );

  const associatedInfo = await connection.getAccountInfo(associatedAddress);
  if (associatedInfo) {
    if (!associatedInfo.owner.equals(tokenProgram)) {
      throw new Error(`Associated token account ${associatedAddress.toBase58()} is not owned by the mint token program`);
    }
    const account = decodeOwnerTokenAccount({
      address: associatedAddress,
      data: associatedInfo.data,
      mint: mintPublicKey,
      owner,
      associatedAddress
    });
    if (!account) {
      throw new Error(`Associated token account ${associatedAddress.toBase58()} does not match the active wallet and mint`);
    }
    return { associatedAddress: associatedAddress.toBase58(), account };
  }

  const tokenAccounts = await connection.getTokenAccountsByOwner(owner, { programId: tokenProgram });
  const candidates = tokenAccounts.value
    .map(({ pubkey, account }) =>
      decodeOwnerTokenAccount({
        address: pubkey,
        data: account.data,
        mint: mintPublicKey,
        owner,
        associatedAddress
      })
    )
    .filter((account): account is OwnerTokenAccount => Boolean(account))
    .sort((left, right) => {
      if (left.isAssociated !== right.isAssociated) return left.isAssociated ? -1 : 1;
      if (left.amount === right.amount) return 0;
      return left.amount > right.amount ? -1 : 1;
    });

  return {
    associatedAddress: associatedAddress.toBase58(),
    account: candidates[0]
  };
}

function reportMissingInputTokenAccount(mint: string): void {
  logGuidedError({
    message: "No wallet token account was found for the input mint.",
    code: "INPUT_TOKEN_ACCOUNT_NOT_FOUND",
    details: `Input mint: ${mint}`,
    hints: [
      "Check the token balance with: raydium wallet balance",
      "For a buy, choose the token you are paying with as the input token.",
      "If you hold this mint in another wallet, switch the active wallet before executing the swap."
    ]
  });
}

function reportInsufficientInputTokenBalance(params: {
  mint: string;
  available: bigint;
  required: bigint;
  decimals: number;
}): void {
  logGuidedError({
    message: "The wallet does not have enough input token balance for this swap.",
    code: "INSUFFICIENT_INPUT_TOKEN_BALANCE",
    details: [
      `Input mint: ${params.mint}`,
      `Available: ${formatAtomicAmount(params.available.toString(), params.decimals)}`,
      `Required: ${formatAtomicAmount(params.required.toString(), params.decimals)}`
    ].join("\n"),
    hints: [
      "Lower the swap amount or choose a wallet with enough input tokens.",
      "For a buy, choose the token you are paying with as the input token."
    ]
  });
}

export function registerSwapCommands(program: Command): void {
  // Trade API swap (auto-routing)
  const tradeApiSwap = async (options: {
    inputMint: string;
    outputMint: string;
    amount: string;
    mode: TradeApiSwapMode;
    slippage: number;
    slippagePercent: number;
    priorityFeeMicroLamports: number;
    execute: boolean;
    approveQuote?: string;
    ownerPublicKey?: PublicKey;
    loadSigner?: () => Promise<Keypair>;
    walletName?: string;
    confirmation: SwapConfirmationPolicy;
    debug?: boolean;
  }) => {
    const inputMintStr = options.inputMint;
    const outputMintStr = options.outputMint;
    const config = await loadConfig({ createIfMissing: true });
    const tradeApiHost = getApiUrlsForCluster(config.cluster).SWAP_HOST;

    const inputDecimals = await withSpinner("Fetching token info", () =>
      getTokenDecimals(inputMintStr)
    );
    const outputDecimals = await getTokenDecimals(outputMintStr);
    const amountDecimals = options.mode === "base-in" ? inputDecimals : outputDecimals;
    const amountLamports = parseUiAmountToAtomic(options.amount, amountDecimals);

    // Fetch quote from Trade API
    const slippageBps = Math.round(options.slippage * 10000);
    let quote: TradeApiQuoteResponse;
    try {
      quote = await withSpinner("Fetching swap quote", () =>
        fetchTradeQuote({
          host: tradeApiHost,
          mode: options.mode,
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

    const inputAmount = formatAtomicAmount(quote.data.inputAmount, inputDecimals);
    const outputAmount = formatAtomicAmount(quote.data.outputAmount, outputDecimals);
    const threshold = formatAtomicAmount(
      quote.data.otherAmountThreshold,
      options.mode === "base-in" ? outputDecimals : inputDecimals
    );

    // Format route display
    const routeDisplay = quote.data.routePlan.length > 1
      ? `${quote.data.routePlan.length}-hop via ${quote.data.routePlan.map(r => r.poolId.slice(0, 4) + "..." + r.poolId.slice(-3)).join(" -> ")}`
      : `Direct via ${quote.data.routePlan[0]?.poolId.slice(0, 4)}...${quote.data.routePlan[0]?.poolId.slice(-3)}`;

    const quotePreview = {
      swapType: quote.data.swapType,
      route: quote.data.routePlan.map(r => r.poolId),
      input: options.mode === "base-in"
        ? { amount: inputAmount, mint: inputMintStr }
        : { estimated: inputAmount, maximum: threshold, mint: inputMintStr },
      output: options.mode === "base-in"
        ? { estimated: outputAmount, minimum: threshold, mint: outputMintStr }
        : { amount: outputAmount, mint: outputMintStr },
      priceImpactPct: quote.data.priceImpactPct,
      slippagePercent: options.slippagePercent
    };
    const approvedQuotePreview = withQuoteApprovalId("swap-quote", quotePreview);
    const inputSymbol = tokenLabel(inputMintStr);
    const outputSymbol = tokenLabel(outputMintStr);
    const highPriceImpact = quote.data.priceImpactPct >= HIGH_PRICE_IMPACT_PERCENT;
    const reviewWarnings = [
      ...options.confirmation.warnings,
      ...(highPriceImpact
        ? [`Price impact is ${quote.data.priceImpactPct.toFixed(2)}%, above the ${HIGH_PRICE_IMPACT_PERCENT}% safety threshold.`]
        : [])
    ];
    const quoteReviewRows: ReviewRow[] = [
      { label: "Route", value: routeDisplay },
      ...(options.mode === "base-in"
        ? [
            { label: "You pay", value: `${inputAmount} ${inputSymbol}` },
            { label: "You receive", value: `~${outputAmount} ${outputSymbol}`, tone: "positive" as const },
            { label: "Minimum", value: `${threshold} ${outputSymbol}` }
          ]
        : [
            { label: "You receive", value: `${outputAmount} ${outputSymbol}`, tone: "positive" as const },
            { label: "Est. pay", value: `~${inputAmount} ${inputSymbol}` },
            { label: "Maximum", value: `${threshold} ${inputSymbol}` }
          ]),
      {
        label: "Price impact",
        value: `${quote.data.priceImpactPct.toFixed(2)}%`,
        tone: highPriceImpact ? "danger" : "normal"
      },
      {
        label: "Slippage",
        value: `${options.slippagePercent}%`,
        tone: options.slippagePercent > MAX_SAFE_SLIPPAGE_PERCENT.toNumber() ? "danger" : "normal"
      },
      { label: "Input mint", value: inputMintStr, tone: "muted" },
      { label: "Output mint", value: outputMintStr, tone: "muted" },
      { label: "Quote ID", value: approvedQuotePreview.quoteId, tone: "muted" }
    ];

    if (!options.execute) {
      if (isJsonOutput()) {
        logJson({ action: "swap-quote", ...approvedQuotePreview });
      } else {
        renderReviewPanel({
          title: "SWAP QUOTE",
          context: config.cluster.toUpperCase(),
          rows: quoteReviewRows,
          warnings: reviewWarnings
        });
        logInfo("Quote only. Re-run with --execute to build, simulate, review, and send.");
      }
      return;
    }

    try {
      assertJsonQuoteApproval({
        action: "swap-quote",
        quote: quotePreview,
        approvedQuoteId: options.approveQuote
      });
    } catch (error) {
      logError(error instanceof Error ? error.message : "Quote approval failed");
      process.exitCode = 1;
      return;
    }

    if (!options.ownerPublicKey || !options.loadSigner) {
      throw new Error("A wallet is required to execute a swap");
    }
    const ownerPublicKey = options.ownerPublicKey;

    // Serialize transaction
    const inputIsSol = inputMintStr === WRAPPED_SOL_MINT;
    const outputIsSol = outputMintStr === WRAPPED_SOL_MINT;

    const inputMaxAtomic =
      options.mode === "base-in" ? amountLamports : BigInt(quote.data.otherAmountThreshold);
    const minOutputAtomic =
      options.mode === "base-in" ? BigInt(quote.data.otherAmountThreshold) : BigInt(quote.data.outputAmount);

    let inputResolution: OwnerTokenAccountResolution | undefined;
    let outputResolution: OwnerTokenAccountResolution | undefined;
    try {
      [inputResolution, outputResolution] = await withSpinner("Checking token accounts", () =>
        Promise.all([
          resolveOwnerTokenAccount(inputMintStr, ownerPublicKey),
          resolveOwnerTokenAccount(outputMintStr, ownerPublicKey)
        ])
      );
    } catch (error) {
      reportSwapError("Failed to check token accounts", error, options.debug);
      process.exitCode = 1;
      return;
    }

    const inputTokenAccount = inputResolution?.account;
    if (!inputIsSol && !inputTokenAccount) {
      reportMissingInputTokenAccount(inputMintStr);
      process.exitCode = 1;
      return;
    }
    if (!inputIsSol && inputTokenAccount && inputTokenAccount.amount < inputMaxAtomic) {
      reportInsufficientInputTokenBalance({
        mint: inputMintStr,
        available: inputTokenAccount.amount,
        required: inputMaxAtomic,
        decimals: inputDecimals
      });
      process.exitCode = 1;
      return;
    }

    const inputAccount = inputTokenAccount?.address;
    const outputAccount = outputResolution?.account?.address;
    const outputGuardAccount = outputResolution?.account?.address ?? outputResolution?.associatedAddress;

    let txResponse: TradeApiTxResponse;
    try {
      txResponse = await withSpinner("Building swap transaction", () =>
        serializeSwapTx({
          host: tradeApiHost,
          mode: options.mode,
          swapResponse: quote,
          wallet: ownerPublicKey.toBase58(),
          wrapSol: inputIsSol,
          unwrapSol: outputIsSol,
          inputAccount,
          outputAccount,
          computeUnitPriceMicroLamports: options.priorityFeeMicroLamports
        })
      );
    } catch (error) {
      reportSwapError("Failed to build transaction", error, options.debug);
      process.exitCode = 1;
      return;
    }

    if (!Array.isArray(txResponse.data) || txResponse.data.length !== 1) {
      const details = {
        code: "multi_transaction_not_supported",
        transactionCount: Array.isArray(txResponse.data) ? txResponse.data.length : null,
        message: "The Trade API returned a sequence that cannot be simulated atomically. No transaction was sent.",
        nextStep: "Prepare required token accounts separately, then request a fresh quote and execution transaction."
      };
      if (isJsonOutput()) {
        logJson({ error: "Safe execution requires one transaction", ...details });
      } else {
        logError("Safe execution requires one transaction", details);
      }
      process.exitCode = 1;
      return;
    }

    const connection = await getConnection();
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(txResponse.data[0].transaction, "base64"));
    } catch (error) {
      logErrorWithDebug("Failed to decode transaction", error, { debug: options.debug });
      process.exitCode = 1;
      return;
    }

    let preview: ReturnType<typeof summarizeVersionedTransaction>;
    try {
      const policyPreview = await validateVersionedTransactionPolicy(connection, tx, {
        owner: ownerPublicKey,
        allowedProgramIds: ROUTED_SWAP_PROGRAM_IDS
      });
      preview = assertTransactionPriorityFeeBudget(
        tx,
        options.priorityFeeMicroLamports,
        MAX_PRIORITY_FEE_LAMPORTS
      );
      preview = { ...preview, programIds: policyPreview.programIds };
    } catch (error) {
      logErrorWithDebug("Transaction priority-fee validation failed", error, { debug: options.debug });
      process.exitCode = 1;
      return;
    }
    const feeAllowanceLamports =
      BigInt(preview.computeBudget?.maximumPriorityFeeLamports ?? "0") +
      SIGNATURE_FEE_LAMPORTS +
      SWAP_RENT_ALLOWANCE_LAMPORTS;
    const balanceGuards = {
      owner: ownerPublicKey,
      minOwnerLamportsDelta:
        (outputIsSol ? minOutputAtomic : 0n) -
        (inputIsSol ? inputMaxAtomic : 0n) -
        feeAllowanceLamports,
      tokenAccounts: [
        ...(inputAccount
          ? [{ account: new PublicKey(inputAccount), label: "input token account", minDelta: -inputMaxAtomic }]
          : []),
        ...(outputGuardAccount
          ? [{ account: new PublicKey(outputGuardAccount), label: "output token account", minDelta: minOutputAtomic }]
          : [])
      ]
    };

    let simulation: { unitsConsumed?: number | null; logs?: string[] | null };
    try {
      simulation = await withSpinner("Simulating transaction", () =>
        simulateVersionedTransaction(connection, tx, balanceGuards)
      );
    } catch (error) {
      logErrorWithDebug("Transaction simulation failed", error, { debug: options.debug });
      process.exitCode = 1;
      return;
    }

    renderReviewPanel({
      title: "SWAP REVIEW",
      context: config.cluster.toUpperCase(),
      rows: [
        ...transactionReviewRows({
          wallet: options.walletName,
          walletAddress: ownerPublicKey,
          instructionCount: preview.instructionCount,
          programCount: preview.programIds.length,
          maximumPriorityFeeLamports: preview.computeBudget?.maximumPriorityFeeLamports,
          unitsConsumed: simulation.unitsConsumed
        }),
        ...quoteReviewRows
      ],
      warnings: reviewWarnings
    });

    const riskIsDangerous = options.confirmation.dangerous || highPriceImpact;
    const matchingQuoteAcknowledgement = options.approveQuote === approvedQuotePreview.quoteId;
    const ok = await promptActionConfirmation({
      message: "Confirm and sign this swap?",
      risk: riskIsDangerous ? "dangerous" : "write",
      expectedText: "SWAP",
      allowExplicitRiskAcknowledgement:
        options.confirmation.dangerous && !highPriceImpact
          ? true
          : matchingQuoteAcknowledgement
    });
    if (!ok) {
      logInfo("Cancelled");
      return;
    }

    try {
      const signer = await options.loadSigner();
      if (!signer.publicKey.equals(ownerPublicKey)) {
        throw new Error("Unlocked wallet does not match the reviewed wallet");
      }
      tx.sign([signer]);
      const txId = await withSpinner("Sending transaction", () =>
        sendAndConfirmVersionedTransaction(connection, tx)
      );
      const explorerUrl = await handleConfirmedTransactionExplorer(config, txId);
      if (isJsonOutput()) {
        logJson({
          action: "swap-execute",
          ...approvedQuotePreview,
          transaction: preview,
          simulation: { unitsConsumed: simulation.unitsConsumed },
          txId,
          explorerUrl,
          confirmationStatus: "confirmed"
        });
      } else {
        logSuccess(`Swap confirmed: ${txId}`);
      }
    } catch (error) {
      logErrorWithDebug("Swap failed", error, { debug: options.debug, fallback: "Swap failed" });
      process.exitCode = 1;
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
    ownerPublicKey?: PublicKey;
    loadSigner?: () => Promise<Keypair>;
    walletName?: string;
    confirmation: SwapConfirmationPolicy;
    execute: boolean;
    approveQuote?: string;
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

    const raydium = await withSpinner("Loading Raydium", () =>
      loadRaydium({ owner: options.ownerPublicKey, disableLoadToken: true })
    );

    let poolInfo: ApiV3PoolInfoStandardItem;
    let poolKeys: AmmV4Keys | AmmV5Keys;
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
      poolKeys = data.poolKeys as AmmV4Keys | AmmV5Keys;
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

    const quotePreview = {
      poolId,
      input: { amount: options.amount, symbol: inSymbol, mint: inputTokenInfo.address },
      output: {
        estimated: estimatedOut.toExact(),
        minimum: minOut.toExact(),
        symbol: outSymbol,
        mint: outputTokenInfo.address
      },
      slippagePercent: options.slippagePercent
    };
    const approvedQuotePreview = withQuoteApprovalId("direct-amm-swap-quote", quotePreview);
    const reviewWarnings = options.confirmation.warnings;
    const quoteReviewRows: ReviewRow[] = [
      { label: "Pool", value: poolId, tone: "muted" },
      { label: "You pay", value: `${options.amount} ${tokenLabel(inputMintStr, inSymbol)}` },
      {
        label: "You receive",
        value: `~${estimatedOut.toExact()} ${tokenLabel(outputMintStr, outSymbol)}`,
        tone: "positive"
      },
      { label: "Minimum", value: `${minOut.toExact()} ${tokenLabel(outputMintStr, outSymbol)}` },
      {
        label: "Slippage",
        value: `${options.slippagePercent}%`,
        tone: options.confirmation.dangerous ? "danger" : "normal"
      },
      { label: "Input mint", value: inputMintStr, tone: "muted" },
      { label: "Output mint", value: outputMintStr, tone: "muted" },
      { label: "Quote ID", value: approvedQuotePreview.quoteId, tone: "muted" }
    ];

    if (!options.execute) {
      if (isJsonOutput()) {
        logJson({ action: "direct-amm-swap-quote", ...approvedQuotePreview });
      } else {
        renderReviewPanel({
          title: "DIRECT AMM QUOTE",
          context: raydium.cluster.toUpperCase(),
          rows: quoteReviewRows,
          warnings: reviewWarnings
        });
        logInfo("Quote only. Re-run with --execute to build, simulate, review, and send.");
      }
      return;
    }

    try {
      assertJsonQuoteApproval({
        action: "direct-amm-swap-quote",
        quote: quotePreview,
        approvedQuoteId: options.approveQuote
      });
    } catch (error) {
      logError(error instanceof Error ? error.message : "Quote approval failed");
      process.exitCode = 1;
      return;
    }

    if (!options.ownerPublicKey || !options.loadSigner) {
      throw new Error("A wallet is required to execute a direct AMM swap");
    }
    const ownerPublicKey = options.ownerPublicKey;

    let built;
    try {
      built = await withSpinner("Building direct AMM swap", () =>
        raydium.liquidity.swap({
          poolInfo,
          poolKeys,
          amountIn: inputTokenAmount.raw,
          amountOut: computeOut.minAmountOut,
          inputMint: inputMintStr,
          fixedSide: "in",
          txVersion: TxVersion.V0,
          computeBudgetConfig: options.priorityFeeMicroLamports > 0
            ? { units: 600_000, microLamports: options.priorityFeeMicroLamports }
            : undefined
        })
      );
    } catch (error) {
      logErrorWithDebug("Failed to build direct AMM swap", error, { debug: options.debug });
      process.exitCode = 1;
      return;
    }

    const transaction = built.transaction;
    if (!(transaction instanceof VersionedTransaction)) {
      logError("Direct AMM safe execution requires a single V0 transaction");
      process.exitCode = 1;
      return;
    }

    const connection = await getConnection();
    let preview: ReturnType<typeof summarizeVersionedTransaction>;
    let simulation: { unitsConsumed?: number | null; logs?: string[] | null };
    try {
      const policyPreview = await validateVersionedTransactionPolicy(connection, transaction, {
        owner: ownerPublicKey,
        allowedProgramIds: new Set([...COMMON_TRANSACTION_PROGRAM_IDS, poolInfo.programId])
      });
      preview = assertTransactionPriorityFeeBudget(
        transaction,
        options.priorityFeeMicroLamports,
        MAX_PRIORITY_FEE_LAMPORTS
      );
      preview = { ...preview, programIds: policyPreview.programIds };

      const inputIsSol = inputMintStr === WRAPPED_SOL_MINT;
      const outputIsSol = outputMintStr === WRAPPED_SOL_MINT;
      const inputMaxAtomic = BigInt(inputTokenAmount.raw.toString());
      const minOutputAtomic = BigInt(computeOut.minAmountOut.toString());
      const feeAllowanceLamports =
        BigInt(preview.computeBudget?.maximumPriorityFeeLamports ?? "0") +
        SIGNATURE_FEE_LAMPORTS +
        SWAP_RENT_ALLOWANCE_LAMPORTS;
      const inputAccount = await getAssociatedTokenAccount(inputMintStr, ownerPublicKey);
      const outputAccount = await getAssociatedTokenAccount(outputMintStr, ownerPublicKey);
      const balanceGuards = {
        owner: ownerPublicKey,
        minOwnerLamportsDelta:
          (outputIsSol ? minOutputAtomic : 0n) -
          (inputIsSol ? inputMaxAtomic : 0n) -
          feeAllowanceLamports,
        tokenAccounts: [
          ...(inputAccount
            ? [{ account: new PublicKey(inputAccount), label: "input token account", minDelta: -inputMaxAtomic }]
            : []),
          ...(outputAccount
            ? [{ account: new PublicKey(outputAccount), label: "output token account", minDelta: minOutputAtomic }]
            : [])
        ]
      };

      simulation = await withSpinner("Simulating transaction", () =>
        simulateVersionedTransaction(connection, transaction, balanceGuards)
      );
    } catch (error) {
      logErrorWithDebug("Direct AMM transaction validation failed", error, { debug: options.debug });
      process.exitCode = 1;
      return;
    }

    renderReviewPanel({
      title: "DIRECT AMM SWAP REVIEW",
      context: raydium.cluster.toUpperCase(),
      rows: [
        ...transactionReviewRows({
          wallet: options.walletName,
          walletAddress: ownerPublicKey,
          instructionCount: preview.instructionCount,
          programCount: preview.programIds.length,
          maximumPriorityFeeLamports: preview.computeBudget?.maximumPriorityFeeLamports,
          unitsConsumed: simulation.unitsConsumed
        }),
        ...quoteReviewRows
      ],
      warnings: reviewWarnings
    });
    const confirmed = await promptActionConfirmation({
      message: "Confirm and sign this direct AMM swap?",
      risk: options.confirmation.dangerous ? "dangerous" : "write",
      expectedText: "SWAP",
      allowExplicitRiskAcknowledgement: options.confirmation.dangerous
    });
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }

    try {
      const signer = await options.loadSigner();
      if (!signer.publicKey.equals(ownerPublicKey)) {
        throw new Error("Unlocked wallet does not match the reviewed wallet");
      }
      transaction.sign([signer]);
      const txId = await withSpinner("Sending transaction", () =>
        sendAndConfirmVersionedTransaction(connection, transaction)
      );
      const explorerUrl = await handleConfirmedTransactionExplorer(
        await loadConfig({ createIfMissing: true }),
        txId
      );
      if (isJsonOutput()) {
        logJson({
          action: "direct-amm-swap-execute",
          ...approvedQuotePreview,
          transaction: preview,
          simulation: { unitsConsumed: simulation.unitsConsumed },
          txId,
          explorerUrl,
          confirmationStatus: "confirmed"
        });
      } else {
        logSuccess(`Direct AMM swap confirmed: ${txId}`);
      }
    } catch (error) {
      logErrorWithDebug("Direct AMM swap failed", error, { debug: options.debug });
      process.exitCode = 1;
    }

  };

  let swapCommand: Command;
  const swapAction = async (options: {
    poolId?: string;
    inputMint?: string;
    outputMint?: string;
    amount?: string;
    exactOut?: boolean;
    execute?: boolean;
    quote?: boolean;
    slippage?: string;
    priorityFee?: string;
    allowHighSlippage?: boolean;
    allowHighPriorityFee?: boolean;
    approveQuote?: string;
    debug?: boolean;
    helpAll?: boolean;
  }) => {
    if (options.helpAll) {
      outputHelpWithAdvancedOptions(swapCommand);
      return;
    }

    const config = await loadConfig({ createIfMissing: true });
    const needsWizard = !options.inputMint || !options.amount || (!options.poolId && !options.outputMint);
    if (needsWizard && !canPromptInteractively()) {
      logGuidedError({
        message: "Missing required swap options.",
        code: "SWAP_OPTIONS_REQUIRED",
        hints: [
          "Provide --input-mint, --amount, and --output-mint for routed swaps.",
          "Provide --pool-id, --input-mint, and --amount for direct AMM swaps."
        ]
      });
      process.exitCode = 1;
      return;
    }

    if (needsWizard) {
      const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
      let balances: RpcBalance[] = [];
      if (walletName) {
        const publicKey = await getWalletPublicKey(walletName);
        balances = await withSpinner("Fetching wallet balances", () => fetchRpcBalances(publicKey));
      }
      const choices = buildSwapTokenChoices(balances, config.cluster, true);

      const wizardValues = await runSwapWizard(options, choices);
      if (!wizardValues) {
        logInfo("Cancelled");
        return;
      }
      options.inputMint = wizardValues.inputMint;
      options.outputMint = wizardValues.outputMint;
      options.amount = wizardValues.amount;
      options.execute = wizardValues.execute;
    }

    if (!options.inputMint || !options.amount || (!options.poolId && !options.outputMint)) {
      logGuidedError({
        message: "Missing required swap options.",
        code: "SWAP_OPTIONS_REQUIRED",
        hints: ["Run raydium swap without --json for the interactive wizard."]
      });
      process.exitCode = 1;
      return;
    }

    if (options.exactOut && options.poolId) {
      logError("--exact-out is available only for auto-routed swaps without --pool-id");
      process.exitCode = 1;
      return;
    }
    if (options.quote && options.execute) {
      logError("Use either --quote or --execute, not both");
      process.exitCode = 1;
      return;
    }

    try {
      options.inputMint = await resolveMintAddress(options.inputMint, { cluster: config.cluster });
      if (options.outputMint) {
        options.outputMint = await resolveMintAddress(options.outputMint, { cluster: config.cluster });
      }
      if (options.outputMint && options.inputMint === options.outputMint) {
        throw new Error("Input and output tokens must be different");
      }
    } catch (error) {
      logError(error instanceof Error ? error.message : "Failed to resolve token symbol");
      process.exitCode = 1;
      return;
    }

    const slippageValue = options.slippage ?? String(config["default-slippage"]);
    const priorityFeeValue = options.priorityFee ?? String(config["priority-fee"]);
    let slippagePercent: number;
    let priorityFeeMicroLamports: number;
    try {
      slippagePercent = parseSlippagePercent(
        slippageValue,
        Boolean(options.allowHighSlippage)
      ).toNumber();
      priorityFeeMicroLamports = parsePriorityFeeMicroLamports(
        priorityFeeValue,
        Boolean(options.allowHighPriorityFee)
      );
    } catch (error) {
      logError(error instanceof Error ? error.message : "Invalid swap safety setting");
      process.exitCode = 1;
      return;
    }
    const slippage = slippagePercent / 100;
    const highSlippage = new Decimal(slippageValue).gt(MAX_SAFE_SLIPPAGE_PERCENT);
    const highPriorityFee = new Decimal(priorityFeeValue).gt(MAX_SAFE_PRIORITY_FEE_SOL);
    const confirmation: SwapConfirmationPolicy = {
      dangerous: highSlippage || highPriorityFee,
      warnings: [
        ...(highSlippage
          ? [`Slippage is ${slippagePercent}%, above the ${MAX_SAFE_SLIPPAGE_PERCENT.toString()}% safety threshold.`]
          : []),
        ...(highPriorityFee
          ? [`Priority fee is ${priorityFeeValue} SOL, above the ${MAX_SAFE_PRIORITY_FEE_SOL.toString()} SOL safety threshold.`]
          : [])
      ]
    };

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

    let walletName: string | undefined;
    let ownerPublicKey: PublicKey | undefined;
    let loadSigner: (() => Promise<Keypair>) | undefined;
    if (options.execute) {
      walletName = resolveWalletIdentifier(undefined, config.activeWallet);
      if (!walletName) {
        logError("No active wallet set");
        process.exitCode = 1;
        return;
      }
      ownerPublicKey = await getWalletPublicKey(walletName);
      loadSigner = async () => {
        const password = await promptPassword("Enter wallet password");
        try {
          return await decryptWallet(walletName!, password);
        } catch (error) {
          throw new Error(`Failed to decrypt wallet: ${(error as Error).message}`);
        }
      };
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
        ownerPublicKey,
        loadSigner,
        walletName,
        confirmation,
        execute: Boolean(options.execute),
        approveQuote: options.approveQuote,
        debug: options.debug
      });
    } else {
      // Trade API swap (auto-routing)
      await tradeApiSwap({
        inputMint: options.inputMint,
        outputMint: options.outputMint!,
        amount: options.amount,
        mode: options.exactOut ? "base-out" : "base-in",
        slippage,
        slippagePercent,
        priorityFeeMicroLamports,
        ownerPublicKey,
        loadSigner,
        walletName,
        confirmation,
        execute: Boolean(options.execute),
        approveQuote: options.approveQuote,
        debug: options.debug
      });
    }
  };

  swapCommand = program
    .command("swap")
    .description("Swap tokens (omit --pool-id for auto-routing via Trade API)")
    .option("--input-mint <mint-or-symbol>", "Input token mint or Raydium APIv3 symbol (interactive selection when omitted)")
    .option("--amount <number>", "Input amount, or requested output with --exact-out")
    .option("--output-mint <mint-or-symbol>", "Output token mint or Raydium APIv3 symbol (required if --pool-id not provided)")
    .addOption(
      new Option("--exact-out", "Treat --amount as the exact output amount")
        .conflicts("poolId")
    )
    .option("--execute", "Build, simulate, review, and send the quoted swap")
    .option("--help-all", "Display common and advanced options")
    .addOption(new Option("--pool-id <pool>", "AMM pool address (omit for auto-routing)").hideHelp())
    .addOption(
      new Option("--quote", "Explicitly request a quote without building or sending a transaction")
        .conflicts("execute")
        .hideHelp()
    )
    .addOption(
      new Option("--approve-quote <quote-id>", "Required with --json --execute; use a fresh quote ID")
        .hideHelp()
    )
    .addOption(new Option("--slippage <percent>", "Override configured slippage tolerance").hideHelp())
    .addOption(new Option("--allow-high-slippage", "Allow slippage above the 5% safety cap").hideHelp())
    .addOption(new Option("--priority-fee <sol>", "Override configured priority fee in SOL").hideHelp())
    .addOption(
      new Option("--allow-high-priority-fee", "Allow priority fee above the 0.01 SOL safety cap")
        .hideHelp()
    )
    .addOption(new Option("--debug", "Print full error object on failure").hideHelp());

  addRichHelp(
    swapCommand,
    {
      summary: [
        "Omit --pool-id to use Raydium Trade API auto-routing.",
        "Commands quote by default. --execute is required before the CLI signs or sends a transaction.",
        "With --pool-id, execute an exact-input swap against that standard AMM pool."
      ],
      auth: `${PASSWORD_AUTH_HELP} A wallet is required only with --execute.`,
      units: [
        "--amount is a decimal UI input amount, or output amount when --exact-out is set.",
        "--slippage is a percent such as 0.5 for 0.5%.",
        "--priority-fee is in SOL."
      ],
      defaults: [
        "Cluster-aware Trade API and RPC behavior follows the configured cluster.",
        "--output-mint is required only when auto-routing without --pool-id.",
        "Mint options also accept unique symbols from Raydium APIv3 /mint/list, such as SOL, RAY, or USDC.",
        "Slippage above 5% and priority fees above 0.01 SOL require explicit acknowledgement flags.",
        "Use So11111111111111111111111111111111111111112 for SOL.",
        "Run raydium swap --help-all to display routing and safety override options."
      ],
      automation: AUTOMATION_HELP,
      examples: [
        "raydium swap --input-mint SOL --output-mint USDC --amount 0.001",
        "raydium swap --input-mint So11111111111111111111111111111111111111112 --output-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --amount 0.001",
        "raydium swap --exact-out --input-mint <mint-a> --output-mint <mint-b> --amount 1.25",
        "QUOTE_ID=$(raydium --json swap --input-mint <mint-a> --output-mint <mint-b> --amount 1.25 | node -pe 'JSON.parse(require(\"fs\").readFileSync(0, \"utf8\")).quoteId')",
        "printf '%s' 'wallet-password' | raydium --json --yes --password-stdin swap --execute --input-mint <mint-a> --output-mint <mint-b> --amount 1.25 --approve-quote \"$QUOTE_ID\""
      ]
    }
  )
    .action(swapAction);
}
