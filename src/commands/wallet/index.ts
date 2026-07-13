import fs from "fs/promises";
import path from "path";

import inquirer from "inquirer";
import bs58 from "bs58";
import { Command } from "commander";

import { CONFIG_DIR } from "../../lib/paths";
import { loadConfig, saveConfig } from "../../lib/config-manager";
import {
  assertValidWalletName,
  createWallet,
  decryptWallet,
  getDefaultDerivationPath,
  getWalletPublicKey,
  importWalletFromMnemonic,
  importWalletFromPrivateKey,
  listWallets,
  resolveWalletIdentifier,
  walletExists
} from "../../lib/wallet-manager";
import {
  promptConfirm,
  promptInput,
  promptPassword,
  promptSecretInput,
  promptIfMissing,
  readSecretFromFile,
  readSecretFromStdin
} from "../../lib/prompt";
import {
  isJsonOutput,
  logInfo,
  logJson,
  logSuccess,
  logError,
  withSpinner
} from "../../lib/output";
import { addRichHelp, AUTOMATION_HELP, PASSWORD_AUTH_HELP } from "../../lib/help";
import { fetchRpcBalances } from "../../lib/balances";

const SECRET_EXPORTS_DIR = path.join(CONFIG_DIR, "exports");
const SECRET_EXPORT_DIR_MODE = 0o700;
const SECRET_EXPORT_FILE_MODE = 0o600;

function ensureSingleSecretSource(
  sources: Array<{ enabled: boolean; label: string }>
): void {
  const enabled = sources.filter((source) => source.enabled);
  if (enabled.length > 1) {
    throw new Error(
      `Choose only one secret input source: ${enabled.map((source) => source.label).join(", ")}`
    );
  }
}

function normalizeSeedPhrase(seedPhrase: string): string {
  return seedPhrase.trim().split(/\s+/).join(" ");
}

async function ensureSecretExportDir(): Promise<void> {
  await fs.mkdir(SECRET_EXPORTS_DIR, { recursive: true });
  await fs.chmod(SECRET_EXPORTS_DIR, SECRET_EXPORT_DIR_MODE);
}

function getDefaultSecretExportPath(walletName: string, suffix: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(SECRET_EXPORTS_DIR, `${walletName}-${suffix}-${timestamp}.txt`);
}

async function writeSecretFile(filePath: string, content: string): Promise<string> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.chmod(path.dirname(resolved), SECRET_EXPORT_DIR_MODE);
  await fs.writeFile(resolved, `${content}\n`, { mode: SECRET_EXPORT_FILE_MODE });
  await fs.chmod(resolved, SECRET_EXPORT_FILE_MODE);
  return resolved;
}

