import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import { ACCOUNT_SIZE, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import {
  assertTransactionPriorityFeeBudget,
  sendAndConfirmVersionedTransaction,
  simulateVersionedTransaction,
  summarizeVersionedTransaction,
  validateVersionedTransactionPolicy
} from "./safe-transaction";

function makeTransaction(
  instructions: TransactionInstruction[] = [],
  signer = Keypair.generate()
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([signer]);
  return transaction;
}

test("enforces payer, signer, and top-level program policy before signing", async () => {
  const owner = Keypair.generate();
  const transaction = makeTransaction([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: owner.publicKey, lamports: 1 })
  ], owner);
  const connection = {} as Connection;
  const allowedProgramIds = new Set([
    ComputeBudgetProgram.programId.toBase58(),
    SystemProgram.programId.toBase58(),
    TOKEN_PROGRAM_ID.toBase58()
  ]);

  const preview = await validateVersionedTransactionPolicy(connection, transaction, {
    owner: owner.publicKey,
    allowedProgramIds
  });
  assert.deepEqual(preview.programIds, [
    ComputeBudgetProgram.programId.toBase58(),
    SystemProgram.programId.toBase58()
  ]);

  const unknownProgramTransaction = makeTransaction([
    new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) })
  ], owner);
  await assert.rejects(
    () => validateVersionedTransactionPolicy(connection, unknownProgramTransaction, {
      owner: owner.publicKey,
      allowedProgramIds
    }),
    /unapproved program/
  );

  await assert.rejects(
    () => validateVersionedTransactionPolicy(connection, transaction, {
      owner: Keypair.generate().publicKey,
      allowedProgramIds
    }),
    /fee payer does not match/
  );

  const extraSignerTransaction = makeTransaction([
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [{ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false }],
      data: Buffer.alloc(0)
    })
  ], owner);
  await assert.rejects(
    () => validateVersionedTransactionPolicy(connection, extraSignerTransaction, {
      owner: owner.publicKey,
      allowedProgramIds
    }),
    /only required signer/
  );

  const unsafeTokenInstruction = makeTransaction([
    new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [], data: Buffer.from([6]) })
  ], owner);
  await assert.rejects(
    () => validateVersionedTransactionPolicy(connection, unsafeTokenInstruction, {
      owner: owner.publicKey,
      allowedProgramIds
    }),
    /unsafe top-level token-program instruction/
  );
});

test("rejects SOL transfers and token initializations that leave the wallet", async () => {
  const owner = Keypair.generate();
  const connection = {} as Connection;
  const allowedProgramIds = new Set([
    SystemProgram.programId.toBase58(),
    TOKEN_PROGRAM_ID.toBase58()
  ]);

  const drainTransaction = makeTransaction([
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000_000_000
    })
  ], owner);
  await assert.rejects(
    () => validateVersionedTransactionPolicy(connection, drainTransaction, {
      owner: owner.publicKey,
      allowedProgramIds
    }),
    /unapproved recipient/
  );

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner.publicKey);
  const wrapTransaction = makeTransaction([
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: wsolAta, lamports: 1_000_000 }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
      data: Buffer.from([17])
    })
  ], owner);
  await validateVersionedTransactionPolicy(connection, wrapTransaction, {
    owner: owner.publicKey,
    allowedProgramIds
  });

  const foreignOwner = Keypair.generate().publicKey;
  const initializeForAttacker = makeTransaction([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
      data: Buffer.concat([Buffer.from([18]), foreignOwner.toBuffer()])
    })
  ], owner);
  await assert.rejects(
    () => validateVersionedTransactionPolicy(connection, initializeForAttacker, {
      owner: owner.publicKey,
      allowedProgramIds
    }),
    /owned by another wallet/
  );

  const tempAccount = Keypair.generate().publicKey;
  const initializeAndFund = makeTransaction([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: tempAccount, isSigner: false, isWritable: true }],
      data: Buffer.concat([Buffer.from([18]), owner.publicKey.toBuffer()])
    }),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: tempAccount, lamports: 1_000_000 })
  ], owner);
  await validateVersionedTransactionPolicy(connection, initializeAndFund, {
    owner: owner.publicKey,
    allowedProgramIds
  });

  const closeToAttacker = makeTransaction([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: wsolAta, isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false }
      ],
      data: Buffer.from([9])
    })
  ], owner);
  await assert.rejects(
    () => validateVersionedTransactionPolicy(connection, closeToAttacker, {
      owner: owner.publicKey,
      allowedProgramIds
    }),
    /closes a token account toward another wallet/
  );
});

