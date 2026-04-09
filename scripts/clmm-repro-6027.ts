import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PoolUtils, getPdaExBitmapAccount } from "@raydium-io/raydium-sdk-v2";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { SystemProgram } from "@solana/web3.js";

import { loadRaydium } from "../src/lib/raydium-client";

const SWAP_DISCRIMINATOR = createHash("sha256").update("global:swap").digest().subarray(0, 8);

function u64LE(x: BN): Buffer {
  return x.toArrayLike(Buffer, "le", 8);
}

function u128LE(x: BN): Buffer {
  return x.toArrayLike(Buffer, "le", 16);
}

function bool1(b: boolean): Buffer {
  return Buffer.from([b ? 1 : 0]);
}

function buildSwapSingleIx(args: {
  programId: PublicKey;
  payer: PublicKey;
  ammConfig: PublicKey;
  poolState: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  observationState: PublicKey;
  tickArray: PublicKey;
  remaining: PublicKey[];
  tickarrayBitmapExtension?: PublicKey;
  amount: BN;
  otherAmountThreshold: BN;
  sqrtPriceLimitX64: BN;
  isBaseInput: boolean;
}): TransactionInstruction {
  const keys = [
    { pubkey: args.payer, isSigner: true, isWritable: true },
    { pubkey: args.ammConfig, isSigner: false, isWritable: false },
    { pubkey: args.poolState, isSigner: false, isWritable: true },
    { pubkey: args.inputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: args.outputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: args.inputVault, isSigner: false, isWritable: true },
    { pubkey: args.outputVault, isSigner: false, isWritable: true },
    { pubkey: args.observationState, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: args.tickArray, isSigner: false, isWritable: true },
  ];

  const remainingMetas = [
    ...(args.tickarrayBitmapExtension
      ? [{ pubkey: args.tickarrayBitmapExtension, isSigner: false, isWritable: true }]
      : []),
    ...args.remaining.map((p) => ({ pubkey: p, isSigner: false, isWritable: true })),
  ];

  const data = Buffer.concat([
    Buffer.from(SWAP_DISCRIMINATOR),
    u64LE(args.amount),
    u64LE(args.otherAmountThreshold),
    u128LE(args.sqrtPriceLimitX64),
    bool1(args.isBaseInput),
  ]);

  return new TransactionInstruction({
    programId: args.programId,
    keys: [...keys, ...remainingMetas],
    data,
  });
}

