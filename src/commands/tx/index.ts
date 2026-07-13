import { Command } from "commander";

import { getConnection } from "../../lib/connection";
import { loadConfig } from "../../lib/config-manager";
import { getTransactionExplorerUrl } from "../../lib/explorer";
import { isJsonOutput, logErrorWithDebug, logInfo, logJson, withSpinner } from "../../lib/output";
import { promptIfMissing } from "../../lib/prompt";

export function registerTransactionCommands(program: Command): void {
  const tx = program.command("tx").description("Read-only transaction diagnostics");

  tx
    .command("inspect")
    .description("Show confirmed transaction status, logs, costs, and explorer URL")
    .argument("[signature]", "Transaction signature (prompted when omitted)")
    .action(async (signature?: string) => {
      signature = await promptIfMissing(signature, "Transaction signature");
      try {
        const [connection, config] = await Promise.all([
          getConnection(),
          loadConfig({ createIfMissing: true })
        ]);
        const result = await withSpinner("Fetching transaction", () =>
          connection.getTransaction(signature!, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
          })
        );
        const explorerUrl = getTransactionExplorerUrl({
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
          if (isJsonOutput()) {
            logJson(payload);
          } else {
            logInfo(`Transaction was not available from this RPC at confirmed commitment.`);
            logInfo(`Explorer: ${explorerUrl}`);
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
        if (isJsonOutput()) {
          logJson(payload);
        } else {
          logInfo(`Transaction: ${signature}`);
          logInfo(`Slot: ${payload.slot}`);
          logInfo(`Status: ${payload.error ? "failed" : "succeeded"}`);
          logInfo(`Fee: ${payload.feeLamports ?? "unavailable"} lamports`);
          logInfo(`Compute units: ${payload.computeUnitsConsumed ?? "unavailable"}`);
          logInfo(`Explorer: ${explorerUrl}`);
          if (payload.logs.length > 0) {
            logInfo("Logs:");
            payload.logs.forEach((line) => logInfo(`  ${line}`));
          }
        }
      } catch (error) {
        logErrorWithDebug("Failed to inspect transaction", error);
        process.exitCode = 1;
      }
    });
}
