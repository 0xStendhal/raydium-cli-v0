import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import {
  AccountLayout,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";

import { getConnection } from "./connection";

export type RpcBalance = {
  mint: string;
  symbol: string;
  name: string;
  amount: string;
  raw: string;
  decimals: number;
};

export function formatAtomicAmount(raw: BN, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const rawStr = raw.toString().padStart(decimals + 1, "0");
  const whole = rawStr.slice(0, -decimals);
  const frac = rawStr.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export async function fetchSolBalance(owner: PublicKey): Promise<RpcBalance> {
  const connection = await getConnection();
  const lamports = await connection.getBalance(owner);
  const raw = new BN(lamports.toString());
  return {
    mint: "SOL",
    symbol: "SOL",
    name: "solana",
    amount: formatAtomicAmount(raw, 9),
    raw: raw.toString(),
    decimals: 9
  };
}

export async function fetchRpcBalances(owner: PublicKey): Promise<RpcBalance[]> {
  const connection = await getConnection();
  const [solBalance, splAccounts, token2022Accounts] = await Promise.all([
    connection.getBalance(owner),
    connection.getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
  ]);

  const tokenAccounts = [...splAccounts.value, ...token2022Accounts.value].map(({ account }) =>
    AccountLayout.decode(account.data)
  );

  const mintSet = new Set<string>();
  tokenAccounts.forEach((account) => mintSet.add(account.mint.toBase58()));
  const mintList = Array.from(mintSet);
  const mintInfos = new Map<string, number>();
  const batchSize = 100;

  for (let i = 0; i < mintList.length; i += batchSize) {
    const batch = mintList.slice(i, i + batchSize);
    const accounts = await connection.getMultipleAccountsInfo(
      batch.map((mint) => new PublicKey(mint))
    );
    accounts.forEach((info, idx) => {
      if (!info) return;
      const decoded = MintLayout.decode(info.data);
      mintInfos.set(batch[idx], decoded.decimals);
    });
  }

  const balances: RpcBalance[] = [
    {
      mint: "SOL",
      symbol: "SOL",
      name: "solana",
      amount: formatAtomicAmount(new BN(solBalance.toString()), 9),
      raw: solBalance.toString(),
      decimals: 9
    }
  ];

  const tokenTotals = new Map<string, BN>();
  tokenAccounts.forEach((account) => {
    const mint = account.mint.toBase58();
    const raw = new BN(account.amount.toString());
    tokenTotals.set(mint, (tokenTotals.get(mint) ?? new BN(0)).add(raw));
  });

  tokenTotals.forEach((raw, mint) => {
    if (raw.isZero()) return;
    const decimals = mintInfos.get(mint) ?? 0;
    const symbol = mint.slice(0, 6);
    balances.push({
      mint,
      symbol,
      name: symbol,
      amount: formatAtomicAmount(raw, decimals),
      raw: raw.toString(),
      decimals
    });
  });

  return balances;
}
