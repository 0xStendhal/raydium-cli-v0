import assert from "node:assert/strict";
import test from "node:test";

import { canAssumeYesForAction, promptIfMissing } from "./prompt";

test("ordinary writes may use --yes", () => {
  assert.equal(canAssumeYesForAction("write"), true);
});

test("dangerous and secret actions need an explicit risk acknowledgement", () => {
  assert.equal(canAssumeYesForAction("dangerous"), false);
  assert.equal(canAssumeYesForAction("secret"), false);
  assert.equal(canAssumeYesForAction("dangerous", true), true);
});

test("promptIfMissing preserves explicit values for automation", async () => {
  assert.equal(await promptIfMissing("provided", "unused"), "provided");
});
