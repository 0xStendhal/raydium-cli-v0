import assert from "node:assert/strict";
import test from "node:test";

import { getQuoteApprovalId, withQuoteApprovalId } from "./quote-approval";

test("builds stable quote IDs independent of object key order", () => {
  const quoteA = {
    poolId: "pool",
    input: { mint: "mint-a", amount: "1" },
    output: { mint: "mint-b", minimum: "2" }
  };
  const quoteB = {
    output: { minimum: "2", mint: "mint-b" },
    input: { amount: "1", mint: "mint-a" },
    poolId: "pool"
  };

  assert.equal(getQuoteApprovalId("swap-quote", quoteA), getQuoteApprovalId("swap-quote", quoteB));
});

test("includes the command action in quote IDs", () => {
  const quote = { poolId: "pool", input: { amount: "1" } };

  assert.notEqual(
    getQuoteApprovalId("swap-quote", quote),
    getQuoteApprovalId("cpmm-swap-quote", quote)
  );
});

test("adds quoteId without mutating the quote", () => {
  const quote = { poolId: "pool" };
  const result = withQuoteApprovalId("swap-quote", quote);

  assert.equal(result.poolId, "pool");
  assert.equal(typeof result.quoteId, "string");
  assert.equal("quoteId" in quote, false);
});
