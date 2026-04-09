import fs from "fs/promises";

import { CONFIG_DIR, CONFIG_PATH } from "./paths";
import { Cluster, ConfigData, DEFAULT_CONFIG, Explorer } from "../types/config";

const NUMBER_KEYS: Array<keyof ConfigData> = ["default-slippage", "priority-fee"];
const EXPLORER_VALUES: Explorer[] = ["solscan", "solanaFm", "solanaExplorer"];
const CLUSTER_VALUES: Cluster[] = ["mainnet", "devnet"];
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

export async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.chmod(CONFIG_DIR, CONFIG_DIR_MODE);
}

export async function loadConfig(options?: { createIfMissing?: boolean }): Promise<ConfigData> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigData>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const config = { ...DEFAULT_CONFIG };
      if (options?.createIfMissing) {
        await saveConfig(config);
      }
      return config;
    }
    throw error;
  }
}

export async function saveConfig(config: ConfigData): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  await fs.chmod(CONFIG_PATH, CONFIG_FILE_MODE);
}

export function isValidConfigKey(key: string): key is keyof ConfigData {
  return Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key);
}

export function parseConfigValue(key: keyof ConfigData, value: string): ConfigData[keyof ConfigData] {
  if (NUMBER_KEYS.includes(key)) {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`Invalid number for ${key}: ${value}`);
    return num;
  }

  if (key === "explorer") {
    if (!EXPLORER_VALUES.includes(value as Explorer)) {
      throw new Error(`Invalid explorer value. Use one of: ${EXPLORER_VALUES.join(", ")}`);
    }
    return value as Explorer;
  }

  if (key === "cluster") {
    if (!CLUSTER_VALUES.includes(value as Cluster)) {
      throw new Error(`Invalid cluster value. Use one of: ${CLUSTER_VALUES.join(", ")}`);
    }
    return value as Cluster;
  }

  if (key === "activeWallet") {
    if (value === "null") return null;
    return value;
  }

  if (key === "pinata-jwt") {
    if (value === "null" || value === "") return null;
    return value;
  }

  return value;
}
