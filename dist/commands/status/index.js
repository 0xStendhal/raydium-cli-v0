"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerStatusCommand = void 0;
const balances_1 = require("../../lib/balances");
const config_manager_1 = require("../../lib/config-manager");
const context_1 = require("../../lib/context");
const output_1 = require("../../lib/output");
const wallet_manager_1 = require("../../lib/wallet-manager");
function registerStatusCommand(program) {
    program
        .command("status")
        .description("Show active wallet and network context")
        .option("--no-balance", "Skip the SOL balance RPC request")
        .action(async (options) => {
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(undefined, config.activeWallet);
        const rpc = (0, context_1.redactRpcUrl)(config["rpc-url"]);
        if (!walletName) {
            if ((0, output_1.isJsonOutput)()) {
                (0, output_1.logJson)({ cluster: config.cluster, rpc, wallet: null, publicKey: null, sol: null });
            }
            else {
                (0, output_1.logInfo)(`${config.cluster} | wallet none | RPC ${rpc}`);
                (0, output_1.logInfo)("Set an active wallet with: raydium wallet use <name>");
            }
            return;
        }
        const publicKey = await (0, wallet_manager_1.getWalletPublicKey)(walletName);
        const sol = options.balance
            ? await (0, output_1.withSpinner)("Fetching SOL balance", async () => (await (0, balances_1.fetchSolBalance)(publicKey)).amount)
            : null;
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({
                cluster: config.cluster,
                rpc,
                wallet: walletName,
                publicKey: publicKey.toBase58(),
                sol
            });
            return;
        }
        const balance = sol === null ? "SOL skipped" : `${sol} SOL`;
        (0, output_1.logInfo)(`${config.cluster} | wallet ${walletName} (${(0, context_1.shortenAddress)(publicKey.toBase58())}) | ${balance} | RPC ${rpc}`);
    });
}
exports.registerStatusCommand = registerStatusCommand;
