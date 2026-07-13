"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readSecretFromFile = exports.readSecretFromStdin = exports.promptSelect = exports.promptNumberIfMissing = exports.promptIfMissing = exports.promptInput = exports.promptActionConfirmation = exports.canAssumeYesForAction = exports.promptConfirm = exports.promptSecretInput = exports.promptPassword = exports.canPromptInteractively = exports.setAllowUnsafeSecretFlags = exports.setPasswordStdin = exports.setPassword = exports.isAssumeYes = exports.setAssumeYes = void 0;
const inquirer_1 = __importDefault(require("inquirer"));
const promises_1 = __importDefault(require("fs/promises"));
const output_1 = require("./output");
let assumeYes = false;
let passwordLiteral;
let usePasswordStdin = false;
let cachedPasswordStdin;
let cachedGenericStdin;
let cachedGenericStdinFlag;
let allowUnsafeSecretFlags = false;
function setAssumeYes(enabled) {
    assumeYes = enabled;
}
exports.setAssumeYes = setAssumeYes;
function isAssumeYes() {
    return assumeYes;
}
exports.isAssumeYes = isAssumeYes;
function setPassword(value) {
    passwordLiteral = value;
}
exports.setPassword = setPassword;
function setPasswordStdin(enabled) {
    usePasswordStdin = enabled;
}
exports.setPasswordStdin = setPasswordStdin;
function setAllowUnsafeSecretFlags(enabled) {
    allowUnsafeSecretFlags = enabled;
}
exports.setAllowUnsafeSecretFlags = setAllowUnsafeSecretFlags;
function canPromptInteractively() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !(0, output_1.isJsonOutput)();
}
exports.canPromptInteractively = canPromptInteractively;
function ensureInteractiveAllowed() {
    if ((0, output_1.isJsonOutput)()) {
        throw new Error("Interactive prompts are disabled with --json. Provide all required flags.");
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Interactive prompts require a terminal. Provide all required flags for automation.");
    }
}
function ensureUnsafeSecretFlagsAllowed(flagName) {
    if (!allowUnsafeSecretFlags) {
        throw new Error(`${flagName} is disabled by default because CLI flags leak into shell history and process lists. ` +
            `Use stdin, interactive entry, or pass --unsafe-secret-flags to acknowledge the risk.`);
    }
}
async function readPasswordFromStdin() {
    if (cachedPasswordStdin !== undefined)
        return cachedPasswordStdin;
    if (cachedGenericStdinFlag && cachedGenericStdinFlag !== "--password-stdin") {
        throw new Error(`stdin is already reserved for ${cachedGenericStdinFlag}. Use a file-based secret input or interactive prompt for the password.`);
    }
    if (process.stdin.isTTY) {
        throw new Error("--password-stdin requires piping a value via stdin");
    }
    const chunks = [];
    const input = process.stdin;
    input.setEncoding("utf8");
    for await (const chunk of input) {
        chunks.push(chunk);
    }
    const value = chunks.join("").trim();
    if (!value) {
        throw new Error("No password received on stdin");
    }
    cachedPasswordStdin = value;
    cachedGenericStdin = value;
    cachedGenericStdinFlag = "--password-stdin";
    return value;
}
async function promptPassword(message = "Enter password", confirm = false) {
    if (passwordLiteral) {
        ensureUnsafeSecretFlagsAllowed("--password");
        return passwordLiteral;
    }
    if (usePasswordStdin) {
        return readPasswordFromStdin();
    }
    ensureInteractiveAllowed();
    const { password } = await inquirer_1.default.prompt([
        {
            type: "password",
            name: "password",
            message,
            mask: "*",
            validate: (input) => (input ? true : "Password is required")
        }
    ]);
    if (!confirm)
        return password;
    const { confirmPassword } = await inquirer_1.default.prompt([
        {
            type: "password",
            name: "confirmPassword",
            message: "Confirm password",
            mask: "*",
            validate: (input) => (input ? true : "Password confirmation is required")
        }
    ]);
    if (password !== confirmPassword) {
        throw new Error("Passwords do not match");
    }
    return password;
}
exports.promptPassword = promptPassword;
async function promptSecretInput(message) {
    ensureInteractiveAllowed();
    const { value } = await inquirer_1.default.prompt([
        {
            type: "password",
            name: "value",
            message,
            mask: "*",
            validate: (input) => (input ? true : "Value is required")
        }
    ]);
    return value;
}
exports.promptSecretInput = promptSecretInput;
async function promptConfirm(message, defaultValue = false) {
    if (assumeYes)
        return true;
    ensureInteractiveAllowed();
    const { ok } = await inquirer_1.default.prompt([
        {
            type: "confirm",
            name: "ok",
            message,
            default: defaultValue
        }
    ]);
    return ok;
}
exports.promptConfirm = promptConfirm;
function canAssumeYesForAction(risk, allowExplicitRiskAcknowledgement = false) {
    return risk === "write" || allowExplicitRiskAcknowledgement;
}
exports.canAssumeYesForAction = canAssumeYesForAction;
async function promptActionConfirmation(options) {
    const risk = options.risk ?? "write";
    if (assumeYes && canAssumeYesForAction(risk, options.allowExplicitRiskAcknowledgement)) {
        return true;
    }
    ensureInteractiveAllowed();
    if (risk === "write") {
        return promptConfirm(options.message, false);
    }
    const expectedText = options.expectedText;
    if (!expectedText) {
        throw new Error(`Typed confirmation text is required for ${risk} actions`);
    }
    const { confirmation } = await inquirer_1.default.prompt([
        {
            type: "input",
            name: "confirmation",
            message: `${options.message} Type ${expectedText} to continue`,
            validate: (input) => input === expectedText ? true : `Enter ${expectedText} exactly, or press Ctrl+C to cancel`
        }
    ]);
    return confirmation === expectedText;
}
exports.promptActionConfirmation = promptActionConfirmation;
async function promptInput(message, defaultValue, validate) {
    ensureInteractiveAllowed();
    const { value } = await inquirer_1.default.prompt([
        {
            type: "input",
            name: "value",
            message,
            default: defaultValue,
            validate: (input) => {
                if (!input)
                    return "Value is required";
                return validate ? validate(input) : true;
            }
        }
    ]);
    return value;
}
exports.promptInput = promptInput;
/**
 * Resolve a required command input without forcing it into the command line.
 * Explicit values remain useful for scripts; interactive users are prompted
 * when they omit the value.
 */