export function registerWalletCommands(program: Command): void {
  const wallet = program.command("wallet").description("Manage wallets");

  addRichHelp(
    wallet
      .command("create")
    .description("Create a new wallet")
    .argument("[name]")
    .option(
      "--derivation-path <path>",
      "Mnemonic derivation path",
      getDefaultDerivationPath()
    )
    .option(
      "--seed-phrase-file <path>",
      "Write the generated seed phrase to a file with 0600 permissions"
    )
    .option("--unsafe-stdout", "Print the generated seed phrase to stdout/json (unsafe)"),
    {
      summary: "Creates an encrypted wallet file and a recovery seed phrase.",
      auth: "Prompts for a new wallet password and confirmation.",
      defaults: [
        `The default derivation path is ${getDefaultDerivationPath()}.`,
        "Without --unsafe-stdout, the seed phrase is written to a plaintext file with 0600 permissions."
      ],
      automation: AUTOMATION_HELP,
      examples: [
        "raydium wallet create trader",
        `raydium wallet create trader --derivation-path "${getDefaultDerivationPath()}"`,
        "raydium wallet create trader --seed-phrase-file ~/.raydium-cli/backups/trader-seed.txt"
      ],
      notes: [
        "Seed phrase export files are permission-restricted, not encrypted.",
        "Move recovery exports into secure backup storage and delete the plaintext file after recording it."
      ]
    }
  )
    .action(
      async (
        name: string | undefined,
        options: { derivationPath: string; seedPhraseFile?: string; unsafeStdout?: boolean }
      ) => {
        const walletName = name ?? (await promptInput("Wallet name"));
        const password = await promptPassword("Set wallet password", true);
        const { mnemonic, wallet: walletFile } = await createWallet(
          walletName,
          password,
          options.derivationPath
        );

        const config = await loadConfig({ createIfMissing: true });
        if (!config.activeWallet) {
          await saveConfig({ ...config, activeWallet: walletName });
        }

        let seedPhraseFile: string | undefined;
        if (!options.unsafeStdout) {
          await ensureSecretExportDir();
          seedPhraseFile = await writeSecretFile(
            options.seedPhraseFile ?? getDefaultSecretExportPath(walletFile.name, "seed-phrase"),
            mnemonic
          );
        }

        if (isJsonOutput()) {
          logJson({
            name: walletFile.name,
            publicKey: walletFile.publicKey,
            derivationPath: walletFile.derivationPath,
            ...(seedPhraseFile ? { seedPhraseFile } : {}),
            ...(seedPhraseFile
              ? {
                  warning:
                    "Seed phrase export is stored as plain text with 0600 file permissions. Move it to secure backup storage and delete the file after recording it."
                }
              : {}),
            ...(options.unsafeStdout ? { mnemonic } : {})
          });
          return;
        }

        logSuccess(`Wallet created: ${walletFile.name}`);
        logInfo(`Public key: ${walletFile.publicKey}`);
        logInfo(`Derivation path: ${walletFile.derivationPath}`);
        if (seedPhraseFile) {
          logInfo(`Seed phrase written to: ${seedPhraseFile}`);
          logInfo(
            "Warning: the seed phrase export is plain text protected only by 0600 file permissions."
          );
          logInfo(
            "Move it to secure backup storage and delete the file after you have recorded it."
          );
        } else {
          logInfo(`Seed phrase (unsafe stdout): ${mnemonic}`);
        }
      }
    );

  addRichHelp(
    wallet
      .command("import")
    .description("Import an existing wallet")
    .argument("[name]")
    .option("--private-key-stdin", "Read the private key from stdin")
    .option("--seed-phrase-stdin", "Read the seed phrase from stdin")
    .option("--private-key-file <path>", "Read the private key from a file")
    .option("--seed-phrase-file <path>", "Read the seed phrase from a file")
    .option(
      "--derivation-path <path>",
      "Mnemonic derivation path",
      getDefaultDerivationPath()
    ),
    {
      summary: "Imports from either a base58 private key or a seed phrase.",
      auth: "Prompts for a new wallet password and confirmation.",
      defaults: [
        "Choose exactly one secret source flag, or omit them to use an interactive prompt.",
        "Derivation paths apply only to seed phrase imports."
      ],
      automation: [
        AUTOMATION_HELP,
        "For automation, prefer --private-key-stdin or --seed-phrase-stdin over interactive secret entry."
      ],
      examples: [
        "printf '%s' 'base58-private-key' | raydium wallet import trading-bot --private-key-stdin",
        "printf '%s' 'seed phrase words here' | raydium wallet import trader --seed-phrase-stdin",
        `raydium wallet import trader --seed-phrase-file ./seed.txt --derivation-path "${getDefaultDerivationPath()}"`
      ],
      notes: "Private-key imports ignore --derivation-path because the keypair is already fully derived."
    }
  )
    .action(
      async (
        name: string | undefined,
        options: {
          privateKeyStdin?: boolean;
          seedPhraseStdin?: boolean;
          privateKeyFile?: string;
          seedPhraseFile?: string;
          derivationPath: string;
        }
      ) => {
        name = await promptIfMissing(name, "Wallet name");
        ensureSingleSecretSource([
          { enabled: Boolean(options.privateKeyStdin), label: "--private-key-stdin" },
          { enabled: Boolean(options.seedPhraseStdin), label: "--seed-phrase-stdin" },
          { enabled: Boolean(options.privateKeyFile), label: "--private-key-file" },
          { enabled: Boolean(options.seedPhraseFile), label: "--seed-phrase-file" }
        ]);

        let privateKey: string | undefined;
        let seedPhrase: string | undefined;

        if (options.privateKeyStdin) {
          privateKey = await readSecretFromStdin(
            "private key",
            "--private-key-stdin"
          );
        } else if (options.seedPhraseStdin) {
          seedPhrase = normalizeSeedPhrase(
            await readSecretFromStdin("seed phrase", "--seed-phrase-stdin")
          );
        } else if (options.privateKeyFile) {
          privateKey = await readSecretFromFile(options.privateKeyFile, "private key");
        } else if (options.seedPhraseFile) {
          seedPhrase = normalizeSeedPhrase(
            await readSecretFromFile(options.seedPhraseFile, "seed phrase")
          );
        } else {
          if (isJsonOutput()) {
            throw new Error(
              "Interactive prompts are disabled with --json. Use stdin or file-based secret input."
            );
          }

          const answer = await inquirer.prompt<{ method: "private-key" | "seed-phrase" }>([
            {
              type: "list",
              name: "method",
              message: "Import method",
              choices: [
                { name: "Private key (base58)", value: "private-key" },
                { name: "Seed phrase", value: "seed-phrase" }
              ]
            }
          ]);

          if (answer.method === "private-key") {
            privateKey = await promptSecretInput("Private key (base58)");
          } else {
            seedPhrase = normalizeSeedPhrase(await promptSecretInput("Seed phrase"));
          }
        }

        const password = await promptPassword("Set wallet password", true);

        if (privateKey) {
          const walletFile = await importWalletFromPrivateKey(name, privateKey, password);
          const config = await loadConfig({ createIfMissing: true });
          if (!config.activeWallet) {
            await saveConfig({ ...config, activeWallet: walletFile.name });
          }

          if (isJsonOutput()) {
            logJson({ name: walletFile.name, publicKey: walletFile.publicKey });
          } else {
            logSuccess(`Wallet imported: ${walletFile.name}`);
            logInfo(`Public key: ${walletFile.publicKey}`);
          }
          return;
        }

        if (!seedPhrase) {
          logError("Missing seed phrase");
          process.exitCode = 1;
          return;
        }

        const walletFile = await importWalletFromMnemonic(
          name,
          seedPhrase,
          password,
          options.derivationPath
        );
        const config = await loadConfig({ createIfMissing: true });
        if (!config.activeWallet) {
          await saveConfig({ ...config, activeWallet: walletFile.name });
        }

        if (isJsonOutput()) {
          logJson({
            name: walletFile.name,
            publicKey: walletFile.publicKey,
            derivationPath: walletFile.derivationPath
          });
        } else {
          logSuccess(`Wallet imported: ${walletFile.name}`);
          logInfo(`Public key: ${walletFile.publicKey}`);
          logInfo(`Derivation path: ${walletFile.derivationPath}`);
        }
      }
    );

  wallet
    .command("list")
    .description("List wallets")
    .action(async () => {
      const wallets = await listWallets();
      const config = await loadConfig({ createIfMissing: true });

      if (isJsonOutput()) {
        logJson({ wallets, activeWallet: config.activeWallet });
        return;
      }

      if (wallets.length === 0) {
        logInfo("No wallets found");
        return;
      }

      wallets.forEach((item) => {
        const activeMark = item.name === config.activeWallet ? " (active)" : "";
        const derivationInfo = item.derivationPath ? ` [${item.derivationPath}]` : "";
        logInfo(`${item.name}${activeMark} - ${item.publicKey}${derivationInfo}`);
      });
    });

  wallet
    .command("use")
    .description("Set active wallet")
    .argument("[name]")
    .action(async (name?: string) => {
      name = await promptIfMissing(name, "Wallet name");
      assertValidWalletName(name);
      if (!(await walletExists(name))) {
        logError(`Wallet not found: ${name}`);
        process.exitCode = 1;
        return;
      }

      const config = await loadConfig({ createIfMissing: true });
      await saveConfig({ ...config, activeWallet: name });

      if (isJsonOutput()) {
        logJson({ activeWallet: name });
      } else {
        logSuccess(`Active wallet set to ${name}`);
      }
    });

  wallet
    .command("balance")
    .description("Show wallet balances")
    .argument("[name]")
    .action(async (name?: string) => {
      const config = await loadConfig({ createIfMissing: true });
      const walletName = resolveWalletIdentifier(name, config.activeWallet);
      if (!walletName) {
        logError("No active wallet set");
        process.exitCode = 1;
        return;
      }

      const owner = await getWalletPublicKey(walletName);
      const walletAddress = owner.toBase58();
      const balances = await withSpinner("Fetching balances", () => fetchRpcBalances(owner));

      if (isJsonOutput()) {
        logJson({ wallet: walletName, publicKey: walletAddress, tokens: balances });
        return;
      }

      logInfo(`Wallet: ${walletName}`);
      logInfo(`Public key: ${walletAddress}`);
      if (balances.length === 0) {
        logInfo("No balances found");
        return;
      }

      balances.forEach((item) => {
        if (item.mint === "SOL") {
          logInfo(`SOL: ${item.amount}`);
          return;
        }

        const label =
          item.name && item.name !== item.symbol ? `${item.symbol} (${item.name})` : item.symbol;
        logInfo(`${label}: ${item.amount}`);
        logInfo(`  Mint: ${item.mint}`);
      });
    });

  addRichHelp(
    wallet
      .command("export")
    .description("Export a private key")
    .argument("[name]")
    .option("--file <path>", "Write the private key to a file with 0600 permissions")
    .option("--unsafe-stdout", "Print the private key to stdout/json (unsafe)"),
    {
      summary: "Reveals the wallet private key after an explicit confirmation prompt.",
      auth: PASSWORD_AUTH_HELP,
      defaults: [
        "Without --unsafe-stdout, the private key is written to a plaintext file with 0600 permissions.",
        "The command prompts for confirmation before decrypting the wallet."
      ],
      automation: [
        AUTOMATION_HELP,
        "Prefer file output for agents so secrets are not exposed in stdout or command logs."
      ],
      examples: [
        "raydium wallet export trader",
        "raydium wallet export trader --file ~/.raydium-cli/exports/trader-private-key.txt",
        "printf '%s' 'wallet-password' | raydium --password-stdin wallet export trader --unsafe-stdout"
      ],
      notes: [
        "Export files are permission-restricted, not encrypted.",
        "--unsafe-stdout is intended only for deliberate one-off use."
      ]
    }
  )
    .action(
      async (name: string | undefined, options: { file?: string; unsafeStdout?: boolean }) => {
        name = await promptIfMissing(name, "Wallet name");
        const walletName = resolveWalletIdentifier(name);
        if (!walletName) {
          logError("No wallet specified");
          process.exitCode = 1;
          return;
        }

        if (
          !(await walletExists(walletName)) &&
          !walletName.endsWith(".json") &&
          !walletName.includes("/") &&
          !walletName.includes("\\")
        ) {
          logError(`Wallet not found: ${walletName}`);
          process.exitCode = 1;
          return;
        }

        const ok = await promptConfirm(
          "This will reveal your private key. Continue?",
          false
        );
        if (!ok) {
          logInfo("Cancelled");
          return;
        }

        const password = await promptPassword("Enter wallet password");
        const keypair = await decryptWallet(walletName, password);
        const privateKey = bs58.encode(keypair.secretKey);

        let outputFile: string | undefined;
        if (!options.unsafeStdout) {
          await ensureSecretExportDir();
          outputFile = await writeSecretFile(
            options.file ?? getDefaultSecretExportPath(path.basename(walletName, ".json"), "private-key"),
            privateKey
          );
        }

        if (isJsonOutput()) {
          logJson({
            name: walletName,
            publicKey: keypair.publicKey.toBase58(),
            ...(outputFile ? { file: outputFile } : {}),
            ...(options.unsafeStdout ? { privateKey } : {})
          });
          return;
        }

        logSuccess("Private key exported");
        logInfo(`Public key: ${keypair.publicKey.toBase58()}`);
        if (outputFile) {
          logInfo(`Private key written to: ${outputFile}`);
        } else {
          logInfo(`Private key (base58): ${privateKey}`);
        }
      }
    );
}
