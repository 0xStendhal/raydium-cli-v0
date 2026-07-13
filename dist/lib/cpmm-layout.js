"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUnsupportedCpmmLayoutMessage = void 0;
const output_1 = require("./output");
const INVALID_BOOL_PATTERN = /^Invalid bool: \d+$/;
/**
 * The pinned SDK decodes CPMM configuration flags as a one-byte boolean.
 * A different value means the account layout no longer matches that decoder.
 */
function getUnsupportedCpmmLayoutMessage(error) {
    const message = (0, output_1.getErrorMessage)(error, "");
    if (!INVALID_BOOL_PATTERN.test(message))
        return undefined;
    return [
        "This CPMM pool uses an on-chain layout unsupported by the installed Raydium SDK.",
        "Pool inspection can use indexed API data, but CPMM quotes and transactions are disabled for this pool.",
        "Update and validate the SDK before attempting an on-chain CPMM action."
    ].join(" ");
}
exports.getUnsupportedCpmmLayoutMessage = getUnsupportedCpmmLayoutMessage;
