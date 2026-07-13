"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAndConfirmVersionedTransaction = exports.simulateVersionedTransaction = exports.validateVersionedTransactionPolicy = exports.assertTransactionPriorityFeeBudget = exports.summarizeVersionedTransaction = void 0;
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const CONFIRMATION_POLL_INTERVAL_MS = 1200;
const CONFIRMATION_TIMEOUT_MS = 60000;
const SEND_RETRY_COUNT = 3;
const SAFE_TOP_LEVEL_TOKEN_INSTRUCTIONS = new Map([
    [1, "initialize-account"],
    [9, "close-account"],
    [16, "initialize-account-2"],
    [17, "sync-native"],
    [18, "initialize-account-3"]
]);
function summarizeVersionedTransaction(tx) {
    const accountKeys = tx.message.staticAccountKeys;
    let unitLimit;
    let microLamports;
    const programIds = [...new Set(tx.message.compiledInstructions
            .map((instruction) => {
            const programId = accountKeys[instruction.programIdIndex]?.toBase58();
            if (programId === web3_js_1.ComputeBudgetProgram.programId.toBase58()) {
                const data = Buffer.from(instruction.data);
                if (data[0] === 2 && data.length >= 5)
                    unitLimit = data.readUInt32LE(1);
                if (data[0] === 3 && data.length >= 9)
                    microLamports = data.readBigUInt64LE(1);
            }
            return programId;
        })
            .filter((programId) => Boolean(programId)))];
    const maximumPriorityFeeLamports = unitLimit !== undefined && microLamports !== undefined
        ? (BigInt(unitLimit) * microLamports + 999999n) / 1000000n
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
exports.summarizeVersionedTransaction = summarizeVersionedTransaction;
function assertTransactionPriorityFeeBudget(tx, requestedMicroLamports, maximumLamports) {
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
exports.assertTransactionPriorityFeeBudget = assertTransactionPriorityFeeBudget;
/**
 * Resolves V0 address lookup tables and rejects transaction shapes outside the
 * narrow program policy for the intended operation before the wallet signs.
 */
async function validateVersionedTransactionPolicy(connection, tx, policy) {
    const staticKeys = tx.message.staticAccountKeys;
    if (!staticKeys[0]?.equals(policy.owner)) {
        throw new Error("Transaction fee payer does not match the active wallet");
    }
    const signerCount = tx.message.header.numRequiredSignatures;
    const requiredSigners = staticKeys.slice(0, signerCount);
    if (requiredSigners.length !== 1 || !requiredSigners[0].equals(policy.owner)) {
        throw new Error("Safe execution requires the active wallet to be the only required signer");
    }
    const addressLookupTableAccounts = [];
    for (const lookup of tx.message.addressTableLookups) {
        const response = await connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" });
        if (!response.value) {
            throw new Error(`Transaction address lookup table is unavailable: ${lookup.accountKey.toBase58()}`);
        }
        addressLookupTableAccounts.push(response.value);
    }
    const accountKeys = tx.message.getAccountKeys({ addressLookupTableAccounts });
    const programIds = [...new Set(tx.message.compiledInstructions.map((instruction) => {
            const programId = accountKeys.get(instruction.programIdIndex);
            if (!programId)
                throw new Error("Transaction references an unresolved program account");
            return programId.toBase58();
        }))];
    const unapprovedPrograms = programIds.filter((programId) => !policy.allowedProgramIds.has(programId));
    if (unapprovedPrograms.length > 0) {
        throw new Error(`Transaction uses unapproved program(s): ${unapprovedPrograms.join(", ")}`);
    }
    const topLevelTokenInstructions = [];
    const decompiled = web3_js_1.TransactionMessage.decompile(tx.message, { addressLookupTableAccounts });
    const transferRecipients = new Set([
        policy.owner.toBase58(),
        (0, spl_token_1.getAssociatedTokenAddressSync)(spl_token_1.NATIVE_MINT, policy.owner).toBase58(),
        ...(policy.allowedSystemTransferRecipients ?? [])
    ]);
    for (const instruction of decompiled.instructions) {
        if (!isTokenProgram(instruction.programId))
            continue;
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
            if (tokenAccount)
                transferRecipients.add(tokenAccount.toBase58());
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
        if (!instruction.programId.equals(web3_js_1.SystemProgram.programId))
            continue;
        assertSafeSystemInstruction(instruction, policy.owner, transferRecipients);
    }
    return {
        ...assertTransactionPriorityFeeBudget(tx, Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)),
        programIds,
        topLevelTokenInstructions
    };
}
exports.validateVersionedTransactionPolicy = validateVersionedTransactionPolicy;
function isTokenProgram(programId) {
    return programId.equals(spl_token_1.TOKEN_PROGRAM_ID) || programId.equals(spl_token_1.TOKEN_2022_PROGRAM_ID);
}
function getInitializeAccountOwner(instruction) {
    switch (instruction.data[0]) {
        case 1:
            return instruction.keys[2]?.pubkey;
        case 16:
        case 18:
            return instruction.data.length >= 33
                ? new web3_js_1.PublicKey(instruction.data.subarray(1, 33))
                : undefined;
        default:
            return undefined;
    }
}
function assertSafeSystemInstruction(instruction, owner, allowedTransferRecipients) {
    let type;
    try {
        type = web3_js_1.SystemInstruction.decodeInstructionType(instruction);
    }
    catch {
        throw new Error("Transaction contains an unrecognized top-level System instruction");
    }
    switch (type) {
        case "Transfer": {
            const { toPubkey } = web3_js_1.SystemInstruction.decodeTransfer(instruction);
            if (!allowedTransferRecipients.has(toPubkey.toBase58())) {
                throw new Error(`Transaction transfers SOL to an unapproved recipient: ${toPubkey.toBase58()}`);
            }
            return;
        }
        case "TransferWithSeed": {
            const { toPubkey } = web3_js_1.SystemInstruction.decodeTransferWithSeed(instruction);
            if (!allowedTransferRecipients.has(toPubkey.toBase58())) {
                throw new Error(`Transaction transfers SOL to an unapproved recipient: ${toPubkey.toBase58()}`);
            }
            return;
        }
        case "Create": {
            const params = web3_js_1.SystemInstruction.decodeCreateAccount(instruction);
            if (!params.fromPubkey.equals(owner) || !isTokenProgram(params.programId)) {
                throw new Error("Transaction creates an account outside the wallet's token programs");
            }
            return;
        }
        case "CreateWithSeed": {
            const params = web3_js_1.SystemInstruction.decodeCreateWithSeed(instruction);
            if (!params.fromPubkey.equals(owner) || !isTokenProgram(params.programId)) {
                throw new Error("Transaction creates an account outside the wallet's token programs");
            }
            return;
        }
        case "Assign": {
            if (!isTokenProgram(web3_js_1.SystemInstruction.decodeAssign(instruction).programId)) {
                throw new Error("Transaction assigns an account outside the token programs");
            }
            return;
        }
        case "AssignWithSeed": {
            if (!isTokenProgram(web3_js_1.SystemInstruction.decodeAssignWithSeed(instruction).programId)) {
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
async function simulateVersionedTransaction(connection, tx, balanceGuards) {
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
                    encoding: "base64",
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
        const ownerDelta = BigInt(postAccounts[0]?.lamports ?? 0) - BigInt(preAccounts[0]?.lamports ?? 0);
        if (ownerDelta < balanceGuards.minOwnerLamportsDelta) {
            throw new Error(`Simulated SOL balance change (${ownerDelta} lamports) is below the approved bound (${balanceGuards.minOwnerLamportsDelta} lamports)`);
        }
        (balanceGuards.tokenAccounts ?? []).forEach((guard, index) => {
            const pre = decodeTokenAmount(preAccounts[index + 1]?.data ?? null);
            const post = decodeSimulatedTokenAmount(postAccounts[index + 1]);
            const delta = post - pre;
            if (delta < guard.minDelta) {
                throw new Error(`Simulated ${guard.label} balance change (${delta}) is below the approved bound (${guard.minDelta})`);
            }
        });
    }
    return {
        unitsConsumed: result.value.unitsConsumed,
        logs: result.value.logs
    };
}
exports.simulateVersionedTransaction = simulateVersionedTransaction;
function decodeTokenAmount(data) {
    if (!data || data.length < spl_token_1.ACCOUNT_SIZE)
        return 0n;
    return spl_token_1.AccountLayout.decode(data).amount;
}
function decodeSimulatedTokenAmount(account) {
    if (!account)
        return 0n;
    return decodeTokenAmount(Buffer.from(account.data[0] ?? "", "base64"));
}
async function sendAndConfirmVersionedTransaction(connection, tx) {
    const serialized = tx.serialize();
    const blockhash = tx.message.recentBlockhash;
    let lastError;
    for (let attempt = 1; attempt <= SEND_RETRY_COUNT; attempt += 1) {
        try {
            const signature = await connection.sendRawTransaction(serialized, {
                skipPreflight: false,
                preflightCommitment: "confirmed",
                maxRetries: 3
            });
            await waitForConfirmedSignature(connection, signature, blockhash);
            return signature;
        }
        catch (error) {
            lastError = error;
            const blockhashValid = await connection.isBlockhashValid(blockhash, {
                commitment: "confirmed"
            });
            if (!blockhashValid || attempt === SEND_RETRY_COUNT)
                throw error;
            await sleep(CONFIRMATION_POLL_INTERVAL_MS * attempt);
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Transaction failed");
}
exports.sendAndConfirmVersionedTransaction = sendAndConfirmVersionedTransaction;
async function waitForConfirmedSignature(connection, signature, blockhash) {
    const startedAt = Date.now();
    for (;;) {
        const statusResponse = await connection.getSignatureStatuses([signature]);
        const status = statusResponse.value[0];
        if (status?.err)
            throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
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
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
