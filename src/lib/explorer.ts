import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Cluster, Explorer } from "../types/config";
import { isJsonOutput } from "./output";
import { isAssumeYes, promptConfirm } from "./prompt";

const execFileAsync = promisify(execFile);

export type OpenUrl = (url: string) => Promise<void>;
export type ConfirmOpen = (message: string) => Promise<boolean>;

export interface TransactionExplorerOptions {
  explorer: Explorer;
  cluster: Cluster;
  signature: string;
}

export interface TransactionExplorerResult {
  url: string;
  opened: boolean;
}

/**
 * Produces a transaction URL without any browser side effect. Include this URL
 * in JSON receipts so automated callers can decide whether to open it.
 */
export function getTransactionExplorerUrl(options: TransactionExplorerOptions): string {
  const signature = encodeURIComponent(options.signature);
  const clusterQuery = options.cluster === "devnet" ? "?cluster=devnet" : "";

  switch (options.explorer) {
    case "solscan":
      return `https://solscan.io/tx/${signature}${clusterQuery}`;
    case "solanaFm":
      return `https://solana.fm/tx/${signature}${options.cluster === "devnet" ? "?cluster=devnet-solana" : ""}`;
    case "solanaExplorer":
      return `https://explorer.solana.com/tx/${signature}${clusterQuery}`;
  }
}

/** Opens a URL through macOS Launch Services without invoking a shell. */
export async function openUrlInBrowser(url: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Opening an explorer URL is only supported on macOS");
  }
  await execFileAsync("open", [url]);
}

/**
 * Offers to open a confirmed transaction in the configured explorer. JSON
 * output is always side-effect free; callers still receive the URL.
 */
export async function offerTransactionExplorer(
  options: TransactionExplorerOptions,
  dependencies: {
    confirm?: ConfirmOpen;
    openUrl?: OpenUrl;
    jsonOutput?: boolean;
  } = {}
): Promise<TransactionExplorerResult> {
  const url = getTransactionExplorerUrl(options);
  if (dependencies.jsonOutput ?? isJsonOutput()) {
    return { url, opened: false };
  }

  // --yes must not launch a browser: auto-confirmation is consent to the
  // reviewed transaction, not to desktop side effects.
  const confirm =
    dependencies.confirm ??
    ((message: string) => (isAssumeYes() ? Promise.resolve(false) : promptConfirm(message, false)));
  const shouldOpen = await confirm(`Open confirmed transaction in ${options.explorer}?`);
  if (!shouldOpen) return { url, opened: false };

  await (dependencies.openUrl ?? openUrlInBrowser)(url);
  return { url, opened: true };
}
