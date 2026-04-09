#!/usr/bin/env node
const fs = require("fs/promises");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const bigintBufferDir = path.join(ROOT, "node_modules", "bigint-buffer");
const nodeEntry = path.join(bigintBufferDir, "dist", "node.js");

const PURE_JS_NODE_ENTRY = `'use strict';

Object.defineProperty(exports, "__esModule", { value: true });

function toBigIntLE(buf) {
    const reversed = Buffer.from(buf);
    reversed.reverse();
    const hex = reversed.toString('hex');
    if (hex.length === 0) {
        return BigInt(0);
    }
    return BigInt(\`0x\${hex}\`);
}
exports.toBigIntLE = toBigIntLE;

function toBigIntBE(buf) {
    const hex = buf.toString('hex');
    if (hex.length === 0) {
        return BigInt(0);
    }
    return BigInt(\`0x\${hex}\`);
}
exports.toBigIntBE = toBigIntBE;

function toBufferLE(num, width) {
    const hex = num.toString(16);
    const buffer = Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');
    buffer.reverse();
    return buffer;
}
exports.toBufferLE = toBufferLE;

function toBufferBE(num, width) {
    const hex = num.toString(16);
    return Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');
}
exports.toBufferBE = toBufferBE;
`;

async function main() {
  try {
    await fs.access(bigintBufferDir);
  } catch {
    console.log("force-bigint-buffer-js: bigint-buffer not installed, skipping");
    return;
  }

  const current = await fs.readFile(nodeEntry, "utf8");
  if (current === PURE_JS_NODE_ENTRY) {
    console.log("force-bigint-buffer-js: bigint-buffer already forced to pure JS");
    return;
  }

  await fs.writeFile(nodeEntry, PURE_JS_NODE_ENTRY, "utf8");
  console.log("force-bigint-buffer-js: forced bigint-buffer to pure JS");
}

main().catch((error) => {
  console.error("force-bigint-buffer-js: failed", error);
  process.exitCode = 1;
});
