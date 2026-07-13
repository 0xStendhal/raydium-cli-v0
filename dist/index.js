#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const dotenv_1 = __importDefault(require("dotenv"));
const config_1 = require("./commands/config");
const wallet_1 = require("./commands/wallet");
const pools_1 = require("./commands/pools");
const swap_1 = require("./commands/swap");
const launchpad_1 = require("./commands/launchpad");
const clmm_1 = require("./commands/clmm");
const cpmm_1 = require("./commands/cpmm");
const tx_1 = require("./commands/tx");
const farm_1 = require("./commands/farm");
const status_1 = require("./commands/status");
const output_1 = require("./lib/output");
const prompt_1 = require("./lib/prompt");
const help_1 = require("./lib/help");
const wallet_manager_1 = require("./lib/wallet-manager");
const errors_1 = require("./lib/errors");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require("../package.json");
dotenv_1.default.config();
const program = new commander_1.Command();
program
    .name("raydium")
    .description("Raydium CLI")
    .version(version)
    .option("--json", "output json")
    .option("--format <format>", "output format: text|json|csv")
    .option("--debug", "print full errors")
    .option("--yes", "assume yes for confirmations")
    .option("--password <password>", "wallet password (unsafe; requires --unsafe-secret-flags)")
    .option("--password-stdin", "read wallet password from stdin")
    .option("--unsafe-secret-flags", "allow passing secrets directly on the command line (unsafe)")
    .option("--keystore <name-or-path>", "wallet name or path to wallet file");
program.addHelpText("after", (0, help_1.buildHelpText)({
    summary: [
        "Use command groups like wallet, swap, clmm, cpmm, farm, tx, launchpad, and config.",
        "Cluster-aware commands default to the configured cluster from raydium config."
    ],
    auth: [
        "Use --password-stdin for automation or let the CLI prompt interactively.",
        "--password is intentionally gated behind --unsafe-secret-flags."
    ],
    defaults: [
        "The active wallet is used unless --keystore overrides it.",
        "--json switches to machine-readable output when supported."
    ],
    automation: [
        "Quote with --json first; use --yes only for an approved execution.",
        "Avoid passing secrets directly on the command line unless you explicitly accept the risk."
    ],
    examples: [
        "raydium wallet create trading-bot",
        "printf '%s' 'wallet-password' | raydium --password-stdin wallet list",
        "raydium swap --input-mint So11111111111111111111111111111111111111112 --output-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --amount 0.001"
    ]
}));
program.hook("preAction", (_thisCommand, actionCommand) => {
    const opts = typeof actionCommand.optsWithGlobals === "function"
        ? actionCommand.optsWithGlobals()
        : actionCommand.opts();
    const format = typeof opts.format === "string" ? opts.format : undefined;
    (0, output_1.setJsonOutput)(Boolean(opts.json) || format === "json");
    (0, output_1.setQuietOutput)(format === "csv");
    (0, output_1.setDebugOutput)(Boolean(opts.debug));
    (0, prompt_1.setAssumeYes)(Boolean(opts.yes));
    (0, prompt_1.setAllowUnsafeSecretFlags)(Boolean(opts.unsafeSecretFlags));
    (0, prompt_1.setPassword)(typeof opts.password === "string" ? opts.password : undefined);
    (0, prompt_1.setPasswordStdin)(Boolean(opts.passwordStdin));
    (0, wallet_manager_1.setKeystoreOverride)(typeof opts.keystore === "string" ? opts.keystore : undefined);
});
(0, config_1.registerConfigCommands)(program);
(0, status_1.registerStatusCommand)(program);
(0, wallet_1.registerWalletCommands)(program);
(0, pools_1.registerPoolCommands)(program);
(0, swap_1.registerSwapCommands)(program);
(0, launchpad_1.registerLaunchpadCommands)(program);
(0, clmm_1.registerClmmCommands)(program);
(0, cpmm_1.registerCpmmCommands)(program);
(0, tx_1.registerTransactionCommands)(program);
(0, farm_1.registerFarmCommands)(program);
program.parseAsync(process.argv).catch((error) => {
    const guidance = (0, errors_1.explainError)(error);
    (0, output_1.logGuidedError)({
        message: guidance.message,
        code: guidance.code,
        details: guidance.details,
        hints: guidance.hints,
        debug: (0, output_1.isDebugOutput)()
    });
    process.exitCode = 1;
});
