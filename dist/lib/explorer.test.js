"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const explorer_1 = require("./explorer");
const prompt_1 = require("./prompt");
const signature = "5YHi/unsafe?signature";
(0, node_test_1.default)("builds configured explorer URLs for mainnet and devnet", () => {
    strict_1.default.equal((0, explorer_1.getTransactionExplorerUrl)({ explorer: "solscan", cluster: "mainnet", signature }), "https://solscan.io/tx/5YHi%2Funsafe%3Fsignature");
    strict_1.default.equal((0, explorer_1.getTransactionExplorerUrl)({ explorer: "solscan", cluster: "devnet", signature }), "https://solscan.io/tx/5YHi%2Funsafe%3Fsignature?cluster=devnet");
    strict_1.default.equal((0, explorer_1.getTransactionExplorerUrl)({ explorer: "solanaFm", cluster: "devnet", signature }), "https://solana.fm/tx/5YHi%2Funsafe%3Fsignature?cluster=devnet-solana");
    strict_1.default.equal((0, explorer_1.getTransactionExplorerUrl)({ explorer: "solanaExplorer", cluster: "devnet", signature }), "https://explorer.solana.com/tx/5YHi%2Funsafe%3Fsignature?cluster=devnet");
});
(0, node_test_1.default)("does not prompt or open a browser for JSON output", async () => {
    let prompted = false;
    let opened = false;
    const result = await (0, explorer_1.offerTransactionExplorer)({ explorer: "solscan", cluster: "mainnet", signature }, {
        jsonOutput: true,
        confirm: async () => {
            prompted = true;
            return true;
        },
        openUrl: async () => {
            opened = true;
        }
    });
    strict_1.default.equal(result.opened, false);
    strict_1.default.equal(result.url, "https://solscan.io/tx/5YHi%2Funsafe%3Fsignature");
    strict_1.default.equal(prompted, false);
    strict_1.default.equal(opened, false);
});
(0, node_test_1.default)("opens only after an affirmative interactive confirmation", async () => {
    const openedUrls = [];
    const accepted = await (0, explorer_1.offerTransactionExplorer)({ explorer: "solanaExplorer", cluster: "mainnet", signature }, {
        confirm: async () => true,
        openUrl: async (url) => {
            openedUrls.push(url);
        }
    });
    strict_1.default.equal(accepted.opened, true);
    strict_1.default.deepEqual(openedUrls, [accepted.url]);
    const declined = await (0, explorer_1.offerTransactionExplorer)({ explorer: "solanaExplorer", cluster: "mainnet", signature }, {
        confirm: async () => false,
        openUrl: async () => {
            throw new Error("must not open when declined");
        }
    });
    strict_1.default.equal(declined.opened, false);
});
(0, node_test_1.default)("--yes (assume yes) never auto-opens the browser", async () => {
    (0, prompt_1.setAssumeYes)(true);
    try {
        let opened = false;
        const result = await (0, explorer_1.offerTransactionExplorer)({ explorer: "solscan", cluster: "mainnet", signature }, {
            jsonOutput: false,
            openUrl: async () => {
                opened = true;
            }
        });
        strict_1.default.equal(result.opened, false);
        strict_1.default.equal(opened, false);
    }
    finally {
        (0, prompt_1.setAssumeYes)(false);
    }
});
