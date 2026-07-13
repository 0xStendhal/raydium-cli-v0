"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultDerivationPath = exports.decryptWallet = exports.importWalletFromMnemonic = exports.importWalletFromPrivateKey = exports.createWallet = exports.getWalletPublicKey = exports.walletExists = exports.listWallets = exports.ensureWalletDir = exports.resolveWalletIdentifier = exports.getKeystoreOverride = exports.setKeystoreOverride = exports.assertValidWalletName = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const bs58_1 = __importDefault(require("bs58"));
const bip39 = __importStar(require("bip39"));
const web3_js_1 = require("@solana/web3.js");
const paths_1 = require("./paths");
const PBKDF2_ITERATIONS = 100000;
const WALLET_VERSION = 2;
const WALLETS_DIR_MODE = 0o700;
const WALLET_FILE_MODE = 0o600;
const DEFAULT_DERIVATION_PATH = "m/44'/501'/0'/0'";
const HARDENED_OFFSET = 0x80000000;
let keystoreOverride;
function assertValidWalletName(name) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error("Wallet name must use letters, numbers, '_' or '-' only");
    }
}
exports.assertValidWalletName = assertValidWalletName;
function getWalletPath(name) {
    return path_1.default.join(paths_1.WALLETS_DIR, `${name}.json`);
}
function setKeystoreOverride(value) {
    keystoreOverride = value || undefined;
}
exports.setKeystoreOverride = setKeystoreOverride;
function getKeystoreOverride() {
    return keystoreOverride;
}
exports.getKeystoreOverride = getKeystoreOverride;
function resolveWalletIdentifier(explicit, active) {
    return explicit ?? keystoreOverride ?? active ?? undefined;
}
exports.resolveWalletIdentifier = resolveWalletIdentifier;
async function ensureWalletDir() {
    await promises_1.default.mkdir(paths_1.WALLETS_DIR, { recursive: true });
    await promises_1.default.chmod(paths_1.WALLETS_DIR, WALLETS_DIR_MODE);
}
exports.ensureWalletDir = ensureWalletDir;
async function listWallets() {
    try {
        const files = await promises_1.default.readdir(paths_1.WALLETS_DIR);
        const summaries = [];
        for (const file of files) {
            if (!file.endsWith(".json"))
                continue;
            const raw = await promises_1.default.readFile(path_1.default.join(paths_1.WALLETS_DIR, file), "utf8");
            const parsed = JSON.parse(raw);
            summaries.push({
                name: parsed.name,
                publicKey: parsed.publicKey,
                derivationPath: parsed.derivationPath ?? null
            });
        }
        return summaries.sort((a, b) => a.name.localeCompare(b.name));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
}
exports.listWallets = listWallets;
async function walletExists(name) {
    try {
        await promises_1.default.access(getWalletPath(name));
        return true;
    }
    catch {
        return false;
    }
}
exports.walletExists = walletExists;
async function getWalletPublicKey(identifier) {
    const data = await loadWalletFileByIdentifier(identifier);
    return new web3_js_1.PublicKey(data.publicKey);
}
exports.getWalletPublicKey = getWalletPublicKey;
async function createWallet(name, password, derivationPath = DEFAULT_DERIVATION_PATH) {
    assertValidWalletName(name);
    if (await walletExists(name))
        throw new Error(`Wallet already exists: ${name}`);
    const mnemonic = bip39.generateMnemonic();
    const keypair = createKeypairFromMnemonic(mnemonic, derivationPath);
    const wallet = await encryptKeypair(name, keypair, password, { derivationPath });
    await saveWalletFile(wallet);
    return { mnemonic, wallet };
}
exports.createWallet = createWallet;
async function importWalletFromPrivateKey(name, privateKeyBase58, password) {
    assertValidWalletName(name);
    if (await walletExists(name))
        throw new Error(`Wallet already exists: ${name}`);
    const secretKey = bs58_1.default.decode(privateKeyBase58);
    const keypair = web3_js_1.Keypair.fromSecretKey(secretKey);
    const wallet = await encryptKeypair(name, keypair, password, { derivationPath: null });
    await saveWalletFile(wallet);
    return wallet;
}
exports.importWalletFromPrivateKey = importWalletFromPrivateKey;
async function importWalletFromMnemonic(name, mnemonic, password, derivationPath = DEFAULT_DERIVATION_PATH) {
    assertValidWalletName(name);
    if (await walletExists(name))
        throw new Error(`Wallet already exists: ${name}`);
    if (!bip39.validateMnemonic(mnemonic))
        throw new Error("Invalid seed phrase");
    const keypair = createKeypairFromMnemonic(mnemonic, derivationPath);
    const wallet = await encryptKeypair(name, keypair, password, { derivationPath });
    await saveWalletFile(wallet);
    return wallet;
}
exports.importWalletFromMnemonic = importWalletFromMnemonic;
async function decryptWallet(identifier, password) {
    const data = await loadWalletFileByIdentifier(identifier);
    const salt = Buffer.from(data.salt, "base64");
    const iv = Buffer.from(data.iv, "base64");
    const authTag = Buffer.from(data.authTag, "base64");
    const ciphertext = Buffer.from(data.ciphertext, "base64");
    const key = crypto_1.default.pbkdf2Sync(password, salt, data.iterations, 32, "sha256");
    const decipher = crypto_1.default.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return web3_js_1.Keypair.fromSecretKey(plaintext);
}
exports.decryptWallet = decryptWallet;
async function loadWalletFile(name) {
    const raw = await promises_1.default.readFile(getWalletPath(name), "utf8");
    return JSON.parse(raw);
}
async function loadWalletFileByIdentifier(identifier) {
    const resolved = await resolveWalletPath(identifier);
    const raw = await promises_1.default.readFile(resolved, "utf8");
    return JSON.parse(raw);
}
async function resolveWalletPath(identifier) {
    const trimmed = identifier.trim();
    const looksLikePath = trimmed.includes("/") ||
        trimmed.includes("\\") ||
        trimmed.endsWith(".json");
    if (looksLikePath || (await pathExists(trimmed))) {
        const resolved = path_1.default.resolve(trimmed);
        if (!(await pathExists(resolved))) {
            throw new Error(`Wallet file not found: ${resolved}`);
        }
        return resolved;
    }
    assertValidWalletName(trimmed);
    const walletPath = getWalletPath(trimmed);
    if (!(await pathExists(walletPath))) {
        throw new Error(`Wallet not found: ${trimmed}`);
    }
    return walletPath;
}
async function pathExists(filePath) {
    try {
        await promises_1.default.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function saveWalletFile(wallet) {
    await ensureWalletDir();
    const walletPath = getWalletPath(wallet.name);
    await promises_1.default.writeFile(walletPath, JSON.stringify(wallet, null, 2));
    await promises_1.default.chmod(walletPath, WALLET_FILE_MODE);
}
function createKeypairFromMnemonic(mnemonic, derivationPath) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("Invalid seed phrase");
    }
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const privateKey = deriveEd25519PrivateKey(seed, derivationPath);
    return web3_js_1.Keypair.fromSeed(privateKey);
}
function deriveEd25519PrivateKey(seed, derivationPath) {
    const pathIndexes = parseDerivationPath(derivationPath);
    let { key, chainCode } = getMasterKeyFromSeed(seed);
    for (const index of pathIndexes) {
        const indexBuffer = Buffer.alloc(4);
        indexBuffer.writeUInt32BE(index, 0);
        const data = Buffer.concat([Buffer.alloc(1, 0), key, indexBuffer]);
        const digest = crypto_1.default.createHmac("sha512", chainCode).update(data).digest();
        key = digest.subarray(0, 32);
        chainCode = digest.subarray(32);
    }
    return key;
}
function getMasterKeyFromSeed(seed) {
    const digest = crypto_1.default.createHmac("sha512", "ed25519 seed").update(seed).digest();
    return {
        key: digest.subarray(0, 32),
        chainCode: digest.subarray(32)
    };
}
function parseDerivationPath(derivationPath) {
    if (!/^m(\/\d+')+$/.test(derivationPath)) {
        throw new Error(`Invalid derivation path: ${derivationPath}`);
    }
    return derivationPath
        .split("/")
        .slice(1)
        .map((segment) => {
        const value = Number(segment.slice(0, -1));
        if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
            throw new Error(`Invalid derivation path segment: ${segment}`);
        }
        return value + HARDENED_OFFSET;
    });
}
async function encryptKeypair(name, keypair, password, metadata) {
    const salt = crypto_1.default.randomBytes(16);
    const iv = crypto_1.default.randomBytes(12);
    const key = crypto_1.default.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
    const cipher = crypto_1.default.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(keypair.secretKey)), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        version: WALLET_VERSION,
        name,
        publicKey: keypair.publicKey.toBase58(),
        derivationPath: metadata?.derivationPath ?? null,
        cipher: "aes-256-gcm",
        kdf: "pbkdf2-sha256",
        iterations: PBKDF2_ITERATIONS,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        createdAt: new Date().toISOString()
    };
}
function getDefaultDerivationPath() {
    return DEFAULT_DERIVATION_PATH;
}
exports.getDefaultDerivationPath = getDefaultDerivationPath;
