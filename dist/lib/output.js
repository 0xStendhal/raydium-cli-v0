"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logGuidedError = exports.logErrorWithDebug = exports.getErrorDetails = exports.getErrorMessage = exports.withSpinner = exports.logDebug = exports.logError = exports.logSuccess = exports.logInfo = exports.logJson = exports.isDebugOutput = exports.setDebugOutput = exports.setQuietOutput = exports.isJsonOutput = exports.setJsonOutput = void 0;
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const util_1 = require("util");
let jsonOutput = false;
let debugOutput = false;
let quietOutput = false;
function setJsonOutput(enabled) {
    jsonOutput = enabled;
}
exports.setJsonOutput = setJsonOutput;
function isJsonOutput() {
    return jsonOutput;
}
exports.isJsonOutput = isJsonOutput;
function setQuietOutput(enabled) {
    quietOutput = enabled;
}
exports.setQuietOutput = setQuietOutput;
function setDebugOutput(enabled) {
    debugOutput = enabled;
}
exports.setDebugOutput = setDebugOutput;
function isDebugOutput() {
    return debugOutput;
}
exports.isDebugOutput = isDebugOutput;
function logJson(payload) {
    console.log(JSON.stringify(payload, null, 2));
}
exports.logJson = logJson;
function logInfo(message) {
    if (!jsonOutput && !quietOutput) {
        console.log(message);
    }
}
exports.logInfo = logInfo;
function logSuccess(message) {
    if (!jsonOutput && !quietOutput) {
        console.log(chalk_1.default.green(message));
    }
}
exports.logSuccess = logSuccess;
function logError(message, details) {
    if (jsonOutput) {
        logJson({ error: message, details });
        return;
    }
    console.error(chalk_1.default.red(message));
    if (details) {
        console.error(chalk_1.default.yellow(formatDetails(details)));
    }
}
exports.logError = logError;
function logDebug(details) {
    if (jsonOutput || !debugOutput)
        return;
    console.error(chalk_1.default.gray(formatDetails(details)));
}
exports.logDebug = logDebug;
async function withSpinner(text, task) {
    if (jsonOutput || quietOutput) {
        return task();
    }
    const spinner = (0, ora_1.default)(text).start();
    try {
        const result = await task();
        spinner.succeed();
        return result;
    }
    catch (error) {
        spinner.fail(text);
        throw error;
    }
}
exports.withSpinner = withSpinner;
function getErrorMessage(error, fallback) {
    if (error instanceof Error && error.message)
        return error.message;
    if (typeof error === "string" && error)
        return error;
    if (error && typeof error === "object") {
        const maybeMessage = error.message;
        if (typeof maybeMessage === "string" && maybeMessage)
            return maybeMessage;
        return (0, util_1.inspect)(error, { depth: 2, colors: false });
    }
    const str = String(error ?? "");
    return str || fallback;
}
exports.getErrorMessage = getErrorMessage;
function getErrorDetails(error, fallbackMessage) {
    const details = { message: getErrorMessage(error, fallbackMessage) };
    if (error instanceof Error && error.stack) {
        details.stack = error.stack;
    }
    const anyError = error;
    if (Array.isArray(anyError?.logs)) {
        details.logs = anyError.logs.map((entry) => String(entry));
    }
    if (Array.isArray(anyError?.simulationLogs)) {
        details.simulationLogs = anyError.simulationLogs.map((entry) => String(entry));
    }
    if (anyError?.signature)
        details.signature = String(anyError.signature);
    if (anyError?.txId)
        details.txId = String(anyError.txId);
    if (anyError?.cause)
        details.cause = anyError.cause;
    if (!details.cause && anyError?.error)
        details.cause = anyError.error;
    return details;
}
exports.getErrorDetails = getErrorDetails;
function logErrorWithDebug(message, error, options) {
    const fallback = options?.fallback ?? message;
    const summary = getErrorMessage(error, fallback);
    const debugEnabled = options?.debug ?? debugOutput;
    if (debugEnabled) {
        logError(message, getErrorDetails(error, summary));
        return;
    }
    logError(message, summary);
}
exports.logErrorWithDebug = logErrorWithDebug;
function logGuidedError(options) {
    const hints = options.hints ?? [];
    if (jsonOutput) {
        const details = options.details instanceof Error
            ? options.debug
                ? getErrorDetails(options.details, options.message)
                : getErrorMessage(options.details, options.message)
            : options.details;
        logJson({
            error: options.message,
            code: options.code,
            ...(details !== undefined && { details }),
            ...(hints.length > 0 && { hints })
        });
        return;
    }
    console.error(chalk_1.default.red(options.message));
    if (options.debug && options.details !== undefined) {
        console.error(chalk_1.default.yellow(formatDetails(options.details)));
    }
    if (hints.length > 0) {
        console.error(chalk_1.default.gray("Next steps:"));
        hints.forEach((hint) => console.error(chalk_1.default.gray(`  ${hint}`)));
    }
}
exports.logGuidedError = logGuidedError;
function formatDetails(details) {
    if (typeof details === "string")
        return details;
    if (details instanceof Error)
        return details.stack ?? details.message;
    return (0, util_1.inspect)(details, { depth: 6, colors: false });
}
