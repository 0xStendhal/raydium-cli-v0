import { Connection } from "@solana/web3.js";

import { loadConfig } from "./config-manager";

export async function getConnection(): Promise<Connection> {
  const config = await loadConfig({ createIfMissing: true });
  return new Connection(config["rpc-url"], "confirmed");
}
