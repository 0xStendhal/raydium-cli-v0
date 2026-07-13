import assert from "node:assert/strict";
import test from "node:test";

import {
  getTransactionExplorerUrl,
  offerTransactionExplorer
} from "./explorer";
import { setAssumeYes } from "./prompt";

const signature = "5YHi/unsafe?signature";

test("builds configured explorer URLs for mainnet and devnet", () => {
  assert.equal(
    getTransactionExplorerUrl({ explorer: "solscan", cluster: "mainnet", signature }),
    "https://solscan.io/tx/5YHi%2Funsafe%3Fsignature"
  );
  assert.equal(
    getTransactionExplorerUrl({ explorer: "solscan", cluster: "devnet", signature }),
    "https://solscan.io/tx/5YHi%2Funsafe%3Fsignature?cluster=devnet"
  );
  assert.equal(
    getTransactionExplorerUrl({ explorer: "solanaFm", cluster: "devnet", signature }),
    "https://solana.fm/tx/5YHi%2Funsafe%3Fsignature?cluster=devnet-solana"
  );
  assert.equal(
    getTransactionExplorerUrl({ explorer: "solanaExplorer", cluster: "devnet", signature }),
    "https://explorer.solana.com/tx/5YHi%2Funsafe%3Fsignature?cluster=devnet"
  );
});

test("does not prompt or open a browser for JSON output", async () => {
  let prompted = false;
  let opened = false;

  const result = await offerTransactionExplorer(
    { explorer: "solscan", cluster: "mainnet", signature },
    {
      jsonOutput: true,
      confirm: async () => {
        prompted = true;
        return true;
      },
      openUrl: async () => {
        opened = true;
      }
    }
  );

  assert.equal(result.opened, false);
  assert.equal(result.url, "https://solscan.io/tx/5YHi%2Funsafe%3Fsignature");
  assert.equal(prompted, false);
  assert.equal(opened, false);
});

test("opens only after an affirmative interactive confirmation", async () => {
  const openedUrls: string[] = [];
  const accepted = await offerTransactionExplorer(
    { explorer: "solanaExplorer", cluster: "mainnet", signature },
    {
      confirm: async () => true,
      openUrl: async (url) => {
        openedUrls.push(url);
      }
    }
  );
  assert.equal(accepted.opened, true);
  assert.deepEqual(openedUrls, [accepted.url]);

  const declined = await offerTransactionExplorer(
    { explorer: "solanaExplorer", cluster: "mainnet", signature },
    {
      confirm: async () => false,
      openUrl: async () => {
        throw new Error("must not open when declined");
      }
    }
  );
  assert.equal(declined.opened, false);
});

test("--yes (assume yes) never auto-opens the browser", async () => {
  setAssumeYes(true);
  try {
    let opened = false;
    const result = await offerTransactionExplorer(
      { explorer: "solscan", cluster: "mainnet", signature },
      {
        jsonOutput: false,
        openUrl: async () => {
          opened = true;
        }
      }
    );
    assert.equal(result.opened, false);
    assert.equal(opened, false);
  } finally {
    setAssumeYes(false);
  }
});
