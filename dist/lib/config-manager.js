"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseConfigValue = exports.redactConfig = exports.redactConfigValue = exports.isValidConfigKey = exports.saveConfig = exports.loadConfig = exports.ensureConfigDir = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const paths_1 = require("./paths");
const config_1 = require("../types/config");
const NUMBER_KEYS = ["default-slippage", "priority-fee"];
const EXPLORER_VALUES = ["solscan", "solanaFm", "solanaExplorer"];
const CLUSTER_VALUES = ["mainnet", "devnet"];
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const SECRET_CONFIG_KEYS = new Set(["pinata-jwt"]);
async function ensureConfigDir() {
    await promises_1.default.mkdir(paths_1.CONFIG_DIR, { recursive: true });
    await promises_1.default.chmod(paths_1.CONFIG_DIR, CONFIG_DIR_MODE);
}
exports.ensureConfigDir = ensureConfigDir;
async function loadConfig(options) {
    try {
        const raw = await promises_1.default.readFile(paths_1.CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return { ...config_1.DEFAULT_CONFIG, ...parsed };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            const config = { ...config_1.DEFAULT_CONFIG };
            if (options?.createIfMissing) {
                await saveConfig(config);
            }
            return config;
        }
        throw error;
    }
}
exports.loadConfig = loadConfig;
async function saveConfig(config) {
    await ensureConfigDir();
    await promises_1.default.writeFile(paths_1.CONFIG_PATH, JSON.stringify(config, null, 2));
    await promises_1.default.chmod(paths_1.CONFIG_PATH, CONFIG_FILE_MODE);
}
exports.saveConfig = saveConfig;
function isValidConfigKey(key) {
    return Object.prototype.hasOwnProperty.call(config_1.DEFAULT_CONFIG, key);
}
exports.isValidConfigKey = isValidConfigKey;
function redactConfigValue(key, value) {
    if (!SECRET_CONFIG_KEYS.has(key))
        return value;
    return value ? "<redacted>" : null;
}
exports.redactConfigValue = redactConfigValue;
function redactConfig(config) {
    return Object.fromEntries(Object.entries(config).map(([key, value]) => [
        key,
        redactConfigValue(key, value)
    ]));
}
exports.redactConfig = redactConfig;
function parseConfigValue(key, value) {
    if (NUMBER_KEYS.includes(key)) {
        const num = Number(value);
        if (!Number.isFinite(num))
            throw new Error(`Invalid number for ${key}: ${value}`);
        return num;
    }
    if (key === "explorer") {
        if (!EXPLORER_VALUES.includes(value)) {
            throw new Error(`Invalid explorer value. Use one of: ${EXPLORER_VALUES.join(", ")}`);
        }
        return value;
    }
    if (key === "cluster") {
        if (!CLUSTER_VALUES.includes(value)) {
            throw new Error(`Invalid cluster value. Use one of: ${CLUSTER_VALUES.join(", ")}`);
        }
        return value;
    }
    if (key === "activeWallet") {
        if (value === "null")
            return null;
        return value;
    }
    if (key === "pinata-jwt") {
        if (value === "null" || value === "")
            return null;
        return value;
    }
    return value;
}
exports.parseConfigValue = parseConfigValue;
