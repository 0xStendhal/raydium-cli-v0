"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertJsonQuoteApproval = exports.withQuoteApprovalId = exports.getQuoteApprovalId = void 0;
const crypto_1 = __importDefault(require("crypto"));
const output_1 = require("./output");
function getQuoteApprovalId(action, quote) {
    const payload = stableStringify({ action, quote });
    return crypto_1.default.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
exports.getQuoteApprovalId = getQuoteApprovalId;
function withQuoteApprovalId(action, quote) {
    return {
        ...quote,
        quoteId: getQuoteApprovalId(action, quote)
    };
}
exports.withQuoteApprovalId = withQuoteApprovalId;
function assertJsonQuoteApproval(params) {
    if (!(0, output_1.isJsonOutput)())
        return;
    const quoteId = getQuoteApprovalId(params.action, params.quote);
    if (!params.approvedQuoteId) {
        throw new Error(`JSON execution requires --approve-quote ${quoteId} from a fresh quote response`);
    }
    if (params.approvedQuoteId !== quoteId) {
        throw new Error(`Approved quote ID does not match the fresh quote. Expected ${quoteId}`);
    }
}
exports.assertJsonQuoteApproval = assertJsonQuoteApproval;
function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const record = value;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(",")}}`;
}
