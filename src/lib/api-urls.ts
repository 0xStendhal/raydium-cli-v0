import { API_URLS, DEV_API_URLS } from "@raydium-io/raydium-sdk-v2";

import { Cluster } from "../types/config";

export function getApiUrlsForCluster(cluster: Cluster): typeof API_URLS {
  return cluster === "devnet" ? DEV_API_URLS : API_URLS;
}
