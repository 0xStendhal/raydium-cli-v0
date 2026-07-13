"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const wizard_1 = require("./wizard");
(0, node_test_1.default)("wizard revisits the previous step when the user goes back", async () => {
    let firstPrompts = 0;
    let secondPrompts = 0;
    const steps = [
        {
            key: "first",
            prompt: async () => (++firstPrompts === 1 ? "initial" : "revised")
        },
        {
            key: "second",
            prompt: async () => (++secondPrompts === 1 ? wizard_1.WIZARD_BACK : "complete")
        }
    ];
    const result = await (0, wizard_1.runWizard)({}, steps);
    strict_1.default.deepEqual(result, {
        status: "completed",
        values: { first: "revised", second: "complete" }
    });
});
(0, node_test_1.default)("wizard stops without returning partial values when cancelled", async () => {
    const result = await (0, wizard_1.runWizard)({}, [
        { key: "first", prompt: async () => wizard_1.WIZARD_CANCEL }
    ]);
    strict_1.default.deepEqual(result, { status: "cancelled" });
});
