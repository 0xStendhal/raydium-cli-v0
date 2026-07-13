"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const quote_approval_1 = require("./quote-approval");
(0, node_test_1.default)("builds stable quote IDs independent of object key order", () => {
    const quoteA = {
        poolId: "pool",
        input: { mint: "mint-a", amount: "1" },
        output: { mint: "mint-b", minimum: "2" }
    };
    const quoteB = {
        output: { minimum: "2", mint: "mint-b" },
        input: { amount: "1", mint: "mint-a" },
        poolId: "pool"
    };
    strict_1.default.equal((0, quote_approval_1.getQuoteApprovalId)("swap-quote", quoteA), (0, quote_approval_1.getQuoteApprovalId)("swap-quote", quoteB));
});
(0, node_test_1.default)("includes the command action in quote IDs", () => {
    const quote = { poolId: "pool", input: { amount: "1" } };
    strict_1.default.notEqual((0, quote_approval_1.getQuoteApprovalId)("swap-quote", quote), (0, quote_approval_1.getQuoteApprovalId)("cpmm-swap-quote", quote));
});
(0, node_test_1.default)("adds quoteId without mutating the quote", () => {
    const quote = { poolId: "pool" };
    const result = (0, quote_approval_1.withQuoteApprovalId)("swap-quote", quote);
    strict_1.default.equal(result.poolId, "pool");
    strict_1.default.equal(typeof result.quoteId, "string");
    strict_1.default.equal("quoteId" in quote, false);
});
