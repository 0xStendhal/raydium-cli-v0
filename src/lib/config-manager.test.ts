import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../types/config";
import { redactConfig, redactConfigValue } from "./config-manager";

test("redacts configured secrets while preserving ordinary config", () => {
  const config = {
    ...DEFAULT_CONFIG,
    "pinata-jwt": "secret-token",
    activeWallet: "trader"
  };

  const redacted = redactConfig(config);

  assert.equal(redacted["pinata-jwt"], "<redacted>");
  assert.equal(redacted.activeWallet, "trader");
  assert.equal(redacted.cluster, DEFAULT_CONFIG.cluster);
});

test("keeps empty secret config values empty", () => {
  assert.equal(redactConfigValue("pinata-jwt", null), null);
});
