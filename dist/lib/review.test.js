"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const review_1 = require("./review");
(0, node_test_1.default)("formats an aligned review with context and warnings", () => {
    const output = (0, review_1.formatReviewPanel)({
        title: "SWAP REVIEW",
        context: "MAINNET",
        rows: [
            { label: "You pay", value: "1 SOL" },
            { label: "You receive", value: "143 USDC", tone: "positive" },
            { label: "Mint", value: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
        ],
        warnings: ["Verify the token mint before signing this transaction."]
    }, { color: false, width: 60 });
    strict_1.default.match(output, /^SWAP REVIEW  MAINNET/m);
    strict_1.default.match(output, /You pay\s+1 SOL/);
    strict_1.default.match(output, /You receive\s+143 USDC/);
    strict_1.default.match(output, /! Verify the token mint/);
    output.split("\n").forEach((line) => strict_1.default.ok(line.length <= 60, line));
});
(0, node_test_1.default)("wraps long values to the requested terminal width", () => {
    const output = (0, review_1.formatReviewPanel)({
        title: "REVIEW",
        rows: [{ label: "Details", value: "x".repeat(80) }]
    }, { color: false, width: 32 });
    output.split("\n").forEach((line) => strict_1.default.ok(line.length <= 32, line));
});
