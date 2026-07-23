import assert from "node:assert/strict";
import test from "node:test";

import { getRaydiumMintMetadata, resolveMintAddress, WRAPPED_SOL_MINT } from "./mint-resolver";

const RAY_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DUPLICATE_MINT = "A9mUUvGWRqTa4FJ1BCFE4ZZBBw3JcVkUy1LpLDKpab6q";

function mintListFetcher(tokens: Array<{ address: string; symbol: string; name?: string }>, blockList: string[] = []) {
  return async () => ({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        mintList: tokens,
        blockList
      }
    })
  });
}

test("keeps valid mint addresses on the fast path", async () => {
  let called = false;
  const resolved = await resolveMintAddress(USDC_MINT, {
    cluster: "mainnet",
    fetcher: async () => {
      called = true;
      throw new Error("fetch should not be called");
    }
  });

  assert.equal(resolved, USDC_MINT);
  assert.equal(called, false);
});

test("recognizes SOL aliases without fetching the Raydium list", async () => {
  const fetcher = async () => {
    throw new Error("fetch should not be called");
  };

  assert.equal(await resolveMintAddress("SOL", { cluster: "mainnet", fetcher }), WRAPPED_SOL_MINT);
  assert.equal(await resolveMintAddress("wsol", { cluster: "mainnet", fetcher }), WRAPPED_SOL_MINT);
});

test("resolves Raydium APIv3 mint-list symbols case-insensitively", async () => {
  const resolved = await resolveMintAddress("ray", {
    cluster: "mainnet",
    fetcher: mintListFetcher([{ address: RAY_MINT, symbol: "RAY", name: "Raydium" }])
  });

  assert.equal(resolved, RAY_MINT);
});

test("does not resolve blocklisted mints", async () => {
  await assert.rejects(
    resolveMintAddress("RAY", {
      cluster: "mainnet",
      fetcher: mintListFetcher([{ address: RAY_MINT, symbol: "RAY" }], [RAY_MINT])
    }),
    /Unknown token symbol/
  );
});

test("rejects ambiguous ticker symbols instead of guessing", async () => {
  await assert.rejects(
    resolveMintAddress("USDC", {
      cluster: "mainnet",
      fetcher: mintListFetcher([
        { address: USDC_MINT, symbol: "USDC", name: "USD Coin" },
        { address: DUPLICATE_MINT, symbol: "USDC", name: "Duplicate USD Coin" }
      ])
    }),
    /ambiguous/
  );
});

test("returns Raydium metadata by mint address for wallet display", async () => {
  const metadata = await getRaydiumMintMetadata([USDC_MINT], {
    cluster: "mainnet",
    fetcher: mintListFetcher([{ address: USDC_MINT, symbol: "USDC", name: "USD Coin" }])
  });

  assert.equal(metadata.get(USDC_MINT)?.symbol, "USDC");
  assert.equal(metadata.get(USDC_MINT)?.name, "USD Coin");
});

test("metadata lookup ignores blocklisted mint addresses", async () => {
  const metadata = await getRaydiumMintMetadata([USDC_MINT], {
    cluster: "mainnet",
    fetcher: mintListFetcher([{ address: USDC_MINT, symbol: "USDC", name: "USD Coin" }], [USDC_MINT])
  });

  assert.equal(metadata.has(USDC_MINT), false);
});
