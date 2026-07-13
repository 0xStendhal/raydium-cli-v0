import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";

const CONFIRMATION_POLL_INTERVAL_MS = 1_200;
const CONFIRMATION_TIMEOUT_MS = 60_000;
const SEND_RETRY_COUNT = 3;

export interface TransactionPreview {
  instructionCount: number;
  programIds: string[];
  computeBudget?: {
    unitLimit?: number;
    microLamports?: string;
    maximumPriorityFeeLamports?: string;
  };
  topLevelTokenInstructions?: Array<{ programId: string; kind: string }>;
}

export interface TransactionPolicy {
  owner: PublicKey;
  allowedProgramIds: ReadonlySet<string>;
  /**
   * Extra accounts (besides the owner, the owner's wSOL ATA, and token
   * accounts initialized for the owner within the same transaction) that
   * top-level System transfers may fund.
   */
  allowedSystemTransferRecipients?: ReadonlySet<string>;
}

export interface TokenBalanceGuard {
  account: PublicKey;
  label: string;
  /** Simulated post-minus-pre token amount must be >= this value. */
  minDelta: bigint;
}

export interface SimulationBalanceGuards {
  owner: PublicKey;
  /** Simulated owner lamports delta must be >= this value (negative allows a bounded outflow). */
  minOwnerLamportsDelta: bigint;
  tokenAccounts?: TokenBalanceGuard[];
}

const SAFE_TOP_LEVEL_TOKEN_INSTRUCTIONS = new Map<number, string>([
  [1, "initialize-account"],
  [9, "close-account"],
  [16, "initialize-account-2"],
  [17, "sync-native"],
  [18, "initialize-account-3"]
]);

export function summarizeVersionedTransaction(tx: VersionedTransaction): TransactionPreview {
  const accountKeys = tx.message.staticAccountKeys;
  let unitLimit: number | undefined;
  let microLamports: bigint | undefined;
  const programIds = [...new Set(
    tx.message.compiledInstructions
      .map((instruction) => {
        const programId = accountKeys[instruction.programIdIndex]?.toBase58();
        if (programId === ComputeBudgetProgram.programId.toBase58()) {
          const data = Buffer.from(instruction.data);
          if (data[0] === 2 && data.length >= 5) unitLimit = data.readUInt32LE(1);
          if (data[0] === 3 && data.length >= 9) microLamports = data.readBigUInt64LE(1);
        }
        return programId;
      })
      .filter((programId): programId is string => Boolean(programId))
  )];

  const maximumPriorityFeeLamports = unitLimit !== undefined && microLamports !== undefined
    ? (BigInt(unitLimit) * microLamports + 999_999n) / 1_000_000n
    : undefined;

  return {
    instructionCount: tx.message.compiledInstructions.length,
    programIds,
    computeBudget: unitLimit !== undefined || microLamports !== undefined
      ? {
          unitLimit,
          microLamports: microLamports?.toString(),
          maximumPriorityFeeLamports: maximumPriorityFeeLamports?.toString()
        }
      : undefined
  };
}

export function assertTransactionPriorityFeeBudget(
  tx: VersionedTransaction,
  requestedMicroLamports: number,
  maximumLamports: bigint
): TransactionPreview {
  const preview = summarizeVersionedTransaction(tx);
  const actualMicroLamports = preview.computeBudget?.microLamports;
  if (actualMicroLamports !== undefined && preview.computeBudget?.unitLimit === undefined) {
    throw new Error("Transaction sets a compute-unit price without a bounded compute-unit limit");
  }
  if (actualMicroLamports !== undefined && BigInt(actualMicroLamports) > BigInt(requestedMicroLamports)) {
    throw new Error("Transaction compute-unit price exceeds the requested priority fee");
  }
  const maximumPriorityFeeLamports = preview.computeBudget?.maximumPriorityFeeLamports;
  if (maximumPriorityFeeLamports !== undefined && BigInt(maximumPriorityFeeLamports) > maximumLamports) {
    throw new Error("Transaction maximum priority fee exceeds the CLI hard limit");
  }
  return preview;
}

/**
 * Resolves V0 address lookup tables and rejects transaction shapes outside the
 * narrow program policy for the intended operation before the wallet signs.
 */
