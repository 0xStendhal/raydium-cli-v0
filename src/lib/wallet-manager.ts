import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

import bs58 from "bs58";
import * as bip39 from "bip39";
import { Keypair, PublicKey } from "@solana/web3.js";

import { WALLETS_DIR } from "./paths";

const PBKDF2_ITERATIONS = 100000;
const WALLET_VERSION = 2;
const WALLETS_DIR_MODE = 0o700;
const WALLET_FILE_MODE = 0o600;
const DEFAULT_DERIVATION_PATH = "m/44'/501'/0'/0'";
const HARDENED_OFFSET = 0x80000000;
let keystoreOverride: string | undefined;

export interface WalletFile {
  version: number;
  name: string;
  publicKey: string;
  derivationPath?: string | null;
  cipher: "aes-256-gcm";
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  createdAt: string;
}

export interface WalletSummary {
  name: string;
  publicKey: string;
  derivationPath?: string | null;
}

export function assertValidWalletName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("Wallet name must use letters, numbers, '_' or '-' only");
  }
}

function getWalletPath(name: string): string {
  return path.join(WALLETS_DIR, `${name}.json`);
}

export function setKeystoreOverride(value?: string): void {
  keystoreOverride = value || undefined;
}

export function getKeystoreOverride(): string | undefined {
  return keystoreOverride;
}

export function resolveWalletIdentifier(
  explicit?: string | null,
  active?: string | null,
): string | undefined {
  return explicit ?? keystoreOverride ?? active ?? undefined;
}

export async function ensureWalletDir(): Promise<void> {
  await fs.mkdir(WALLETS_DIR, { recursive: true });
  await fs.chmod(WALLETS_DIR, WALLETS_DIR_MODE);
}

export async function listWallets(): Promise<WalletSummary[]> {
  try {
    const files = await fs.readdir(WALLETS_DIR);
    const summaries: WalletSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(WALLETS_DIR, file), "utf8");
      const parsed = JSON.parse(raw) as WalletFile;
      summaries.push({
        name: parsed.name,
        publicKey: parsed.publicKey,
        derivationPath: parsed.derivationPath ?? null
      });
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function walletExists(name: string): Promise<boolean> {
  try {
    await fs.access(getWalletPath(name));
    return true;
  } catch {
    return false;
  }
}

export async function getWalletPublicKey(identifier: string): Promise<PublicKey> {
  const data = await loadWalletFileByIdentifier(identifier);
  return new PublicKey(data.publicKey);
}

export async function createWallet(
  name: string,
  password: string,
  derivationPath = DEFAULT_DERIVATION_PATH
): Promise<{ mnemonic: string; wallet: WalletFile }> {
  assertValidWalletName(name);
  if (await walletExists(name)) throw new Error(`Wallet already exists: ${name}`);

  const mnemonic = bip39.generateMnemonic();
  const keypair = createKeypairFromMnemonic(mnemonic, derivationPath);
  const wallet = await encryptKeypair(name, keypair, password, { derivationPath });
  await saveWalletFile(wallet);
  return { mnemonic, wallet };
}

export async function importWalletFromPrivateKey(
  name: string,
  privateKeyBase58: string,
  password: string,
): Promise<WalletFile> {
  assertValidWalletName(name);
  if (await walletExists(name)) throw new Error(`Wallet already exists: ${name}`);

  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  const wallet = await encryptKeypair(name, keypair, password, { derivationPath: null });
  await saveWalletFile(wallet);
  return wallet;
}

export async function importWalletFromMnemonic(
  name: string,
  mnemonic: string,
  password: string,
  derivationPath = DEFAULT_DERIVATION_PATH
): Promise<WalletFile> {
  assertValidWalletName(name);
  if (await walletExists(name)) throw new Error(`Wallet already exists: ${name}`);
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Invalid seed phrase");

  const keypair = createKeypairFromMnemonic(mnemonic, derivationPath);
  const wallet = await encryptKeypair(name, keypair, password, { derivationPath });
  await saveWalletFile(wallet);
  return wallet;
}

export async function decryptWallet(identifier: string, password: string): Promise<Keypair> {
  const data = await loadWalletFileByIdentifier(identifier);
  const salt = Buffer.from(data.salt, "base64");
  const iv = Buffer.from(data.iv, "base64");
  const authTag = Buffer.from(data.authTag, "base64");
  const ciphertext = Buffer.from(data.ciphertext, "base64");

  const key = crypto.pbkdf2Sync(password, salt, data.iterations, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return Keypair.fromSecretKey(plaintext);
}

async function loadWalletFile(name: string): Promise<WalletFile> {
  const raw = await fs.readFile(getWalletPath(name), "utf8");
  return JSON.parse(raw) as WalletFile;
}

async function loadWalletFileByIdentifier(identifier: string): Promise<WalletFile> {
  const resolved = await resolveWalletPath(identifier);
  const raw = await fs.readFile(resolved, "utf8");
  return JSON.parse(raw) as WalletFile;
}

async function resolveWalletPath(identifier: string): Promise<string> {
  const trimmed = identifier.trim();
  const looksLikePath =
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.endsWith(".json");
  if (looksLikePath || (await pathExists(trimmed))) {
    const resolved = path.resolve(trimmed);
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function saveWalletFile(wallet: WalletFile): Promise<void> {
  await ensureWalletDir();
  const walletPath = getWalletPath(wallet.name);
  await fs.writeFile(walletPath, JSON.stringify(wallet, null, 2));
  await fs.chmod(walletPath, WALLET_FILE_MODE);
}

function createKeypairFromMnemonic(mnemonic: string, derivationPath: string): Keypair {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("Invalid seed phrase");
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const privateKey = deriveEd25519PrivateKey(seed, derivationPath);
  return Keypair.fromSeed(privateKey);
}

function deriveEd25519PrivateKey(seed: Buffer, derivationPath: string): Buffer {
  const pathIndexes = parseDerivationPath(derivationPath);
  let { key, chainCode } = getMasterKeyFromSeed(seed);

  for (const index of pathIndexes) {
    const indexBuffer = Buffer.alloc(4);
    indexBuffer.writeUInt32BE(index, 0);
    const data = Buffer.concat([Buffer.alloc(1, 0), key, indexBuffer]);
    const digest = crypto.createHmac("sha512", chainCode).update(data).digest();
    key = digest.subarray(0, 32);
    chainCode = digest.subarray(32);
  }

  return key;
}

function getMasterKeyFromSeed(seed: Buffer): { key: Buffer; chainCode: Buffer } {
  const digest = crypto.createHmac("sha512", "ed25519 seed").update(seed).digest();
  return {
    key: digest.subarray(0, 32),
    chainCode: digest.subarray(32)
  };
}

function parseDerivationPath(derivationPath: string): number[] {
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

async function encryptKeypair(
  name: string,
  keypair: Keypair,
  password: string,
  metadata?: { derivationPath?: string | null }
): Promise<WalletFile> {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
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

export function getDefaultDerivationPath(): string {
  return DEFAULT_DERIVATION_PATH;
}
