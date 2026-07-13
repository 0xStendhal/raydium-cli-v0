"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const safe_transaction_1 = require("./safe-transaction");
function makeTransaction(instructions = [], signer = web3_js_1.Keypair.generate()) {
    const message = new web3_js_1.TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions
    }).compileToV0Message();
    const transaction = new web3_js_1.VersionedTransaction(message);
    transaction.sign([signer]);
    return transaction;
}
(0, node_test_1.default)("enforces payer, signer, and top-level program policy before signing", async () => {
    const owner = web3_js_1.Keypair.generate();
    const transaction = makeTransaction([
        web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
        web3_js_1.SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: owner.publicKey, lamports: 1 })
    ], owner);
    const connection = {};
    const allowedProgramIds = new Set([
        web3_js_1.ComputeBudgetProgram.programId.toBase58(),
        web3_js_1.SystemProgram.programId.toBase58(),
        spl_token_1.TOKEN_PROGRAM_ID.toBase58()
    ]);
    const preview = await (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, transaction, {
        owner: owner.publicKey,
        allowedProgramIds
    });
    strict_1.default.deepEqual(preview.programIds, [
        web3_js_1.ComputeBudgetProgram.programId.toBase58(),
        web3_js_1.SystemProgram.programId.toBase58()
    ]);
    const unknownProgramTransaction = makeTransaction([
        new web3_js_1.TransactionInstruction({ programId: web3_js_1.Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) })
    ], owner);
    await strict_1.default.rejects(() => (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, unknownProgramTransaction, {
        owner: owner.publicKey,
        allowedProgramIds
    }), /unapproved program/);
    await strict_1.default.rejects(() => (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, transaction, {
        owner: web3_js_1.Keypair.generate().publicKey,
        allowedProgramIds
    }), /fee payer does not match/);
    const extraSignerTransaction = makeTransaction([
        new web3_js_1.TransactionInstruction({
            programId: web3_js_1.SystemProgram.programId,
            keys: [{ pubkey: web3_js_1.Keypair.generate().publicKey, isSigner: true, isWritable: false }],
            data: Buffer.alloc(0)
        })
    ], owner);
    await strict_1.default.rejects(() => (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, extraSignerTransaction, {
        owner: owner.publicKey,
        allowedProgramIds
    }), /only required signer/);
    const unsafeTokenInstruction = makeTransaction([
        new web3_js_1.TransactionInstruction({ programId: spl_token_1.TOKEN_PROGRAM_ID, keys: [], data: Buffer.from([6]) })
    ], owner);
    await strict_1.default.rejects(() => (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, unsafeTokenInstruction, {
        owner: owner.publicKey,
        allowedProgramIds
    }), /unsafe top-level token-program instruction/);
});
(0, node_test_1.default)("rejects SOL transfers and token initializations that leave the wallet", async () => {
    const owner = web3_js_1.Keypair.generate();
    const connection = {};
    const allowedProgramIds = new Set([
        web3_js_1.SystemProgram.programId.toBase58(),
        spl_token_1.TOKEN_PROGRAM_ID.toBase58()
    ]);
    const drainTransaction = makeTransaction([
        web3_js_1.SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: web3_js_1.Keypair.generate().publicKey,
            lamports: 1000000000
        })
    ], owner);
    await strict_1.default.rejects(() => (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, drainTransaction, {
        owner: owner.publicKey,
        allowedProgramIds
    }), /unapproved recipient/);
    const wsolAta = (0, spl_token_1.getAssociatedTokenAddressSync)(spl_token_1.NATIVE_MINT, owner.publicKey);
    const wrapTransaction = makeTransaction([
        web3_js_1.SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: wsolAta, lamports: 1000000 }),
        new web3_js_1.TransactionInstruction({
            programId: spl_token_1.TOKEN_PROGRAM_ID,
            keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
            data: Buffer.from([17])
        })
    ], owner);
    await (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, wrapTransaction, {
        owner: owner.publicKey,
        allowedProgramIds
    });
    const foreignOwner = web3_js_1.Keypair.generate().publicKey;
    const initializeForAttacker = makeTransaction([
        new web3_js_1.TransactionInstruction({
            programId: spl_token_1.TOKEN_PROGRAM_ID,
            keys: [{ pubkey: web3_js_1.Keypair.generate().publicKey, isSigner: false, isWritable: true }],
            data: Buffer.concat([Buffer.from([18]), foreignOwner.toBuffer()])
        })
    ], owner);
    await strict_1.default.rejects(() => (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, initializeForAttacker, {
        owner: owner.publicKey,
        allowedProgramIds
    }), /owned by another wallet/);
    const tempAccount = web3_js_1.Keypair.generate().publicKey;
    const initializeAndFund = makeTransaction([
        new web3_js_1.TransactionInstruction({
            programId: spl_token_1.TOKEN_PROGRAM_ID,
            keys: [{ pubkey: tempAccount, isSigner: false, isWritable: true }],
            data: Buffer.concat([Buffer.from([18]), owner.publicKey.toBuffer()])
        }),
        web3_js_1.SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: tempAccount, lamports: 1000000 })
    ], owner);
    await (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, initializeAndFund, {
        owner: owner.publicKey,
        allowedProgramIds
    });
    const closeToAttacker = makeTransaction([
        new web3_js_1.TransactionInstruction({
            programId: spl_token_1.TOKEN_PROGRAM_ID,
            keys: [
                { pubkey: wsolAta, isSigner: false, isWritable: true },
                { pubkey: web3_js_1.Keypair.generate().publicKey, isSigner: false, isWritable: true },
                { pubkey: owner.publicKey, isSigner: true, isWritable: false }
            ],
            data: Buffer.from([9])
        })
    ], owner);
    await strict_1.default.rejects(() => (0, safe_transaction_1.validateVersionedTransactionPolicy)(connection, closeToAttacker, {
        owner: owner.publicKey,
        allowedProgramIds
    }), /closes a token account toward another wallet/);
});
function tokenAccountData(amount) {
    const data = Buffer.alloc(spl_token_1.ACCOUNT_SIZE);
    data.writeBigUInt64LE(amount, 64);
    return data;
}
(0, node_test_1.default)("verifies simulated balance deltas against the approved bounds", async () => {
    const owner = web3_js_1.Keypair.generate();
    const outputAccount = web3_js_1.Keypair.generate().publicKey;
    const makeConnection = (postOwnerLamports, postTokenAmount) => ({
        getMultipleAccountsInfo: async () => [
            { lamports: 10000000000, data: Buffer.alloc(0) },
            { lamports: 2039280, data: tokenAccountData(500n) }
        ],
        simulateTransaction: async () => ({
            value: {
                err: null,
                unitsConsumed: 5000,
                logs: [],
                accounts: [
                    { lamports: postOwnerLamports, data: ["", "base64"] },
                    { lamports: 2039280, data: [tokenAccountData(postTokenAmount).toString("base64"), "base64"] }
                ]
            }
        })
    });
    const guards = {
        owner: owner.publicKey,
        minOwnerLamportsDelta: -20000000n,
        tokenAccounts: [{ account: outputAccount, label: "output token account", minDelta: 1000n }]
    };
    // Within bounds: 0.01 SOL out, 1000 tokens in.
    await (0, safe_transaction_1.simulateVersionedTransaction)(makeConnection(9990000000, 1500n), makeTransaction([], owner), guards);
    // Drains more SOL than approved.
    await strict_1.default.rejects(() => (0, safe_transaction_1.simulateVersionedTransaction)(makeConnection(9000000000, 1500n), makeTransaction([], owner), guards), /SOL balance change/);
    // Delivers less output than the quoted minimum.
    await strict_1.default.rejects(() => (0, safe_transaction_1.simulateVersionedTransaction)(makeConnection(9990000000, 900n), makeTransaction([], owner), guards), /output token account balance change/);
});
(0, node_test_1.default)("summarizes and enforces a compute-budget priority fee", () => {
    const transaction = makeTransaction([
        web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
        web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 })
    ]);
    const preview = (0, safe_transaction_1.summarizeVersionedTransaction)(transaction);
    strict_1.default.deepEqual(preview.computeBudget, {
        unitLimit: 600000,
        microLamports: "20000",
        maximumPriorityFeeLamports: "12000"
    });
    strict_1.default.doesNotThrow(() => (0, safe_transaction_1.assertTransactionPriorityFeeBudget)(transaction, 20000, 12000n));
    strict_1.default.throws(() => (0, safe_transaction_1.assertTransactionPriorityFeeBudget)(transaction, 19999, 12000n), /exceeds the requested priority fee/);
    strict_1.default.throws(() => (0, safe_transaction_1.assertTransactionPriorityFeeBudget)(transaction, 20000, 11999n), /exceeds the CLI hard limit/);
    const unboundedTransaction = makeTransaction([
        web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 })
    ]);
    strict_1.default.throws(() => (0, safe_transaction_1.assertTransactionPriorityFeeBudget)(unboundedTransaction, 20000, 12000n), /without a bounded compute-unit limit/);
});
(0, node_test_1.default)("fails closed when transaction simulation reports an error", async () => {
    const connection = {
        simulateTransaction: async () => ({ value: { err: { InstructionError: [0, "Custom"] } } })
    };
    await strict_1.default.rejects(() => (0, safe_transaction_1.simulateVersionedTransaction)(connection, makeTransaction()), /Transaction simulation failed/);
});
(0, node_test_1.default)("sends and returns only a confirmed transaction", async () => {
    let sent = false;
    const connection = {
        sendRawTransaction: async () => {
            sent = true;
            return "confirmed-signature";
        },
        getSignatureStatuses: async () => ({
            value: [{ confirmationStatus: "confirmed", err: null }]
        })
    };
    const signature = await (0, safe_transaction_1.sendAndConfirmVersionedTransaction)(connection, makeTransaction());
    strict_1.default.equal(signature, "confirmed-signature");
    strict_1.default.equal(sent, true);
});
