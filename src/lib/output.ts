import chalk from "chalk";
import ora from "ora";
import { inspect } from "util";

let jsonOutput = false;
let debugOutput = false;

export function setJsonOutput(enabled: boolean): void {
  jsonOutput = enabled;
}

export function isJsonOutput(): boolean {
  return jsonOutput;
}

export function setDebugOutput(enabled: boolean): void {
  debugOutput = enabled;
}

export function isDebugOutput(): boolean {
  return debugOutput;
}

export function logJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

export function logInfo(message: string): void {
  if (!jsonOutput) {
    console.log(message);
  }
}

export function logSuccess(message: string): void {
  if (!jsonOutput) {
    console.log(chalk.green(message));
  }
}

export function logError(message: string, details?: unknown): void {
  if (jsonOutput) {
    logJson({ error: message, details });
    return;
  }
  console.error(chalk.red(message));
  if (details) {
    console.error(chalk.yellow(formatDetails(details)));
  }
}

export function logDebug(details: unknown): void {
  if (jsonOutput || !debugOutput) return;
  console.error(chalk.gray(formatDetails(details)));
}

export async function withSpinner<T>(text: string, task: () => Promise<T>): Promise<T> {
  if (jsonOutput) {
    return task();
  }

  const spinner = ora(text).start();
  try {
    const result = await task();
    spinner.succeed();
    return result;
  } catch (error) {
    spinner.fail(text);
    throw error;
  }
}

type ErrorDetails = {
  message?: string;
  stack?: string;
  logs?: string[];
  simulationLogs?: string[];
  signature?: string;
  txId?: string;
  cause?: unknown;
};

export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage) return maybeMessage;
    return inspect(error, { depth: 2, colors: false });
  }
  const str = String(error ?? "");
  return str || fallback;
}

export function getErrorDetails(error: unknown, fallbackMessage: string): ErrorDetails {
  const details: ErrorDetails = { message: getErrorMessage(error, fallbackMessage) };
  if (error instanceof Error && error.stack) {
    details.stack = error.stack;
  }
  const anyError = error as {
    logs?: unknown;
    simulationLogs?: unknown;
    signature?: unknown;
    txId?: unknown;
    cause?: unknown;
    error?: unknown;
  };
  if (Array.isArray(anyError?.logs)) {
    details.logs = anyError.logs.map((entry) => String(entry));
  }
  if (Array.isArray(anyError?.simulationLogs)) {
    details.simulationLogs = anyError.simulationLogs.map((entry) => String(entry));
  }
  if (anyError?.signature) details.signature = String(anyError.signature);
  if (anyError?.txId) details.txId = String(anyError.txId);
  if (anyError?.cause) details.cause = anyError.cause;
  if (!details.cause && anyError?.error) details.cause = anyError.error;
  return details;
}

export function logErrorWithDebug(
  message: string,
  error: unknown,
  options?: { debug?: boolean; fallback?: string },
): void {
  const fallback = options?.fallback ?? message;
  const summary = getErrorMessage(error, fallback);
  const debugEnabled = options?.debug ?? debugOutput;
  if (debugEnabled) {
    logError(message, getErrorDetails(error, summary));
    return;
  }
  logError(message, summary);
}

function formatDetails(details: unknown): string {
  if (typeof details === "string") return details;
  if (details instanceof Error) return details.stack ?? details.message;
  return inspect(details, { depth: 6, colors: false });
}
