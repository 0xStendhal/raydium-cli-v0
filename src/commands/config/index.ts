import { Command } from "commander";
import inquirer from "inquirer";

import { loadConfig, parseConfigValue, saveConfig, isValidConfigKey } from "../../lib/config-manager";
import { isJsonOutput, logError, logInfo, logJson, logSuccess } from "../../lib/output";
import { Cluster } from "../../types/config";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Manage CLI configuration");

  config
    .command("init")
    .description("Interactive config setup")
    .action(async () => {
      if (isJsonOutput()) {
        throw new Error("Interactive prompts are disabled with --json. Provide all required flags.");
      }
      const current = await loadConfig({ createIfMissing: true });
      const answers = await inquirer.prompt<{
        cluster: Cluster;
        rpcUrl: string;
        slippage: string;
        explorer: "solscan" | "solanaFm" | "solanaExplorer";
        priorityFee: string;
      }>([
        {
          type: "list",
          name: "cluster",
          message: "Cluster",
          choices: ["mainnet", "devnet"],
          default: current.cluster
        },
        {
          type: "input",
          name: "rpcUrl",
          message: "RPC URL",
          default: current["rpc-url"],
          validate: (input: string) => (input ? true : "RPC URL is required")
        },
        {
          type: "input",
          name: "slippage",
          message: "Default slippage (%)",
          default: String(current["default-slippage"]),
          validate: (input: string) => (Number.isFinite(Number(input)) ? true : "Enter a valid number")
        },
        {
          type: "list",
          name: "explorer",
          message: "Explorer",
          choices: ["solscan", "solanaFm", "solanaExplorer"],
          default: current.explorer
        },
        {
          type: "input",
          name: "priorityFee",
          message: "Priority fee (SOL)",
          default: String(current["priority-fee"]),
          validate: (input: string) => (Number.isFinite(Number(input)) ? true : "Enter a valid number")
        }
      ]);

      const nextConfig = {
        ...current,
        cluster: answers.cluster,
        "rpc-url": answers.rpcUrl,
        "default-slippage": Number(answers.slippage),
        explorer: answers.explorer,
        "priority-fee": Number(answers.priorityFee)
      };

      await saveConfig(nextConfig);

      if (isJsonOutput()) {
        logJson({ ok: true, config: nextConfig });
      } else {
        logSuccess("Config saved");
      }
    });

  config
    .command("set")
    .description("Set a config value")
    .argument("<key>")
    .argument("<value>")
    .action(async (key: string, value: string) => {
      if (!isValidConfigKey(key)) {
        logError(`Unknown config key: ${key}`);
        process.exitCode = 1;
        return;
      }

      const configData = await loadConfig({ createIfMissing: true });
      const parsed = parseConfigValue(key, value);
      const nextConfig = { ...configData, [key]: parsed };
      await saveConfig(nextConfig);

      if (isJsonOutput()) {
        logJson({ ok: true, config: nextConfig });
      } else {
        logSuccess(`Updated ${key}`);
      }
    });

  config
    .command("get")
    .description("Get config values")
    .argument("[key]")
    .action(async (key?: string) => {
      const configData = await loadConfig({ createIfMissing: true });

      if (key) {
        if (!isValidConfigKey(key)) {
          logError(`Unknown config key: ${key}`);
          process.exitCode = 1;
          return;
        }

        if (isJsonOutput()) {
          logJson({ [key]: configData[key] });
        } else {
          logInfo(String(configData[key] ?? ""));
        }
        return;
      }

      if (isJsonOutput()) {
        logJson(configData);
      } else {
        Object.entries(configData).forEach(([itemKey, value]) => {
          logInfo(`${itemKey}: ${value}`);
        });
      }
    });
}