export async function validateVersionedTransactionPolicy(
  connection: Connection,
  tx: VersionedTransaction,
  policy: TransactionPolicy
): Promise<TransactionPreview> {
  const staticKeys = tx.message.staticAccountKeys;
  if (!staticKeys[0]?.equals(policy.owner)) {
    throw new Error("Transaction fee payer does not match the active wallet");
  }

  const signerCount = tx.message.header.numRequiredSignatures;
  const requiredSigners = staticKeys.slice(0, signerCount);
  if (requiredSigners.length !== 1 || !requiredSigners[0].equals(policy.owner)) {
    throw new Error("Safe execution requires the active wallet to be the only required signer");
  }

  const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
  for (const lookup of tx.message.addressTableLookups) {
    const response = await connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" });
    if (!response.value) {
      throw new Error(`Transaction address lookup table is unavailable: ${lookup.accountKey.toBase58()}`);
    }
    addressLookupTableAccounts.push(response.value);
  }

  const accountKeys = tx.message.getAccountKeys({ addressLookupTableAccounts });
  const programIds = [...new Set(
    tx.message.compiledInstructions.map((instruction) => {
      const programId = accountKeys.get(instruction.programIdIndex);
      if (!programId) throw new Error("Transaction references an unresolved program account");
      return programId.toBase58();
    })
  )];
  const unapprovedPrograms = programIds.filter((programId) => !policy.allowedProgramIds.has(programId));
  if (unapprovedPrograms.length > 0) {
    throw new Error(`Transaction uses unapproved program(s): ${unapprovedPrograms.join(", ")}`);
  }

  const topLevelTokenInstructions: Array<{ programId: string; kind: string }> = [];
  const decompiled = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts });

  const transferRecipients = new Set<string>([
    policy.owner.toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, policy.owner).toBase58(),
    ...(policy.allowedSystemTransferRecipients ?? [])
  ]);

  for (const instruction of decompiled.instructions) {
    if (!isTokenProgram(instruction.programId)) continue;
    const kind = SAFE_TOP_LEVEL_TOKEN_INSTRUCTIONS.get(instruction.data[0]);
    if (!kind) {
      throw new Error("Transaction contains an unsafe top-level token-program instruction");
    }

    const initializedOwner = getInitializeAccountOwner(instruction);
    if (initializedOwner !== undefined) {
      if (!initializedOwner.equals(policy.owner)) {
        throw new Error("Transaction initializes a token account owned by another wallet");
      }
      const tokenAccount = instruction.keys[0]?.pubkey;
      if (tokenAccount) transferRecipients.add(tokenAccount.toBase58());
    }

    if (instruction.data[0] === 9) {
      const destination = instruction.keys[1]?.pubkey;
      const authority = instruction.keys[2]?.pubkey;
      if (!destination?.equals(policy.owner) || !authority?.equals(policy.owner)) {
        throw new Error("Transaction closes a token account toward another wallet");
      }
    }

    topLevelTokenInstructions.push({ programId: instruction.programId.toBase58(), kind });
  }

  for (const instruction of decompiled.instructions) {
    if (!instruction.programId.equals(SystemProgram.programId)) continue;
    assertSafeSystemInstruction(instruction, policy.owner, transferRecipients);
  }

  return {
    ...assertTransactionPriorityFeeBudget(tx, Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)),
    programIds,
    topLevelTokenInstructions
  };
}

function isTokenProgram(programId: PublicKey): boolean {
  return programId.equals(TOKEN_PROGRAM_ID) || programId.equals(TOKEN_2022_PROGRAM_ID);
}

function getInitializeAccountOwner(instruction: TransactionInstruction): PublicKey | undefined {
  switch (instruction.data[0]) {
    case 1:
      return instruction.keys[2]?.pubkey;
    case 16:
    case 18:
      return instruction.data.length >= 33
        ? new PublicKey(instruction.data.subarray(1, 33))
        : undefined;
    default:
      return undefined;
  }
}

function assertSafeSystemInstruction(
  instruction: TransactionInstruction,
  owner: PublicKey,
  allowedTransferRecipients: ReadonlySet<string>
): void {
  let type: ReturnType<typeof SystemInstruction.decodeInstructionType>;
  try {
    type = SystemInstruction.decodeInstructionType(instruction);
  } catch {
    throw new Error("Transaction contains an unrecognized top-level System instruction");
  }

  switch (type) {
    case "Transfer": {
      const { toPubkey } = SystemInstruction.decodeTransfer(instruction);
      if (!allowedTransferRecipients.has(toPubkey.toBase58())) {
        throw new Error(
          `Transaction transfers SOL to an unapproved recipient: ${toPubkey.toBase58()}`
        );
      }
      return;
    }
    case "TransferWithSeed": {
      const { toPubkey } = SystemInstruction.decodeTransferWithSeed(instruction);
      if (!allowedTransferRecipients.has(toPubkey.toBase58())) {
        throw new Error(
          `Transaction transfers SOL to an unapproved recipient: ${toPubkey.toBase58()}`
        );
      }
      return;
    }
    case "Create": {
      const params = SystemInstruction.decodeCreateAccount(instruction);
      if (!params.fromPubkey.equals(owner) || !isTokenProgram(params.programId)) {
        throw new Error("Transaction creates an account outside the wallet's token programs");
      }
      return;
    }
    case "CreateWithSeed": {
      const params = SystemInstruction.decodeCreateWithSeed(instruction);
      if (!params.fromPubkey.equals(owner) || !isTokenProgram(params.programId)) {
        throw new Error("Transaction creates an account outside the wallet's token programs");
      }
      return;
    }
    case "Assign": {
      if (!isTokenProgram(SystemInstruction.decodeAssign(instruction).programId)) {
        throw new Error("Transaction assigns an account outside the token programs");
      }
      return;
    }
    case "AssignWithSeed": {
      if (!isTokenProgram(SystemInstruction.decodeAssignWithSeed(instruction).programId)) {
        throw new Error("Transaction assigns an account outside the token programs");
      }
      return;
    }
    case "Allocate":
    case "AllocateWithSeed":
      return;
    default:
      throw new Error(`Transaction contains a disallowed top-level System instruction: ${type}`);
  }
}

