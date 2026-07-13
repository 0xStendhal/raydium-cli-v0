"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const swap_guards_1 = require("./swap-guards");
(0, node_test_1.default)("accepts bounded slippage", () => {
    strict_1.default.equal((0, swap_guards_1.parseSlippagePercent)("0.5", false).toString(), "0.5");
    strict_1.default.equal((0, swap_guards_1.parseSlippagePercent)("5", false).toString(), "5");
});
(0, node_test_1.default)("requires acknowledgement for high slippage", () => {
    strict_1.default.throws(() => (0, swap_guards_1.parseSlippagePercent)("5.01", false), /allow-high-slippage/);
    strict_1.default.equal((0, swap_guards_1.parseSlippagePercent)("5.01", true).toString(), "5.01");
    strict_1.default.throws(() => (0, swap_guards_1.parseSlippagePercent)("100.01", true), /cannot exceed 100%/);
});
(0, node_test_1.default)("requires acknowledgement for high priority fees", () => {
    strict_1.default.equal((0, swap_guards_1.parsePriorityFeeMicroLamports)("0.01", false), 16666667);
    strict_1.default.throws(() => (0, swap_guards_1.parsePriorityFeeMicroLamports)("0.010000001", false), /allow-high-priority-fee/);
    strict_1.default.equal((0, swap_guards_1.parsePriorityFeeMicroLamports)("0.02", true), 33333333);
    strict_1.default.throws(() => (0, swap_guards_1.parsePriorityFeeMicroLamports)("0.100000001", true), /cannot exceed 0.1 SOL/);
});
