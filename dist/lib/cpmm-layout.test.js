"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const cpmm_layout_1 = require("./cpmm-layout");
(0, node_test_1.default)("recognizes the CPMM layout decoder mismatch", () => {
    const message = (0, cpmm_layout_1.getUnsupportedCpmmLayoutMessage)(new Error("Invalid bool: 224"));
    strict_1.default.match(message ?? "", /on-chain layout unsupported/i);
    strict_1.default.match(message ?? "", /transactions are disabled/i);
});
(0, node_test_1.default)("does not mask unrelated RPC failures as layout drift", () => {
    strict_1.default.equal((0, cpmm_layout_1.getUnsupportedCpmmLayoutMessage)(new Error("429 Too Many Requests")), undefined);
});