export async function simulateVersionedTransaction(
  connection: Connection,
  tx: VersionedTransaction,
  balanceGuards?: SimulationBalanceGuards
): Promise<{ unitsConsumed?: number | null; logs?: string[] | null }> {
  const guardAddresses = balanceGuards
    ? [balanceGuards.owner, ...(balanceGuards.tokenAccounts ?? []).map((guard) => guard.account)]
    : undefined;
  const preAccounts = guardAddresses
    ? await connection.getMultipleAccountsInfo(guardAddresses)
    : undefined;

  const result = await connection.simulateTransaction(tx, {
    commitment: "confirmed",
    sigVerify: false,
    ...(guardAddresses
      ? {
          accounts: {
            encoding: "base64" as const,
            addresses: guardAddresses.map((address) => address.toBase58())
          }
        }
      : {})
  });
  if (result.value.err) {
    throw new Error(`Transaction simulation failed: ${JSON.stringify(result.value.err)}`);
  }

  if (balanceGuards && guardAddresses && preAccounts) {
    const postAccounts = result.value.accounts;
    if (!postAccounts || postAccounts.length !== guardAddresses.length) {
      throw new Error("Simulation did not return the account states needed for balance verification");
    }

    const ownerDelta =
      BigInt(postAccounts[0]?.lamports ?? 0) - BigInt(preAccounts[0]?.lamports ?? 0);
    if (ownerDelta < balanceGuards.minOwnerLamportsDelta) {
      throw new Error(
        `Simulated SOL balance change (${ownerDelta} lamports) is below the approved bound (${balanceGuards.minOwnerLamportsDelta} lamports)`
      );
    }

    (balanceGuards.tokenAccounts ?? []).forEach((guard, index) => {
      const pre = decodeTokenAmount(preAccounts[index + 1]?.data ?? null);
      const post = decodeSimulatedTokenAmount(postAccounts[index + 1]);
      const delta = post - pre;
      if (delta < guard.minDelta) {
        throw new Error(
          `Simulated ${guard.label} balance change (${delta}) is below the approved bound (${guard.minDelta})`
        );
      }
    });
  }

  return {
    unitsConsumed: result.value.unitsConsumed,
    logs: result.value.logs
  };
}

function decodeTokenAmount(data: Buffer | null): bigint {
  if (!data || data.length < ACCOUNT_SIZE) return 0n;
  return AccountLayout.decode(data).amount;
}

function decodeSimulatedTokenAmount(account: { data: string[] } | null): bigint {
  if (!account) return 0n;
  return decodeTokenAmount(Buffer.from(account.data[0] ?? "", "base64"));
}

export async function sendAndConfirmVersionedTransaction(
  connection: Connection,
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
      if (!blockhashValid || attempt === SEND_RETRY_COUNT) throw error;
      await sleep(CONFIRMATION_POLL_INTERVAL_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Transaction failed");
}

async function waitForConfirmedSignature(
  connection: Connection,
  signature: string,
  blockhash: string
): Promise<void> {
  const startedAt = Date.now();

  for (;;) {
    const statusResponse = await connection.getSignatureStatuses([signature]);
    const status = statusResponse.value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }

    const blockhashValid = await connection.isBlockhashValid(blockhash, { commitment: "confirmed" });
    if (!blockhashValid) {
      throw new Error(`Transaction blockhash expired before confirmation: ${signature}`);
    }
    if (Date.now() - startedAt > CONFIRMATION_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for confirmation: ${signature}`);
    }
    await sleep(CONFIRMATION_POLL_INTERVAL_MS);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
