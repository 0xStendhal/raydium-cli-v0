"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTransactionCommands = void 0;
const connection_1 = require("../../lib/connection");
const config_manager_1 = require("../../lib/config-manager");
const explorer_1 = require("../../lib/explorer");
const output_1 = require("../../lib/output");
const prompt_1 = require("../../lib/prompt");
function registerTransactionCommands(program) {
    const tx = program.command("tx").description("Read-only transaction diagnostics");
    tx
        .command("inspect")
        .description("Show confirmed transaction status, logs, costs, and explorer URL")
        .argument("[signature]", "Transaction signature (prompted when omitted)")
        .action(async (signature) => {
        signature = await (0, prompt_1.promptIfMissing)(signature, "Transaction signature");
        try {
            const [connection, config] = await Promise.all([
                (0, connection_1.getConnection)(),
                (0, config_manager_1.loadConfig)({ createIfMissing: true })
            ]);
            const result = await (0, output_1.withSpinner)("Fetching transaction", () => connection.getTransaction(signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0
            }));
            const explorerUrl = (0, explorer_1.getTransactionExplorerUrl)({
                explorer: config.explorer,
                cluster: config.cluster,
                signature
            });
            if (!result) {
                const status = await connection.getSignatureStatuses([signature]);
                const payload = {
                    signature,
                    found: false,
                    status: status.value[0]?.confirmationStatus ?? null,
                    error: status.value[0]?.err ?? null,
                    explorerUrl
                };
                if ((0, output_1.isJsonOutput)()) {
                    (0, output_1.logJson)(payload);
                }
                else {
                    (0, output_1.logInfo)(`Transaction was not available from this RPC at confirmed commitment.`);
                    (0, output_1.logInfo)(`Explorer: ${explorerUrl}`);
                }
                process.exitCode = 1;
                return;
            }
            const payload = {
                signature,
                found: true,
                slot: result.slot,
                blockTime: result.blockTime,
                version: result.version,
                error: result.meta?.err ?? null,
                feeLamports: result.meta?.fee ?? null,
                computeUnitsConsumed: result.meta?.computeUnitsConsumed ?? null,
                logs: result.meta?.logMessages ?? [],
                explorerUrl
            };
            if ((0, output_1.isJsonOutput)()) {
                (0, output_1.logJson)(payload);
            }
            else {
                (0, output_1.logInfo)(`Transaction: ${signature}`);
                (0, output_1.logInfo)(`Slot: ${payload.slot}`);
                (0, output_1.logInfo)(`Status: ${payload.error ? "failed" : "succeeded"}`);
                (0, output_1.logInfo)(`Fee: ${payload.feeLamports ?? "unavailable"} lamports`);
                (0, output_1.logInfo)(`Compute units: ${payload.computeUnitsConsumed ?? "unavailable"}`);
                (0, output_1.logInfo)(`Explorer: ${explorerUrl}`);
                if (payload.logs.length > 0) {
                    (0, output_1.logInfo)("Logs:");
                    payload.logs.forEach((line) => (0, output_1.logInfo)(`  ${line}`));
                }
            }
        }
        catch (error) {
            (0, output_1.logErrorWithDebug)("Failed to inspect transaction", error);
            process.exitCode = 1;
        }
    });
}
exports.registerTransactionCommands = registerTransactionCommands;
