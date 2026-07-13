"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getApiUrlsForCluster = void 0;
const raydium_sdk_v2_1 = require("@raydium-io/raydium-sdk-v2");
function getApiUrlsForCluster(cluster) {
    return cluster === "devnet" ? raydium_sdk_v2_1.DEV_API_URLS : raydium_sdk_v2_1.API_URLS;
}
exports.getApiUrlsForCluster = getApiUrlsForCluster;
