import { PublicKey } from "@solana/web3.js";

import { Cluster } from "../types/config";
import { getApiUrlsForCluster } from "./api-urls";
import { loadConfig } from "./config-manager";

export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

export type RaydiumMintListEntry = {
  address: string;
  symbol: string;
  name?: string;
  decimals?: number;
  tags?: string[];
};

type MintListResponse = {
  success?: boolean;
  data?: {
    mintList?: RaydiumMintListEntry[];
    blockList?: string[];
    blacklist?: string[];
  };
};

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

type ResolveMintOptions = {
  cluster?: Cluster;
  fetcher?: FetchLike;
};

const mintListCache = new Map<Cluster, RaydiumMintListEntry[]>();
const blockListCache = new Map<Cluster, Set<string>>();

function tryParsePublicKey(value: string): string | undefined {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return undefined;
  }
}

function formatCandidate(token: RaydiumMintListEntry): string {
  const name = token.name ? ` ${token.name}` : "";
  return `${token.symbol}${name} (${token.address})`;
}

async function fetchRaydiumMintList(
  cluster: Cluster,
  fetcher: FetchLike
): Promise<{ mintList: RaydiumMintListEntry[]; blockList: Set<string> }> {
  if (fetcher === fetch && mintListCache.has(cluster)) {
    return {
      mintList: mintListCache.get(cluster)!,
      blockList: blockListCache.get(cluster) ?? new Set()
    };
  }

  const api = getApiUrlsForCluster(cluster);
  const response = await fetcher(`${api.BASE_HOST}${api.TOKEN_LIST}`);
  if (!response.ok) {
    const status = response.status ? ` ${response.status}` : "";
    throw new Error(`Raydium mint list request failed with HTTP${status}`);
  }

  const json = await response.json() as MintListResponse;
  const mintList = json?.data?.mintList;
  if (!json?.success || !Array.isArray(mintList)) {
    throw new Error("Raydium mint list response did not include data.mintList");
  }

  const rawBlockList = json.data?.blockList ?? json.data?.blacklist ?? [];
  const blockList = new Set(rawBlockList.filter((mint): mint is string => typeof mint === "string"));

  if (fetcher === fetch) {
    mintListCache.set(cluster, mintList);
    blockListCache.set(cluster, blockList);
  }

  return { mintList, blockList };
}

export async function resolveMintAddress(
  value: string,
  options: ResolveMintOptions = {}
): Promise<string> {
  const token = value.trim();
  if (!token) throw new Error("Token mint or symbol is required");

  const mint = tryParsePublicKey(token);
  if (mint) return mint;

  const symbol = token.toUpperCase();
  if (symbol === "SOL" || symbol === "WSOL") return WRAPPED_SOL_MINT;

  const cluster = options.cluster ?? (await loadConfig({ createIfMissing: true })).cluster;
  const { mintList, blockList } = await fetchRaydiumMintList(cluster, options.fetcher ?? fetch);
  const matches = mintList.filter((entry) =>
    typeof entry.address === "string" &&
    typeof entry.symbol === "string" &&
    entry.symbol.toUpperCase() === symbol &&
    !blockList.has(entry.address)
  );

  if (matches.length === 1) return matches[0].address;

  if (matches.length > 1) {
    const candidates = matches.slice(0, 5).map(formatCandidate).join(", ");
    const suffix = matches.length > 5 ? `, and ${matches.length - 5} more` : "";
    throw new Error(`Token symbol "${token}" is ambiguous on Raydium APIv3 /mint/list: ${candidates}${suffix}. Use a mint address.`);
  }

  throw new Error(`Unknown token symbol "${token}". Use a mint address or a symbol from Raydium APIv3 /mint/list.`);
}

export async function resolveMintPublicKey(
  value: string,
  options: ResolveMintOptions = {}
): Promise<PublicKey> {
  return new PublicKey(await resolveMintAddress(value, options));
}
