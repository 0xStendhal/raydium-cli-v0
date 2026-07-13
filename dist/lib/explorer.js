"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.offerTransactionExplorer = exports.openUrlInBrowser = exports.getTransactionExplorerUrl = void 0;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const output_1 = require("./output");
const prompt_1 = require("./prompt");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
/**
 * Produces a transaction URL without any browser side effect. Include this URL
 * in JSON receipts so automated callers can decide whether to open it.
 */
function getTransactionExplorerUrl(options) {
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
exports.getTransactionExplorerUrl = getTransactionExplorerUrl;
/** Opens a URL through macOS Launch Services without invoking a shell. */
async function openUrlInBrowser(url) {
    if (process.platform !== "darwin") {
        throw new Error("Opening an explorer URL is only supported on macOS");
    }
    await execFileAsync("open", [url]);
}
exports.openUrlInBrowser = openUrlInBrowser;
/**
 * Offers to open a confirmed transaction in the configured explorer. JSON
 * output is always side-effect free; callers still receive the URL.
 */
async function offerTransactionExplorer(options, dependencies = {}) {
    const url = getTransactionExplorerUrl(options);
    if (dependencies.jsonOutput ?? (0, output_1.isJsonOutput)()) {
        return { url, opened: false };
    }
    // --yes must not launch a browser: auto-confirmation is consent to the
    // reviewed transaction, not to desktop side effects.
    const confirm = dependencies.confirm ??
        ((message) => ((0, prompt_1.isAssumeYes)() ? Promise.resolve(false) : (0, prompt_1.promptConfirm)(message, false)));
    const shouldOpen = await confirm(`Open confirmed transaction in ${options.explorer}?`);
    if (!shouldOpen)
        return { url, opened: false };
    await (dependencies.openUrl ?? openUrlInBrowser)(url);
    return { url, opened: true };
}
exports.offerTransactionExplorer = offerTransactionExplorer;
