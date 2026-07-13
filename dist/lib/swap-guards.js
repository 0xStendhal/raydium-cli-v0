"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePriorityFeeMicroLamports = exports.parseSlippagePercent = exports.MAX_PRIORITY_FEE_SOL = exports.MAX_SAFE_PRIORITY_FEE_SOL = exports.MAX_SLIPPAGE_PERCENT = exports.MAX_SAFE_SLIPPAGE_PERCENT = void 0;
const decimal_js_1 = __importDefault(require("decimal.js"));
exports.MAX_SAFE_SLIPPAGE_PERCENT = new decimal_js_1.default(5);
exports.MAX_SLIPPAGE_PERCENT = new decimal_js_1.default(100);
exports.MAX_SAFE_PRIORITY_FEE_SOL = new decimal_js_1.default("0.01");
exports.MAX_PRIORITY_FEE_SOL = new decimal_js_1.default("0.1");
const COMPUTE_UNITS = new decimal_js_1.default(600000);
function parseNonNegativeDecimal(value, label) {
    const normalized = value.trim();
    if (!/^\d+(\.\d+)?$/.test(normalized)) {
        throw new Error(`${label} must be a non-negative decimal number`);
    }
    const parsed = new decimal_js_1.default(normalized);
    if (!parsed.isFinite() || parsed.isNegative()) {
        throw new Error(`${label} must be a non-negative decimal number`);
    }
    return parsed;
}
function parseSlippagePercent(value, allowHigh) {
    const slippage = parseNonNegativeDecimal(value, "Slippage");
    if (slippage.gt(exports.MAX_SLIPPAGE_PERCENT)) {
        throw new Error(`Slippage cannot exceed ${exports.MAX_SLIPPAGE_PERCENT.toString()}%`);
    }
    if (!allowHigh && slippage.gt(exports.MAX_SAFE_SLIPPAGE_PERCENT)) {
        throw new Error(`Slippage above ${exports.MAX_SAFE_SLIPPAGE_PERCENT.toString()}% requires --allow-high-slippage`);
    }
    return slippage;
}
exports.parseSlippagePercent = parseSlippagePercent;
function parsePriorityFeeMicroLamports(value, allowHigh) {
    const feeSol = parseNonNegativeDecimal(value, "Priority fee");
    if (feeSol.gt(exports.MAX_PRIORITY_FEE_SOL)) {
        throw new Error(`Priority fee cannot exceed ${exports.MAX_PRIORITY_FEE_SOL.toString()} SOL`);
    }
    if (!allowHigh && feeSol.gt(exports.MAX_SAFE_PRIORITY_FEE_SOL)) {
        throw new Error(`Priority fee above ${exports.MAX_SAFE_PRIORITY_FEE_SOL.toString()} SOL requires --allow-high-priority-fee`);
    }
    const microLamports = feeSol
        .mul(new decimal_js_1.default(1e9))
        .mul(new decimal_js_1.default(1e6))
        .div(COMPUTE_UNITS)
        .toDecimalPlaces(0, decimal_js_1.default.ROUND_HALF_UP);
    if (microLamports.gt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Priority fee is too large to encode safely");
    }
    return microLamports.toNumber();
}
exports.parsePriorityFeeMicroLamports = parsePriorityFeeMicroLamports;
