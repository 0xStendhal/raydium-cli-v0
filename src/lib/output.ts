import chalk from "chalk";
import ora from "ora";
import { inspect } from "util";

let jsonOutput = false;
let debugOutput = false;
let quietOutput = false;

export function setJsonOutput(enabled: boolean): void {
  jsonOutput = enabled;
}

export function isJsonOutput(): boolean {
  return jsonOutput;
}

export function setQuietOutput(enabled: boolean): void {
  quietOutput = enabled;
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
  if (!jsonOutput && !quietOutput) {
    console.log(message);
  }
}

export function logSuccess(message: string): void {
  if (!jsonOutput && !quietOutput) {
    console.log(chalk.green(message));
  }
}

/** Muted, secondary line (e.g. totals, hints). Suppressed in json/quiet modes. */
export function logMuted(message: string): void {
  if (!jsonOutput && !quietOutput) {
    console.log(chalk.gray(message));
  }
}

export type TableAlign = "left" | "right";

export interface TableColumn {
  header: string;
  align?: TableAlign;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*m/g;

function visibleWidth(value: string): number {
  return value.replace(ANSI_PATTERN, "").length;
}

/**
 * Render an aligned, colorized table. Headers are dimmed; cells keep any
 * chalk styling the caller applied (width is measured ignoring ANSI codes).
 * Returns "" when there are no rows.
 */
export function renderTable(columns: TableColumn[], rows: string[][]): string {
  if (rows.length === 0) return "";

  const widths = columns.map((col, i) => {
    const cellMax = rows.reduce((max, row) => Math.max(max, visibleWidth(row[i] ?? "")), 0);
    return Math.max(visibleWidth(col.header), cellMax);
  });

  const pad = (value: string, width: number, align: TableAlign): string => {
    const spaces = " ".repeat(Math.max(0, width - visibleWidth(value)));
    return align === "right" ? spaces + value : value + spaces;
  };

  const headerLine = columns
    .map((col, i) => chalk.bold.dim(pad(col.header, widths[i], col.align ?? "left")))
    .join("  ");

  const bodyLines = rows.map((row) =>
    columns.map((col, i) => pad(row[i] ?? "", widths[i], col.align ?? "left")).join("  ")
  );

  return [headerLine, ...bodyLines].join("\n");
}

export function logTable(columns: TableColumn[], rows: string[][]): void {
  const rendered = renderTable(columns, rows);
  if (rendered) logInfo(rendered);
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
  if (jsonOutput || quietOutput) {
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

export function logGuidedError(options: {
  message: string;
  code: string;
  details?: unknown;
  hints?: string[];
  debug?: boolean;
}): void {
  const hints = options.hints ?? [];
  if (jsonOutput) {
    const details = options.details instanceof Error
      ? options.debug
        ? getErrorDetails(options.details, options.message)
        : getErrorMessage(options.details, options.message)
      : options.details;
    logJson({
      error: options.message,
      code: options.code,
      ...(details !== undefined && { details }),
      ...(hints.length > 0 && { hints })
    });
    return;
  }

  console.error(chalk.red(options.message));
  if (options.debug && options.details !== undefined) {
    console.error(chalk.yellow(formatDetails(options.details)));
  }
  if (hints.length > 0) {
    console.error(chalk.gray("Next steps:"));
    hints.forEach((hint) => console.error(chalk.gray(`  ${hint}`)));
  }
}

function formatDetails(details: unknown): string {
  if (typeof details === "string") return details;
  if (details instanceof Error) return details.stack ?? details.message;
  return inspect(details, { depth: 6, colors: false });
}