function tokenAccountData(amount: bigint): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

test("verifies simulated balance deltas against the approved bounds", async () => {
  const owner = Keypair.generate();
  const outputAccount = Keypair.generate().publicKey;

  const makeConnection = (postOwnerLamports: number, postTokenAmount: bigint) => ({
    getMultipleAccountsInfo: async () => [
      { lamports: 10_000_000_000, data: Buffer.alloc(0) },
      { lamports: 2_039_280, data: tokenAccountData(500n) }
    ],
    simulateTransaction: async () => ({
      value: {
        err: null,
        unitsConsumed: 5_000,
        logs: [],
        accounts: [
          { lamports: postOwnerLamports, data: ["", "base64"] },
          { lamports: 2_039_280, data: [tokenAccountData(postTokenAmount).toString("base64"), "base64"] }
        ]
      }
    })
  }) as unknown as Connection;

  const guards = {
    owner: owner.publicKey,
    minOwnerLamportsDelta: -20_000_000n,
    tokenAccounts: [{ account: outputAccount, label: "output token account", minDelta: 1_000n }]
  };

  // Within bounds: 0.01 SOL out, 1000 tokens in.
  await simulateVersionedTransaction(makeConnection(9_990_000_000, 1_500n), makeTransaction([], owner), guards);

  // Drains more SOL than approved.
  await assert.rejects(
    () => simulateVersionedTransaction(makeConnection(9_000_000_000, 1_500n), makeTransaction([], owner), guards),
    /SOL balance change/
  );

  // Delivers less output than the quoted minimum.
  await assert.rejects(
    () => simulateVersionedTransaction(makeConnection(9_990_000_000, 900n), makeTransaction([], owner), guards),
    /output token account balance change/
  );
});

test("summarizes and enforces a compute-budget priority fee", () => {
  const transaction = makeTransaction([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 })
  ]);

  const preview = summarizeVersionedTransaction(transaction);
  assert.deepEqual(preview.computeBudget, {
    unitLimit: 600_000,
    microLamports: "20000",
    maximumPriorityFeeLamports: "12000"
  });
  assert.doesNotThrow(() => assertTransactionPriorityFeeBudget(transaction, 20_000, 12_000n));
  assert.throws(
    () => assertTransactionPriorityFeeBudget(transaction, 19_999, 12_000n),
    /exceeds the requested priority fee/
  );
  assert.throws(
    () => assertTransactionPriorityFeeBudget(transaction, 20_000, 11_999n),
    /exceeds the CLI hard limit/
  );

  const unboundedTransaction = makeTransaction([
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 })
  ]);
  assert.throws(
    () => assertTransactionPriorityFeeBudget(unboundedTransaction, 20_000, 12_000n),
    /without a bounded compute-unit limit/
  );
});

test("fails closed when transaction simulation reports an error", async () => {
  const connection = {
    simulateTransaction: async () => ({ value: { err: { InstructionError: [0, "Custom"] } } })
  } as unknown as Connection;

  await assert.rejects(
    () => simulateVersionedTransaction(connection, makeTransaction()),
    /Transaction simulation failed/
  );
});

test("sends and returns only a confirmed transaction", async () => {
  let sent = false;
  const connection = {
    sendRawTransaction: async () => {
      sent = true;
      return "confirmed-signature";
    },
    getSignatureStatuses: async () => ({
      value: [{ confirmationStatus: "confirmed", err: null }]
    })
  } as unknown as Connection;

  const signature = await sendAndConfirmVersionedTransaction(connection, makeTransaction());
  assert.equal(signature, "confirmed-signature");
  assert.equal(sent, true);
});
