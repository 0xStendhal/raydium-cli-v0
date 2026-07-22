"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const output_1 = require("./output");
// Strip ANSI so assertions read against the visible text.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const plain = (value) => value.replace(ANSI, "");
(0, node_test_1.default)("renderTable aligns columns to the widest visible cell", () => {
    const rendered = plain((0, output_1.renderTable)([{ header: "Token" }, { header: "Amount", align: "right" }], [
        ["SOL", "1.5"],
        ["USDC", "1200.25"]
    ]));
    const lines = rendered.split("\n");
    strict_1.default.equal(lines.length, 3); // header + two rows
    // Every line is padded to the same visible width.
    strict_1.default.ok(lines.every((line) => line.length === lines[0].length));
    // Left column left-aligned, right column right-aligned.
    strict_1.default.ok(lines[0].startsWith("Token") && lines[0].endsWith("Amount"));
    strict_1.default.ok(lines[1].startsWith("SOL") && lines[1].endsWith("1.5"));
    strict_1.default.ok(lines[2].startsWith("USDC") && lines[2].endsWith("1200.25"));
});
(0, node_test_1.default)("renderTable measures width ignoring ANSI color codes", () => {
    const colored = "[32mSOL[39m"; // chalk.green("SOL"), visible width 3
    const rendered = (0, output_1.renderTable)([{ header: "Token" }, { header: "V" }], [
        [colored, "x"],
        ["LONGERNAME", "y"]
    ]);
    const lines = rendered.split("\n");
    // The colored cell keeps its escape codes but pads as if width 3.
    strict_1.default.ok(lines[1].includes(colored));
    // Both data rows have their second column starting at the same visible offset.
    strict_1.default.equal(plain(lines[1]).indexOf("x"), plain(lines[2]).indexOf("y"));
});
(0, node_test_1.default)("renderTable returns empty string for no rows", () => {
    strict_1.default.equal((0, output_1.renderTable)([{ header: "A" }], []), "");
});
