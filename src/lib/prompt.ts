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

export type ActionRisk = "write" | "dangerous" | "secret";

export function setAssumeYes(enabled: boolean): void {
  assumeYes = enabled;
}

export function isAssumeYes(): boolean {
  return assumeYes;
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

export function canPromptInteractively(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !isJsonOutput();
}

function ensureInteractiveAllowed(): void {
  if (isJsonOutput()) {
    throw new Error("Interactive prompts are disabled with --json. Provide all required flags.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive prompts require a terminal. Provide all required flags for automation.");
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

export function canAssumeYesForAction(
  risk: ActionRisk,
  allowExplicitRiskAcknowledgement = false
): boolean {
  return risk === "write" || allowExplicitRiskAcknowledgement;
}

export async function promptActionConfirmation(options: {
  message: string;
  risk?: ActionRisk;
  expectedText?: string;
  allowExplicitRiskAcknowledgement?: boolean;
}): Promise<boolean> {
  const risk = options.risk ?? "write";
  if (assumeYes && canAssumeYesForAction(risk, options.allowExplicitRiskAcknowledgement)) {
    return true;
  }

  ensureInteractiveAllowed();
  if (risk === "write") {
    return promptConfirm(options.message, false);
  }

  const expectedText = options.expectedText;
  if (!expectedText) {
    throw new Error(`Typed confirmation text is required for ${risk} actions`);
  }
  const { confirmation } = await inquirer.prompt<{ confirmation: string }>([
    {
      type: "input",
      name: "confirmation",
      message: `${options.message} Type ${expectedText} to continue`,
      validate: (input: string) =>
        input === expectedText ? true : `Enter ${expectedText} exactly, or press Ctrl+C to cancel`
    }
  ]);
  return confirmation === expectedText;
}

export async function promptInput(
  message: string,
  defaultValue?: string,
  validate?: (input: string) => true | string
): Promise<string> {
  ensureInteractiveAllowed();
  const { value } = await inquirer.prompt<{ value: string }>([
    {
      type: "input",
      name: "value",
      message,
      default: defaultValue,
      validate: (input: string) => {
        if (!input) return "Value is required";
        return validate ? validate(input) : true;
      }
    }
  ]);

  return value;
}

/**
 * Resolve a required command input without forcing it into the command line.
 * Explicit values remain useful for scripts; interactive users are prompted
 * when they omit the value.
 */
export async function promptIfMissing(
  value: string | undefined,
  message: string,
  validate?: (input: string) => true | string
): Promise<string> {
  return value !== undefined && value.trim() !== ""
    ? value
    : promptInput(message, undefined, validate);
}

export async function promptNumberIfMissing(
  value: string | undefined,
  message: string,
  validate: (input: string) => true | string = (input) =>
    Number.isFinite(Number(input)) ? true : "Enter a valid number"
): Promise<string> {
  return promptIfMissing(value, message, validate);
}

export async function promptSelect<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T }>
): Promise<T> {
  ensureInteractiveAllowed();
  const { value } = await inquirer.prompt<{ value: T }>([
    {
      type: "list",
      name: "value",
      message,
      choices
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
