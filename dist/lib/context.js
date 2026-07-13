"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactRpcUrl = exports.shortenAddress = void 0;
function shortenAddress(value, leading = 4, trailing = 4) {
    if (value.length <= leading + trailing + 3)
        return value;
    return `${value.slice(0, leading)}...${value.slice(-trailing)}`;
}
exports.shortenAddress = shortenAddress;
function redactRpcUrl(value) {
    try {
        const parsed = new URL(value);
        return `${parsed.protocol}//${parsed.host}`;
    }
    catch {
        return "configured RPC";
    }
}
exports.redactRpcUrl = redactRpcUrl;
