"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.explainError = void 0;
function errorText(error) {
    if (error instanceof Error)
        return error.message;
    return String(error ?? "Unknown error");
}
function explainError(error, fallback = "Command failed") {
    const details = errorText(error);
    const lower = details.toLowerCase();
    if (lower.includes("interactive prompts are disabled") || lower.includes("interactive prompts require a terminal")) {
        return {
            code: "MISSING_OPTIONS",
            message: "Required command inputs were not provided.",
            details,
            hints: ["Run this command in a terminal to answer prompts, or provide the required flags for automation."]
        };
    }
    if (lower.includes("eexist")) {
        return {
            code: "OUTPUT_EXISTS",
            message: "The output file already exists.",
            details,
            hints: ["Choose another path or pass --force to overwrite it."]
        };
    }
    if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized")) {
        return {
            code: "RPC_AUTH_FAILED",
            message: "The configured endpoint rejected its credentials.",
            details,
            hints: ["Check the RPC URL without printing API keys to shared logs.", "Update it with: raydium config set rpc-url <url>"]
        };
    }
    if (lower.includes("429") || lower.includes("rate limit")) {
        return {
            code: "RPC_RATE_LIMITED",
            message: "The RPC endpoint is rate limiting requests.",
            details,
            hints: ["Retry shortly.", "Configure a dedicated RPC with: raydium config set rpc-url <url>"]
        };
    }
    if (lower.includes("fetch failed") ||
        lower.includes("econnrefused") ||
        lower.includes("enotfound") ||
        lower.includes("network")) {
        return {
            code: "NETWORK_UNAVAILABLE",
            message: "The configured RPC or Raydium API could not be reached.",
            details,
            hints: ["Check the configured endpoint with: raydium status", "Retry after connectivity is restored."]
        };
    }
    if (lower.includes("insufficient") || lower.includes("0x1")) {
        return {
            code: "INSUFFICIENT_BALANCE",
            message: "The wallet does not have enough balance for this transaction.",
            details,
            hints: ["Check token and SOL balances with: raydium wallet balance", "Keep enough SOL for transaction fees."]
        };
    }
    if (lower.includes("slippage") || lower.includes("price moved")) {
        return {
            code: "SLIPPAGE_EXCEEDED",
            message: "The price moved outside the allowed slippage.",
            details,
            hints: ["Fetch a fresh quote and retry.", "Increase --slippage only after reviewing the price impact."]
        };
    }
    if (lower.includes("req_owner_account_error") || lower.includes("owner account")) {
        return {
            code: "OWNER_TOKEN_ACCOUNT_INVALID",
            message: "Raydium could not use one of the wallet token accounts for this swap.",
            details,
            hints: [
                "Check that the input token is held by the active wallet.",
                "For a buy, choose the token you are paying with as the input token.",
                "Refresh balances with: raydium wallet balance"
            ]
        };
    }
    if (lower.includes("blockhash") || lower.includes("timed out waiting for confirmation")) {
        return {
            code: "TRANSACTION_EXPIRED",
            message: "The transaction was not confirmed before it expired.",
            details,
            hints: ["Check the signature in the configured explorer if one was printed.", "Retry to build a transaction with a fresh blockhash."]
        };
    }
    return {
        code: "COMMAND_FAILED",
        message: fallback,
        details,
        hints: ["Run again with --debug for technical details."]
    };
}
exports.explainError = explainError;
