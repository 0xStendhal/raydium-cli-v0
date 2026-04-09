export type Explorer = "solscan" | "solanaFm" | "solanaExplorer";
export type Cluster = "mainnet" | "devnet";

export interface ConfigData {
  cluster: Cluster;
  "rpc-url": string;
  "default-slippage": number;
  "explorer": Explorer;
  "priority-fee": number;
  "activeWallet": string | null;
  "pinata-jwt": string | null;
}

export const DEFAULT_CONFIG: ConfigData = {
  cluster: "mainnet",
  "rpc-url": "https://api.mainnet-beta.solana.com",
  "default-slippage": 0.5,
  "explorer": "solscan",
  "priority-fee": 0,
  "activeWallet": null,
  "pinata-jwt": null
};
