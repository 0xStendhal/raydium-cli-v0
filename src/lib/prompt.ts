import inquirer from "inquirer";
import fs from "fs/promises";
import { isJsonOutput } from "./output";

let assumeYes = false;
let passwordLiteral: string | undefined;
let usePasswordStdin = false;
let cachedPasswordStdin: string | undefined;
let cachedGenericStdin: string | undefined;
let cachedGenericStdinFlag: string | undefined;
let allowUnsafeSecretFlags = false;

export function setAssumeYes(enabled: boolean): void {
  assumeYes = enabled;
}

export function setPassword(value?: string): void {
  passwordLiteral = value;
}

export function setPasswordStdin(enabled: boolean): void {
  usePasswordStdin = enabled;
}

export function setAllowUnsafeSecretFlags(enabled: boolean): void {
  allowUnsafeSecretFlags = enabled;
}

function ensureInteractiveAllowed(): void {
  if (isJsonOutput()) {
    throw new Error("Interactive prompts are disabled with --json. Provide all required flags.");
  }
}

function ensureUnsafeSecretFlagsAllowed(flagName: string): void {
  if (!allowUnsafeSecretFlags) {
    throw new Error(
      `${flagName} is disabled by default because CLI flags leak into shell history and process lists. ` +
        `Use stdin, interactive entry, or pass --unsafe-secret-flags to acknowledge the risk.`
    );
  }
}

async function readPasswordFromStdin(): Promise<string> {
  if (cachedPasswordStdin !== undefined) return cachedPasswordStdin;
  if (cachedGenericStdinFlag && cachedGenericStdinFlag !== "--password-stdin") {
    throw new Error(
      `stdin is already reserved for ${cachedGenericStdinFlag}. Use a file-based secret input or interactive prompt for the password.`
    );
  }
  if (process.stdin.isTTY) {
    throw new Error("--password-stdin requires piping a value via stdin");
  }
  const chunks: string[] = [];
  const input = process.stdin;
  input.setEncoding("utf8");
  for await (const chunk of input) {
    chunks.push(chunk);
  }
  const value = chunks.join("").trim();
  if (!value) {
    throw new Error("No password received on stdin");
  }
  cachedPasswordStdin = value;
  cachedGenericStdin = value;
  cachedGenericStdinFlag = "--password-stdin";
  return value;
}

export async function promptPassword(message = "Enter password", confirm = false): Promise<string> {
  if (passwordLiteral) {
    ensureUnsafeSecretFlagsAllowed("--password");
    return passwordLiteral;
  }
  if (usePasswordStdin) {
    return readPasswordFromStdin();
  }
  ensureInteractiveAllowed();
  const { password } = await inquirer.prompt<{ password: string }>([
    {
      type: "password",
      name: "password",
      message,
      mask: "*",
      validate: (input: string) => (input ? true : "Password is required")
    }
  ]);

  if (!confirm) return password;

  const { confirmPassword } = await inquirer.prompt<{ confirmPassword: string }>([
    {
      type: "password",
      name: "confirmPassword",
      message: "Confirm password",
      mask: "*",
      validate: (input: string) => (input ? true : "Password confirmation is required")
    }
  ]);

  if (password !== confirmPassword) {
    throw new Error("Passwords do not match");
  }

  return password;
}

export async function promptSecretInput(message: string): Promise<string> {
  ensureInteractiveAllowed();
  const { value } = await inquirer.prompt<{ value: string }>([
    {
      type: "password",
      name: "value",
      message,
      mask: "*",
      validate: (input: string) => (input ? true : "Value is required")
    }
  ]);
  return value;
}

export async function promptConfirm(message: string, defaultValue = false): Promise<boolean> {
  if (assumeYes) return true;
  ensureInteractiveAllowed();
  const { ok } = await inquirer.prompt<{ ok: boolean }>([
    {
      type: "confirm",
      name: "ok",
      message,
      default: defaultValue
    }
  ]);

  return ok;
}

export async function promptInput(message: string, defaultValue?: string): Promise<string> {
  ensureInteractiveAllowed();
  const { value } = await inquirer.prompt<{ value: string }>([
    {
      type: "input",
      name: "value",
      message,
      default: defaultValue,
      validate: (input: string) => (input ? true : "Value is required")
    }
  ]);

  return value;
}

export async function readSecretFromStdin(
  label: string,
  flagName: string
): Promise<string> {
  if (cachedGenericStdin !== undefined) {
    if (cachedGenericStdinFlag !== flagName) {
      throw new Error(
        `stdin is already reserved for ${cachedGenericStdinFlag}. Use a file-based secret input or interactive prompt for ${label}.`
      );
    }
    return cachedGenericStdin;
  }

  if (process.stdin.isTTY) {
    throw new Error(`${flagName} requires piping a value via stdin`);
  }

  const chunks: string[] = [];
  const input = process.stdin;
  input.setEncoding("utf8");
  for await (const chunk of input) {
    chunks.push(chunk);
  }
  const value = chunks.join("").trim();
  if (!value) {
    throw new Error(`No ${label} received on stdin`);
  }

  cachedGenericStdin = value;
  cachedGenericStdinFlag = flagName;
  return value;
}

export async function readSecretFromFile(filePath: string, label: string): Promise<string> {
  const value = (await fs.readFile(filePath, "utf8")).trim();
  if (!value) {
    throw new Error(`No ${label} found in file: ${filePath}`);
  }
  return value;
}
