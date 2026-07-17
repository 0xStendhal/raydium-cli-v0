import assert from "node:assert/strict";
import test from "node:test";

import { renderTable } from "./output";

// Strip ANSI so assertions read against the visible text.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const plain = (value: string): string => value.replace(ANSI, "");

test("renderTable aligns columns to the widest visible cell", () => {
  const rendered = plain(
    renderTable(
      [{ header: "Token" }, { header: "Amount", align: "right" }],
      [
        ["SOL", "1.5"],
        ["USDC", "1200.25"]
      ]
    )
  );
  const lines = rendered.split("\n");

  assert.equal(lines.length, 3); // header + two rows
  // Every line is padded to the same visible width.
  assert.ok(lines.every((line) => line.length === lines[0].length));
  // Left column left-aligned, right column right-aligned.
  assert.ok(lines[0].startsWith("Token") && lines[0].endsWith("Amount"));
  assert.ok(lines[1].startsWith("SOL") && lines[1].endsWith("1.5"));
  assert.ok(lines[2].startsWith("USDC") && lines[2].endsWith("1200.25"));
});

test("renderTable measures width ignoring ANSI color codes", () => {
  const colored = "[32mSOL[39m"; // chalk.green("SOL"), visible width 3
  const rendered = renderTable(
    [{ header: "Token" }, { header: "V" }],
    [
      [colored, "x"],
      ["LONGERNAME", "y"]
    ]
  );
  const lines = rendered.split("\n");
  // The colored cell keeps its escape codes but pads as if width 3.
  assert.ok(lines[1].includes(colored));
  // Both data rows have their second column starting at the same visible offset.
  assert.equal(plain(lines[1]).indexOf("x"), plain(lines[2]).indexOf("y"));
});

test("renderTable returns empty string for no rows", () => {
  assert.equal(renderTable([{ header: "A" }], []), "");
});