async function promptIfMissing(value, message, validate) {
    return value !== undefined && value.trim() !== ""
        ? value
        : promptInput(message, undefined, validate);
}
exports.promptIfMissing = promptIfMissing;
async function promptNumberIfMissing(value, message, validate = (input) => Number.isFinite(Number(input)) ? true : "Enter a valid number") {
    return promptIfMissing(value, message, validate);
}
exports.promptNumberIfMissing = promptNumberIfMissing;
async function promptSelect(message, choices) {
    ensureInteractiveAllowed();
    const { value } = await inquirer_1.default.prompt([
        {
            type: "list",
            name: "value",
            message,
            choices
        }
    ]);
    return value;
}
exports.promptSelect = promptSelect;
async function readSecretFromStdin(label, flagName) {
    if (cachedGenericStdin !== undefined) {
        if (cachedGenericStdinFlag !== flagName) {
            throw new Error(`stdin is already reserved for ${cachedGenericStdinFlag}. Use a file-based secret input or interactive prompt for ${label}.`);
        }
        return cachedGenericStdin;
    }
    if (process.stdin.isTTY) {
        throw new Error(`${flagName} requires piping a value via stdin`);
    }
    const chunks = [];
    const input = process.stdin;
    input.setEncoding("utf8");
    for await (const chunk of input) {
        chunks.push(chunk);
    }
    const value = chunks.join("").trim();
    if (!value) {
        throw new Error(`No ${label} received on stdin`);
    }
    cachedGenericStdin = value;
    cachedGenericStdinFlag = flagName;
    return value;
}
exports.readSecretFromStdin = readSecretFromStdin;
async function readSecretFromFile(filePath, label) {
    const value = (await promises_1.default.readFile(filePath, "utf8")).trim();
    if (!value) {
        throw new Error(`No ${label} found in file: ${filePath}`);
    }
    return value;
}
exports.readSecretFromFile = readSecretFromFile;
