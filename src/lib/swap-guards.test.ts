import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePriorityFeeMicroLamports,
  parseSlippagePercent
} from "./swap-guards";

test("accepts bounded slippage", () => {
  assert.equal(parseSlippagePercent("0.5", false).toString(), "0.5");
  assert.equal(parseSlippagePercent("5", false).toString(), "5");
});

test("requires acknowledgement for high slippage", () => {
  assert.throws(() => parseSlippagePercent("5.01", false), /allow-high-slippage/);
  assert.equal(parseSlippagePercent("5.01", true).toString(), "5.01");
  assert.throws(() => parseSlippagePercent("100.01", true), /cannot exceed 100%/);
});

test("requires acknowledgement for high priority fees", () => {
  assert.equal(parsePriorityFeeMicroLamports("0.01", false), 16_666_667);
  assert.throws(
    () => parsePriorityFeeMicroLamports("0.010000001", false),
    /allow-high-priority-fee/
  );
  assert.equal(parsePriorityFeeMicroLamports("0.02", true), 33_333_333);
  assert.throws(() => parsePriorityFeeMicroLamports("0.100000001", true), /cannot exceed 0.1 SOL/);
});
