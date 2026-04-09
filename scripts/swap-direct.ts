import { PublicKey } from "@solana/web3.js";
import { Token, TokenAmount, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { inspect } from "node:util";

import { loadConfig } from "../src/lib/config-manager";
import { decryptWallet } from "../src/lib/wallet-manager";
import { loadRaydium } from "../src/lib/raydium-client";

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

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

async function main() {
  const [, , poolIdArg, inputMintArg, amountArg, outputMintArg] = process.argv;
  if (!poolIdArg || !inputMintArg || !amountArg) {
    console.error("Usage: ts-node scripts/swap-direct.ts <poolId> <inputMint> <amount> [outputMint]");
    process.exit(1);
  }

  const password = process.env.WALLET_PASSWORD;
  if (!password) {
    console.error("Set WALLET_PASSWORD in your environment.");
    process.exit(1);
  }

  const config = await loadConfig({ createIfMissing: true });
  if (!config.activeWallet) {
    console.error("No active wallet set. Run `raydium wallet use <name>`.");
    process.exit(1);
  }

  const slippagePercent = config["default-slippage"];
  const slippage = slippagePercent / 100;
  const priorityFeeSol = config["priority-fee"];
  const priorityFeeMicroLamports = Math.round(priorityFeeSol * 1e15);

  const poolId = new PublicKey(poolIdArg).toBase58();
  const inputMint = new PublicKey(inputMintArg).toBase58();
  const outputMint = outputMintArg ? new PublicKey(outputMintArg).toBase58() : undefined;

  console.log("Inputs:");
  console.log("  poolId:", poolId);
  console.log("  inputMint:", inputMint);
  console.log("  outputMint:", outputMint ?? "(auto)");
  console.log("  amount:", amountArg);
  console.log("  slippage(%):", slippagePercent);
  console.log("  priorityFee(SOL):", priorityFeeSol);
  console.log("  activeWallet:", config.activeWallet);

  const owner = await decryptWallet(config.activeWallet, password);
  const raydium = await loadRaydium({ owner, disableLoadToken: true });

  const { poolInfo, poolKeys } = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
  const mintA = poolInfo.mintA;
  const mintB = poolInfo.mintB;

  console.log("Pool mints:");
  console.log("  mintA:", mintA.address, mintA.symbol ?? mintA.name ?? "");
  console.log("  mintB:", mintB.address, mintB.symbol ?? mintB.name ?? "");

  if (inputMint !== mintA.address && inputMint !== mintB.address) {
    throw new Error("Input mint does not match pool mints");
  }

  const derivedOutputMint = inputMint === mintA.address ? mintB.address : mintA.address;
  const resolvedOutputMint = outputMint ?? derivedOutputMint;
  if (resolvedOutputMint !== derivedOutputMint) {
    throw new Error("Output mint does not match pool mints");
  }

  const inputTokenInfo = inputMint === mintA.address ? mintA : mintB;
  const outputTokenInfo = inputMint === mintA.address ? mintB : mintA;
  const inputToken = buildTokenFromInfo(inputTokenInfo);
  const outputToken = buildTokenFromInfo(outputTokenInfo);
  const inputTokenAmount = new TokenAmount(inputToken, amountArg, false);

  const computed = raydium.liquidity.computeAmountOut({
    poolInfo,
    amountIn: inputTokenAmount.raw,
    mintIn: inputMint,
    mintOut: resolvedOutputMint,
    slippage
  });

  const estimatedOut = new TokenAmount(outputToken, computed.amountOut, true);
  const minOut = new TokenAmount(outputToken, computed.minAmountOut, true);

  console.log("Pool:", poolId);
  console.log("Input:", amountArg, inputTokenInfo.symbol ?? inputTokenInfo.address.slice(0, 6));
  console.log("Estimated output:", estimatedOut.toExact(), outputTokenInfo.symbol ?? outputTokenInfo.address.slice(0, 6));
  console.log("Minimum output:", minOut.toExact(), outputTokenInfo.symbol ?? outputTokenInfo.address.slice(0, 6));
  console.log("Slippage:", slippagePercent + "%");

  const computeBudgetConfig =
    priorityFeeMicroLamports > 0 ? { microLamports: priorityFeeMicroLamports } : undefined;

  const txData = await raydium.liquidity.swap({
    txVersion: TxVersion.V0,
    poolInfo,
    poolKeys,
    amountIn: inputTokenAmount.raw,
    amountOut: computed.minAmountOut,
    inputMint,
    fixedSide: "in",
    config: {
      associatedOnly: true,
      inputUseSolBalance: inputMint === WRAPPED_SOL_MINT,
      outputUseSolBalance: resolvedOutputMint === WRAPPED_SOL_MINT
    },
    computeBudgetConfig
  });

  const result = await txData.execute({ sendAndConfirm: true });
  console.log("Swap submitted:", result.txId);
}

main().catch((error) => {
  console.error("Swap failed:", error instanceof Error ? error.message : String(error ?? "Unknown error"));
  console.error(inspect(error, { depth: 6 }));
  process.exit(1);
});
