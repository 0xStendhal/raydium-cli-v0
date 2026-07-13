"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConnection = void 0;
const web3_js_1 = require("@solana/web3.js");
const config_manager_1 = require("./config-manager");
async function getConnection() {
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    return new web3_js_1.Connection(config["rpc-url"], "confirmed");
}
exports.getConnection = getConnection;
