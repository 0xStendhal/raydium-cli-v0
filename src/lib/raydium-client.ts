import { Keypair, PublicKey } from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";

import { getConnection } from "./connection";
import { loadConfig } from "./config-manager";
import { Cluster } from "../types/config";

export async function getConfiguredCluster(): Promise<Cluster> {
  const config = await loadConfig({ createIfMissing: true });
  return config.cluster;
}

export async function loadRaydium(options?: {
  owner?: PublicKey | Keypair;
  disableLoadToken?: boolean;
}): Promise<Raydium> {
  const connection = await getConnection();
  const cluster = await getConfiguredCluster();

  return Raydium.load({
    connection,
    owner: options?.owner,
    disableLoadToken: options?.disableLoadToken ?? false,
    disableFeatureCheck: true,
    blockhashCommitment: "confirmed",
    apiRequestTimeout: 30000,
    cluster
  });
}