async function main() {
  const [, , poolIdArg, inputMintArg, amountInArg, truncateAfterFirstArg, feePayerArg] = process.argv;
  if (!poolIdArg) {
    console.error(
      "Usage: ts-node scripts/clmm-repro-6027.ts <poolId> [inputMint] [amountInRaw] [truncateAfterFirstTickArrayCount] [feePayerPubkey]",
    );
    process.exit(1);
  }

  const poolId = new PublicKey(poolIdArg);
  const raydium = await loadRaydium({ disableLoadToken: true });
  const connection = raydium.connection;

  const { poolInfo, poolKeys, computePoolInfo, tickData } = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58());

  const mintA = new PublicKey(poolInfo.mintA.address);
  const mintB = new PublicKey(poolInfo.mintB.address);
  const inputMint = inputMintArg ? new PublicKey(inputMintArg) : mintA;
  if (!inputMint.equals(mintA) && !inputMint.equals(mintB)) {
    throw new Error("inputMint must be either mintA or mintB of the pool");
  }
  const isInputMintA = inputMint.equals(mintA);

  // Use vaults as dummy "user token accounts". The swap will fail before transfers if we trigger 6027.
  const vaultA = new PublicKey(poolKeys.vault.A);
  const vaultB = new PublicKey(poolKeys.vault.B);

  const inputVault = isInputMintA ? vaultA : vaultB;
  const outputVault = isInputMintA ? vaultB : vaultA;

  const amountIn = new BN(amountInArg ?? "1000000000"); // raw units
  const truncateAfterFirst = Number(truncateAfterFirstArg ?? "0"); // how many tick arrays to keep after the first
  if (!Number.isFinite(truncateAfterFirst) || truncateAfterFirst < 0) {
    throw new Error("truncateAfterFirstTickArrayCount must be a non-negative integer");
  }

  const tickArrayCache = tickData?.[poolId.toBase58()];
  if (!tickArrayCache) {
    throw new Error("tick array cache missing from SDK getPoolInfoFromRpc() result");
  }

  // Compute the full tick-array list that *should* be passed for this swap size.
  // If this list is longer than what we include in the instruction, the on-chain program should hit 6027.
  const computed = PoolUtils.getOutputAmountAndRemainAccounts(
    computePoolInfo,
    tickArrayCache,
    inputMint,
    amountIn,
    undefined,
    true,
  );

  const fullTickArrays = computed.remainingAccounts;
  if (fullTickArrays.length === 0) {
    throw new Error("SDK returned 0 tick arrays; cannot build swap");
  }

  const firstTickArray = fullTickArrays[0];
  const remainingFull = fullTickArrays.slice(1);
  const remainingTruncated = remainingFull.slice(0, truncateAfterFirst);

  const exBitmapPda = getPdaExBitmapAccount(new PublicKey(poolInfo.programId), poolId).publicKey;
  const exBitmapInfo = await connection.getAccountInfo(exBitmapPda, "confirmed");
  const includeExBitmap = !!exBitmapInfo; // only include if it exists on-chain

  // For simulation we need a fee payer that is a *system-owned* account with lamports.
  // We don't need the private key because we disable signature verification.
  const txPayer = feePayerArg ? new PublicKey(feePayerArg) : new PublicKey("B3EiKmf4DQBUwWuDvWc7bTztVNL98kngHJ9ZLme5JbCf");
  const txPayerInfo = await connection.getAccountInfo(txPayer, "confirmed");
  if (!txPayerInfo) throw new Error(`fee payer account not found on-chain: ${txPayer.toBase58()}`);
  if (!txPayerInfo.owner.equals(SystemProgram.programId)) {
    throw new Error(
      `fee payer is not system-owned (owner=${txPayerInfo.owner.toBase58()}): ${txPayer.toBase58()}`,
    );
  }
  if (txPayerInfo.lamports < 10_000) {
    throw new Error(`fee payer has too few lamports (${txPayerInfo.lamports}) to simulate fees safely`);
  }

  const ix = buildSwapSingleIx({
    programId: new PublicKey(poolInfo.programId),
    payer: txPayer,
    ammConfig: new PublicKey(poolInfo.config.id),
    poolState: poolId,
    inputTokenAccount: inputVault,
    outputTokenAccount: outputVault,
    inputVault,
    outputVault,
    observationState: new PublicKey(computePoolInfo.observationId),
    tickArray: firstTickArray,
    remaining: remainingTruncated,
    tickarrayBitmapExtension: includeExBitmap ? exBitmapPda : undefined,
    amount: amountIn,
    otherAmountThreshold: new BN(0),
    sqrtPriceLimitX64: new BN(0),
    isBaseInput: true,
  });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: txPayer,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  // Provide a placeholder signature; simulation will skip verification.
  tx.signatures = [Buffer.alloc(64, 1)];

  console.log("Pool:", poolId.toBase58());
  console.log("Program:", poolInfo.programId);
  console.log("InputMint:", inputMint.toBase58());
  console.log("AmountIn(raw):", amountIn.toString());
  console.log("SDK tickArrays needed:", fullTickArrays.length);
  console.log("Provided tickArrays:", 1 + remainingTruncated.length);
  console.log("Tx fee payer:", txPayer.toBase58());
  console.log("Included exBitmap PDA:", includeExBitmap ? exBitmapPda.toBase58() : "(not included)");
  console.log("Simulating...");

  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });

  if (sim.value.err) {
    console.error("Simulation error:", inspect(sim.value.err, { depth: 10 }));
  } else {
    console.log("Simulation succeeded (unexpected for reproduction).");
  }

  if (sim.value.logs?.length) {
    console.log("Logs:");
    for (const l of sim.value.logs) console.log(" ", l);
  }
}

main().catch((e) => {
  console.error("Failed:", e instanceof Error ? e.message : String(e ?? "Unknown error"));
  console.error(inspect(e, { depth: 6 }));
  process.exit(1);
});
