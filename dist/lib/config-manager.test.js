"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const config_1 = require("../types/config");
const config_manager_1 = require("./config-manager");
(0, node_test_1.default)("redacts configured secrets while preserving ordinary config", () => {
    const config = {
        ...config_1.DEFAULT_CONFIG,
        "pinata-jwt": "secret-token",
        activeWallet: "trader"
    };
    const redacted = (0, config_manager_1.redactConfig)(config);
    strict_1.default.equal(redacted["pinata-jwt"], "<redacted>");
    strict_1.default.equal(redacted.activeWallet, "trader");
    strict_1.default.equal(redacted.cluster, config_1.DEFAULT_CONFIG.cluster);
});
(0, node_test_1.default)("keeps empty secret config values empty", () => {
    strict_1.default.equal((0, config_manager_1.redactConfigValue)("pinata-jwt", null), null);
});
