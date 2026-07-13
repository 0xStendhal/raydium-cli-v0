import assert from "node:assert/strict";
import test from "node:test";

import { getUnsupportedCpmmLayoutMessage } from "./cpmm-layout";

test("recognizes the CPMM layout decoder mismatch", () => {
  const message = getUnsupportedCpmmLayoutMessage(new Error("Invalid bool: 224"));

  assert.match(message ?? "", /on-chain layout unsupported/i);
  assert.match(message ?? "", /transactions are disabled/i);
});

test("does not mask unrelated RPC failures as layout drift", () => {
  assert.equal(getUnsupportedCpmmLayoutMessage(new Error("429 Too Many Requests")), undefined);
});
