"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WALLETS_DIR = exports.CONFIG_PATH = exports.CONFIG_DIR = void 0;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
exports.CONFIG_DIR = path_1.default.join(os_1.default.homedir(), ".raydium-cli");
exports.CONFIG_PATH = path_1.default.join(exports.CONFIG_DIR, "config.json");
exports.WALLETS_DIR = path_1.default.join(exports.CONFIG_DIR, "wallets");
