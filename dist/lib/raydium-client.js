"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadRaydium = exports.getConfiguredCluster = void 0;
const raydium_sdk_v2_1 = require("@raydium-io/raydium-sdk-v2");
const connection_1 = require("./connection");
const config_manager_1 = require("./config-manager");
async function getConfiguredCluster() {
    const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
    return config.cluster;
}
exports.getConfiguredCluster = getConfiguredCluster;
async function loadRaydium(options) {
    const connection = await (0, connection_1.getConnection)();
    const cluster = await getConfiguredCluster();
    return raydium_sdk_v2_1.Raydium.load({
        connection,
        owner: options?.owner,
        disableLoadToken: options?.disableLoadToken ?? false,
        disableFeatureCheck: true,
        blockhashCommitment: "confirmed",
        apiRequestTimeout: 30000,
        cluster
    });
}
exports.loadRaydium = loadRaydium;
