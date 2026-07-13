"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const prompt_1 = require("./prompt");
(0, node_test_1.default)("ordinary writes may use --yes", () => {
    strict_1.default.equal((0, prompt_1.canAssumeYesForAction)("write"), true);
});
(0, node_test_1.default)("dangerous and secret actions need an explicit risk acknowledgement", () => {
    strict_1.default.equal((0, prompt_1.canAssumeYesForAction)("dangerous"), false);
    strict_1.default.equal((0, prompt_1.canAssumeYesForAction)("secret"), false);
    strict_1.default.equal((0, prompt_1.canAssumeYesForAction)("dangerous", true), true);
});
(0, node_test_1.default)("promptIfMissing preserves explicit values for automation", async () => {
    strict_1.default.equal(await (0, prompt_1.promptIfMissing)("provided", "unused"), "provided");
});
