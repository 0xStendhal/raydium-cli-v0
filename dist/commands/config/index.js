"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerConfigCommands = void 0;
const inquirer_1 = __importDefault(require("inquirer"));
const config_manager_1 = require("../../lib/config-manager");
const output_1 = require("../../lib/output");
const prompt_1 = require("../../lib/prompt");
function registerConfigCommands(program) {
    const config = program.command("config").description("Manage CLI configuration");
    config
        .command("init")
        .description("Interactive config setup")
        .action(async () => {
        if ((0, output_1.isJsonOutput)()) {
            throw new Error("Interactive prompts are disabled with --json. Provide all required flags.");
        }
        const current = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        const answers = await inquirer_1.default.prompt([
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
                validate: (input) => (input ? true : "RPC URL is required")
            },
            {
                type: "input",
                name: "slippage",
                message: "Default slippage (%)",
                default: String(current["default-slippage"]),
                validate: (input) => (Number.isFinite(Number(input)) ? true : "Enter a valid number")
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
                validate: (input) => (Number.isFinite(Number(input)) ? true : "Enter a valid number")
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
        await (0, config_manager_1.saveConfig)(nextConfig);
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ ok: true, config: (0, config_manager_1.redactConfig)(nextConfig) });
        }
        else {
            (0, output_1.logSuccess)("Config saved");
        }
    });
    config
        .command("set")
        .description("Set a config value")
        .argument("[key]")
        .argument("[value]")
        .action(async (key, value) => {
        key = await (0, prompt_1.promptIfMissing)(key, "Configuration key");
        value = await (0, prompt_1.promptIfMissing)(value, `Value for ${key}`);
        if (!(0, config_manager_1.isValidConfigKey)(key)) {
            (0, output_1.logError)(`Unknown config key: ${key}`);
            process.exitCode = 1;
            return;
        }
        const configData = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        const parsed = (0, config_manager_1.parseConfigValue)(key, value);
        const nextConfig = { ...configData, [key]: parsed };
        await (0, config_manager_1.saveConfig)(nextConfig);
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ ok: true, config: (0, config_manager_1.redactConfig)(nextConfig) });
        }
        else {
            (0, output_1.logSuccess)(`Updated ${key}`);
        }
    });
    config
        .command("get")
        .description("Get config values")
        .argument("[key]")
        .action(async (key) => {
        const configData = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        if (key) {
            if (!(0, config_manager_1.isValidConfigKey)(key)) {
                (0, output_1.logError)(`Unknown config key: ${key}`);
                process.exitCode = 1;
                return;
            }
            if ((0, output_1.isJsonOutput)()) {
                (0, output_1.logJson)({ [key]: (0, config_manager_1.redactConfigValue)(key, configData[key]) });
            }
            else {
                (0, output_1.logInfo)(String((0, config_manager_1.redactConfigValue)(key, configData[key]) ?? ""));
            }
            return;
        }
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)((0, config_manager_1.redactConfig)(configData));
        }
        else {
            Object.entries((0, config_manager_1.redactConfig)(configData)).forEach(([itemKey, value]) => {
                (0, output_1.logInfo)(`${itemKey}: ${value}`);
            });
        }
    });
}
exports.registerConfigCommands = registerConfigCommands;
