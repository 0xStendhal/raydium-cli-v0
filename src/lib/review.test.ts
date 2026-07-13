import assert from "node:assert/strict";
import test from "node:test";

import { formatReviewPanel } from "./review";

test("formats an aligned review with context and warnings", () => {
  const output = formatReviewPanel(
    {
      title: "SWAP REVIEW",
      context: "MAINNET",
      rows: [
        { label: "You pay", value: "1 SOL" },
        { label: "You receive", value: "143 USDC", tone: "positive" },
        { label: "Mint", value: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
      ],
      warnings: ["Verify the token mint before signing this transaction."]
    },
    { color: false, width: 60 }
  );

  assert.match(output, /^SWAP REVIEW  MAINNET/m);
  assert.match(output, /You pay\s+1 SOL/);
  assert.match(output, /You receive\s+143 USDC/);
  assert.match(output, /! Verify the token mint/);
  output.split("\n").forEach((line) => assert.ok(line.length <= 60, line));
});

test("wraps long values to the requested terminal width", () => {
  const output = formatReviewPanel(
    {
      title: "REVIEW",
      rows: [{ label: "Details", value: "x".repeat(80) }]
    },
    { color: false, width: 32 }
  );

  output.split("\n").forEach((line) => assert.ok(line.length <= 32, line));
});
