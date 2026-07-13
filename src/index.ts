#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";

import { registerConfigCommands } from "./commands/config";
import { registerWalletCommands } from "./commands/wallet";
import { registerPoolCommands } from "./commands/pools";
import { registerSwapCommands } from "./commands/swap";
import { registerLaunchpadCommands } from "./commands/launchpad";
import { registerClmmCommands } from "./commands/clmm";
import { registerCpmmCommands } from "./commands/cpmm";
import { registerTransactionCommands } from "./commands/tx";
import { registerFarmCommands } from "./commands/farm";
import { registerStatusCommand } from "./commands/status";
import {
  isDebugOutput,
  logGuidedError,
  setDebugOutput,
  setJsonOutput,
  setQuietOutput
} from "./lib/output";
import {
  setAllowUnsafeSecretFlags,
  setAssumeYes,
  setPassword,
  setPasswordStdin
} from "./lib/prompt";
import { buildHelpText } from "./lib/help";
import { setKeystoreOverride } from "./lib/wallet-manager";
import { explainError } from "./lib/errors";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require("../package.json");

dotenv.config();
const program = new Command();

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
  .option(
    "--unsafe-secret-flags",
    "allow passing secrets directly on the command line (unsafe)"
  )
  .option("--keystore <name-or-path>", "wallet name or path to wallet file");

program.addHelpText(
  "after",
  buildHelpText({
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
  })
);

program.hook("preAction", (_thisCommand, actionCommand) => {
  const opts =
    typeof actionCommand.optsWithGlobals === "function"
      ? actionCommand.optsWithGlobals()
      : actionCommand.opts();
  const format = typeof opts.format === "string" ? opts.format : undefined;
  setJsonOutput(Boolean(opts.json) || format === "json");
  setQuietOutput(format === "csv");
  setDebugOutput(Boolean(opts.debug));
  setAssumeYes(Boolean(opts.yes));
  setAllowUnsafeSecretFlags(Boolean(opts.unsafeSecretFlags));
  setPassword(typeof opts.password === "string" ? opts.password : undefined);
  setPasswordStdin(Boolean(opts.passwordStdin));
  setKeystoreOverride(typeof opts.keystore === "string" ? opts.keystore : undefined);
});

registerConfigCommands(program);
registerStatusCommand(program);
registerWalletCommands(program);
registerPoolCommands(program);
registerSwapCommands(program);
registerLaunchpadCommands(program);
registerClmmCommands(program);
registerCpmmCommands(program);
registerTransactionCommands(program);
registerFarmCommands(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const guidance = explainError(error);
  logGuidedError({
    message: guidance.message,
    code: guidance.code,
    details: guidance.details,
    hints: guidance.hints,
    debug: isDebugOutput()
  });
  process.exitCode = 1;
});
