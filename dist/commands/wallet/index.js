"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWalletCommands = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const inquirer_1 = __importDefault(require("inquirer"));
const bs58_1 = __importDefault(require("bs58"));
const paths_1 = require("../../lib/paths");
const config_manager_1 = require("../../lib/config-manager");
const wallet_manager_1 = require("../../lib/wallet-manager");
const prompt_1 = require("../../lib/prompt");
const output_1 = require("../../lib/output");
const help_1 = require("../../lib/help");
const balances_1 = require("../../lib/balances");
const SECRET_EXPORTS_DIR = path_1.default.join(paths_1.CONFIG_DIR, "exports");
const SECRET_EXPORT_DIR_MODE = 0o700;
const SECRET_EXPORT_FILE_MODE = 0o600;
function ensureSingleSecretSource(sources) {
    const enabled = sources.filter((source) => source.enabled);
    if (enabled.length > 1) {
        throw new Error(`Choose only one secret input source: ${enabled.map((source) => source.label).join(", ")}`);
    }
}
function normalizeSeedPhrase(seedPhrase) {
    return seedPhrase.trim().split(/\s+/).join(" ");
}
async function ensureSecretExportDir() {
    await promises_1.default.mkdir(SECRET_EXPORTS_DIR, { recursive: true });
    await promises_1.default.chmod(SECRET_EXPORTS_DIR, SECRET_EXPORT_DIR_MODE);
}
function getDefaultSecretExportPath(walletName, suffix) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path_1.default.join(SECRET_EXPORTS_DIR, `${walletName}-${suffix}-${timestamp}.txt`);
}
async function writeSecretFile(filePath, content) {
    const resolved = path_1.default.resolve(filePath);
    await promises_1.default.mkdir(path_1.default.dirname(resolved), { recursive: true });
    await promises_1.default.chmod(path_1.default.dirname(resolved), SECRET_EXPORT_DIR_MODE);
    await promises_1.default.writeFile(resolved, `${content}\n`, { mode: SECRET_EXPORT_FILE_MODE });
    await promises_1.default.chmod(resolved, SECRET_EXPORT_FILE_MODE);
    return resolved;
}
function registerWalletCommands(program) {
    const wallet = program.command("wallet").description("Manage wallets");
    (0, help_1.addRichHelp)(wallet
        .command("create")
        .description("Create a new wallet")
        .argument("[name]")
        .option("--derivation-path <path>", "Mnemonic derivation path", (0, wallet_manager_1.getDefaultDerivationPath)())
        .option("--seed-phrase-file <path>", "Write the generated seed phrase to a file with 0600 permissions")
        .option("--unsafe-stdout", "Print the generated seed phrase to stdout/json (unsafe)"), {
        summary: "Creates an encrypted wallet file and a recovery seed phrase.",
        auth: "Prompts for a new wallet password and confirmation.",
        defaults: [
            `The default derivation path is ${(0, wallet_manager_1.getDefaultDerivationPath)()}.`,
            "Without --unsafe-stdout, the seed phrase is written to a plaintext file with 0600 permissions."
        ],
        automation: help_1.AUTOMATION_HELP,
        examples: [
            "raydium wallet create trader",
            `raydium wallet create trader --derivation-path "${(0, wallet_manager_1.getDefaultDerivationPath)()}"`,
            "raydium wallet create trader --seed-phrase-file ~/.raydium-cli/backups/trader-seed.txt"
        ],
        notes: [
            "Seed phrase export files are permission-restricted, not encrypted.",
            "Move recovery exports into secure backup storage and delete the plaintext file after recording it."
        ]
    })
        .action(async (name, options) => {
        const walletName = name ?? (await (0, prompt_1.promptInput)("Wallet name"));
        const password = await (0, prompt_1.promptPassword)("Set wallet password", true);
        const { mnemonic, wallet: walletFile } = await (0, wallet_manager_1.createWallet)(walletName, password, options.derivationPath);
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        if (!config.activeWallet) {
            await (0, config_manager_1.saveConfig)({ ...config, activeWallet: walletName });
        }
        let seedPhraseFile;
        if (!options.unsafeStdout) {
            await ensureSecretExportDir();
            seedPhraseFile = await writeSecretFile(options.seedPhraseFile ?? getDefaultSecretExportPath(walletFile.name, "seed-phrase"), mnemonic);
        }
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({
                name: walletFile.name,
                publicKey: walletFile.publicKey,
                derivationPath: walletFile.derivationPath,
                ...(seedPhraseFile ? { seedPhraseFile } : {}),
                ...(seedPhraseFile
                    ? {
                        warning: "Seed phrase export is stored as plain text with 0600 file permissions. Move it to secure backup storage and delete the file after recording it."
                    }
                    : {}),
                ...(options.unsafeStdout ? { mnemonic } : {})
            });
            return;
        }
        (0, output_1.logSuccess)(`Wallet created: ${walletFile.name}`);
        (0, output_1.logInfo)(`Public key: ${walletFile.publicKey}`);
        (0, output_1.logInfo)(`Derivation path: ${walletFile.derivationPath}`);
        if (seedPhraseFile) {
            (0, output_1.logInfo)(`Seed phrase written to: ${seedPhraseFile}`);
            (0, output_1.logInfo)("Warning: the seed phrase export is plain text protected only by 0600 file permissions.");
            (0, output_1.logInfo)("Move it to secure backup storage and delete the file after you have recorded it.");
        }
        else {
            (0, output_1.logInfo)(`Seed phrase (unsafe stdout): ${mnemonic}`);
        }
    });
    (0, help_1.addRichHelp)(wallet
        .command("import")
        .description("Import an existing wallet")
        .argument("[name]")
        .option("--private-key-stdin", "Read the private key from stdin")
        .option("--seed-phrase-stdin", "Read the seed phrase from stdin")
        .option("--private-key-file <path>", "Read the private key from a file")
        .option("--seed-phrase-file <path>", "Read the seed phrase from a file")
        .option("--derivation-path <path>", "Mnemonic derivation path", (0, wallet_manager_1.getDefaultDerivationPath)()), {
        summary: "Imports from either a base58 private key or a seed phrase.",
        auth: "Prompts for a new wallet password and confirmation.",
        defaults: [
            "Choose exactly one secret source flag, or omit them to use an interactive prompt.",
            "Derivation paths apply only to seed phrase imports."
        ],
        automation: [
            help_1.AUTOMATION_HELP,
            "For automation, prefer --private-key-stdin or --seed-phrase-stdin over interactive secret entry."
        ],
        examples: [
            "printf '%s' 'base58-private-key' | raydium wallet import trading-bot --private-key-stdin",
            "printf '%s' 'seed phrase words here' | raydium wallet import trader --seed-phrase-stdin",
            `raydium wallet import trader --seed-phrase-file ./seed.txt --derivation-path "${(0, wallet_manager_1.getDefaultDerivationPath)()}"`
        ],
        notes: "Private-key imports ignore --derivation-path because the keypair is already fully derived."
    })
        .action(async (name, options) => {
        name = await (0, prompt_1.promptIfMissing)(name, "Wallet name");
        ensureSingleSecretSource([
            { enabled: Boolean(options.privateKeyStdin), label: "--private-key-stdin" },
            { enabled: Boolean(options.seedPhraseStdin), label: "--seed-phrase-stdin" },
            { enabled: Boolean(options.privateKeyFile), label: "--private-key-file" },
            { enabled: Boolean(options.seedPhraseFile), label: "--seed-phrase-file" }
        ]);
        let privateKey;
        let seedPhrase;
        if (options.privateKeyStdin) {
            privateKey = await (0, prompt_1.readSecretFromStdin)("private key", "--private-key-stdin");
        }
        else if (options.seedPhraseStdin) {
            seedPhrase = normalizeSeedPhrase(await (0, prompt_1.readSecretFromStdin)("seed phrase", "--seed-phrase-stdin"));
        }
        else if (options.privateKeyFile) {
            privateKey = await (0, prompt_1.readSecretFromFile)(options.privateKeyFile, "private key");
        }
        else if (options.seedPhraseFile) {
            seedPhrase = normalizeSeedPhrase(await (0, prompt_1.readSecretFromFile)(options.seedPhraseFile, "seed phrase"));
        }
        else {
            if ((0, output_1.isJsonOutput)()) {
                throw new Error("Interactive prompts are disabled with --json. Use stdin or file-based secret input.");
            }
            const answer = await inquirer_1.default.prompt([
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
                privateKey = await (0, prompt_1.promptSecretInput)("Private key (base58)");
            }
            else {
                seedPhrase = normalizeSeedPhrase(await (0, prompt_1.promptSecretInput)("Seed phrase"));
            }
        }
        const password = await (0, prompt_1.promptPassword)("Set wallet password", true);
        if (privateKey) {
            const walletFile = await (0, wallet_manager_1.importWalletFromPrivateKey)(name, privateKey, password);
            const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
            if (!config.activeWallet) {
                await (0, config_manager_1.saveConfig)({ ...config, activeWallet: walletFile.name });
            }
            if ((0, output_1.isJsonOutput)()) {
                (0, output_1.logJson)({ name: walletFile.name, publicKey: walletFile.publicKey });
            }
            else {
                (0, output_1.logSuccess)(`Wallet imported: ${walletFile.name}`);
                (0, output_1.logInfo)(`Public key: ${walletFile.publicKey}`);
            }
            return;
        }
        if (!seedPhrase) {
            (0, output_1.logError)("Missing seed phrase");
            process.exitCode = 1;
            return;
        }
        const walletFile = await (0, wallet_manager_1.importWalletFromMnemonic)(name, seedPhrase, password, options.derivationPath);
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        if (!config.activeWallet) {
            await (0, config_manager_1.saveConfig)({ ...config, activeWallet: walletFile.name });
        }
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({
                name: walletFile.name,
                publicKey: walletFile.publicKey,
                derivationPath: walletFile.derivationPath
            });
        }
        else {
            (0, output_1.logSuccess)(`Wallet imported: ${walletFile.name}`);
            (0, output_1.logInfo)(`Public key: ${walletFile.publicKey}`);
            (0, output_1.logInfo)(`Derivation path: ${walletFile.derivationPath}`);
        }
    });
    wallet
        .command("list")
        .description("List wallets")
        .action(async () => {
        const wallets = await (0, wallet_manager_1.listWallets)();
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ wallets, activeWallet: config.activeWallet });
            return;
        }
        if (wallets.length === 0) {
            (0, output_1.logInfo)("No wallets found");
            return;
        }
        wallets.forEach((item) => {
            const activeMark = item.name === config.activeWallet ? " (active)" : "";
            const derivationInfo = item.derivationPath ? ` [${item.derivationPath}]` : "";
            (0, output_1.logInfo)(`${item.name}${activeMark} - ${item.publicKey}${derivationInfo}`);
        });
    });
    wallet
        .command("use")
        .description("Set active wallet")
        .argument("[name]")
        .action(async (name) => {
        name = await (0, prompt_1.promptIfMissing)(name, "Wallet name");
        (0, wallet_manager_1.assertValidWalletName)(name);
        if (!(await (0, wallet_manager_1.walletExists)(name))) {
            (0, output_1.logError)(`Wallet not found: ${name}`);
            process.exitCode = 1;
            return;
        }
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        await (0, config_manager_1.saveConfig)({ ...config, activeWallet: name });
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ activeWallet: name });
        }
        else {
            (0, output_1.logSuccess)(`Active wallet set to ${name}`);
        }
    });
    wallet
        .command("balance")
        .description("Show wallet balances")
        .argument("[name]")
        .action(async (name) => {
        const config = await (0, config_manager_1.loadConfig)({ createIfMissing: true });
        const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(name, config.activeWallet);
        if (!walletName) {
            (0, output_1.logError)("No active wallet set");
            process.exitCode = 1;
            return;
        }
        const owner = await (0, wallet_manager_1.getWalletPublicKey)(walletName);
        const walletAddress = owner.toBase58();
        const balances = await (0, output_1.withSpinner)("Fetching balances", () => (0, balances_1.fetchRpcBalances)(owner));
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({ wallet: walletName, publicKey: walletAddress, tokens: balances });
            return;
        }
        (0, output_1.logInfo)(`Wallet: ${walletName}`);
        (0, output_1.logInfo)(`Public key: ${walletAddress}`);
        if (balances.length === 0) {
            (0, output_1.logInfo)("No balances found");
            return;
        }
        balances.forEach((item) => {
            if (item.mint === "SOL") {
                (0, output_1.logInfo)(`SOL: ${item.amount}`);
                return;
            }
            const label = item.name && item.name !== item.symbol ? `${item.symbol} (${item.name})` : item.symbol;
            (0, output_1.logInfo)(`${label}: ${item.amount}`);
            (0, output_1.logInfo)(`  Mint: ${item.mint}`);
        });
    });
    (0, help_1.addRichHelp)(wallet
        .command("export")
        .description("Export a private key")
        .argument("[name]")
        .option("--file <path>", "Write the private key to a file with 0600 permissions")
        .option("--unsafe-stdout", "Print the private key to stdout/json (unsafe)"), {
        summary: "Reveals the wallet private key after an explicit confirmation prompt.",
        auth: help_1.PASSWORD_AUTH_HELP,
        defaults: [
            "Without --unsafe-stdout, the private key is written to a plaintext file with 0600 permissions.",
            "The command prompts for confirmation before decrypting the wallet."
        ],
        automation: [
            help_1.AUTOMATION_HELP,
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
    })
        .action(async (name, options) => {
        name = await (0, prompt_1.promptIfMissing)(name, "Wallet name");
        const walletName = (0, wallet_manager_1.resolveWalletIdentifier)(name);
        if (!walletName) {
            (0, output_1.logError)("No wallet specified");
            process.exitCode = 1;
            return;
        }
        if (!(await (0, wallet_manager_1.walletExists)(walletName)) &&
            !walletName.endsWith(".json") &&
            !walletName.includes("/") &&
            !walletName.includes("\\")) {
            (0, output_1.logError)(`Wallet not found: ${walletName}`);
            process.exitCode = 1;
            return;
        }
        const ok = await (0, prompt_1.promptConfirm)("This will reveal your private key. Continue?", false);
        if (!ok) {
            (0, output_1.logInfo)("Cancelled");
            return;
        }
        const password = await (0, prompt_1.promptPassword)("Enter wallet password");
        const keypair = await (0, wallet_manager_1.decryptWallet)(walletName, password);
        const privateKey = bs58_1.default.encode(keypair.secretKey);
        let outputFile;
        if (!options.unsafeStdout) {
            await ensureSecretExportDir();
            outputFile = await writeSecretFile(options.file ?? getDefaultSecretExportPath(path_1.default.basename(walletName, ".json"), "private-key"), privateKey);
        }
        if ((0, output_1.isJsonOutput)()) {
            (0, output_1.logJson)({
                name: walletName,
                publicKey: keypair.publicKey.toBase58(),
                ...(outputFile ? { file: outputFile } : {}),
                ...(options.unsafeStdout ? { privateKey } : {})
            });
            return;
        }
        (0, output_1.logSuccess)("Private key exported");
        (0, output_1.logInfo)(`Public key: ${keypair.publicKey.toBase58()}`);
        if (outputFile) {
            (0, output_1.logInfo)(`Private key written to: ${outputFile}`);
        }
        else {
            (0, output_1.logInfo)(`Private key (base58): ${privateKey}`);
        }
    });
}
exports.registerWalletCommands = registerWalletCommands;
