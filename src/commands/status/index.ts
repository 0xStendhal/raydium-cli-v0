import { Command } from "commander";

import { fetchSolBalance } from "../../lib/balances";
import { loadConfig } from "../../lib/config-manager";
import { redactRpcUrl, shortenAddress } from "../../lib/context";
import { isJsonOutput, logInfo, logJson, withSpinner } from "../../lib/output";
import { getWalletPublicKey, resolveWalletIdentifier } from "../../lib/wallet-manager";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show active wallet and network context")
    .option("--no-balance", "Skip the SOL balance RPC request")
    .action(async (options: { balance: boolean }) => {
      const config = await loadConfig({ createIfMissing: true });
      const walletName = resolveWalletIdentifier(undefined, config.activeWallet);
      const rpc = redactRpcUrl(config["rpc-url"]);

      if (!walletName) {
        if (isJsonOutput()) {
          logJson({ cluster: config.cluster, rpc, wallet: null, publicKey: null, sol: null });
        } else {
          logInfo(`${config.cluster} | wallet none | RPC ${rpc}`);
          logInfo("Set an active wallet with: raydium wallet use <name>");
        }
        return;
      }

      const publicKey = await getWalletPublicKey(walletName);
      const sol = options.balance
        ? await withSpinner("Fetching SOL balance", async () =>
            (await fetchSolBalance(publicKey)).amount
          )
        : null;

      if (isJsonOutput()) {
        logJson({
          cluster: config.cluster,
          rpc,
          wallet: walletName,
          publicKey: publicKey.toBase58(),
          sol
        });
        return;
      }

      const balance = sol === null ? "SOL skipped" : `${sol} SOL`;
      logInfo(
        `${config.cluster} | wallet ${walletName} (${shortenAddress(publicKey.toBase58())}) | ${balance} | RPC ${rpc}`
      );
    });
}
