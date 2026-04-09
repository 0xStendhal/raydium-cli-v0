import os from "os";
import path from "path";

export const CONFIG_DIR = path.join(os.homedir(), ".raydium-cli");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const WALLETS_DIR = path.join(CONFIG_DIR, "wallets");
