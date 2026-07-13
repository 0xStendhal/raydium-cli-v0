const test = require("node:test");
const assert = require("node:assert/strict");

const { serializeCsv } = require("../dist/lib/csv");
const { redactRpcUrl, shortenAddress } = require("../dist/lib/context");
const { explainError } = require("../dist/lib/errors");

test("serializeCsv escapes commas, quotes, and newlines", () => {
  const output = serializeCsv(
    [{ name: "a,b", note: 'say "hello"\nnext' }],
    [
      { header: "name", value: (row) => row.name },
      { header: "note", value: (row) => row.note }
    ]
  );

  assert.equal(output, 'name,note\n"a,b","say ""hello""\nnext"\n');
});

test("redactRpcUrl omits credentials, paths, and query parameters", () => {
  assert.equal(
    redactRpcUrl("https://user:secret@example.com/private-key?token=secret"),
    "https://example.com"
  );
});

test("shortenAddress preserves recognizable address edges", () => {
  assert.equal(shortenAddress("1234567890abcdef"), "1234...cdef");
});

test("explainError maps rate limits to actionable guidance", () => {
  const guidance = explainError(new Error("HTTP 429"));
  assert.equal(guidance.code, "RPC_RATE_LIMITED");
  assert.ok(guidance.hints.some((hint) => hint.includes("rpc-url")));
});

test("explainError maps Raydium owner account failures to token-account guidance", () => {
  const guidance = explainError(new Error("Trade API serialize failed: REQ_OWNER_ACCOUNT_ERROR"));
  assert.equal(guidance.code, "OWNER_TOKEN_ACCOUNT_INVALID");
  assert.ok(guidance.hints.some((hint) => hint.includes("input token")));
});
