import chalk from "chalk";

import { isJsonOutput, logInfo } from "./output";

export type ReviewTone = "normal" | "positive" | "warning" | "danger" | "muted";

export type ReviewRow = {
  label: string;
  value: string;
  tone?: ReviewTone;
};

export type ReviewPanel = {
  title: string;
  context?: string;
  rows: ReviewRow[];
  warnings?: string[];
};

type FormatReviewOptions = {
  color?: boolean;
  width?: number;
};

const MIN_PANEL_WIDTH = 32;
const MAX_PANEL_WIDTH = 96;
const MAX_LABEL_WIDTH = 20;

function clampWidth(width: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width));
}

function wrapText(value: string, width: number): string[] {
  if (value.length <= width) return [value];

  const lines: string[] = [];
  let remaining = value;
  while (remaining.length > width) {
    let splitAt = remaining.lastIndexOf(" ", width);
    if (splitAt <= 0) splitAt = width;
    lines.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function applyTone(value: string, tone: ReviewTone, color: boolean): string {
  if (!color) return value;
  switch (tone) {
    case "positive":
      return chalk.green(value);
    case "warning":
      return chalk.yellow(value);
    case "danger":
      return chalk.red(value);
    case "muted":
      return chalk.gray(value);
    default:
      return value;
  }
}

export function formatReviewPanel(
  panel: ReviewPanel,
  options: FormatReviewOptions = {}
): string {
  const color = options.color ?? false;
  const width = clampWidth(options.width ?? process.stdout.columns ?? 80);
  const desiredLabelWidth = Math.max(10, ...panel.rows.map((row) => row.label.length));
  const labelWidth = Math.min(
    MAX_LABEL_WIDTH,
    Math.max(8, Math.min(desiredLabelWidth, width - 18))
  );
  const valueWidth = width - labelWidth - 2;
  const context = panel.context ? `  ${panel.context}` : "";
  const title = color ? chalk.bold(panel.title) : panel.title;
  const header = `${title}${color ? chalk.gray(context) : context}`;
  const lines = [header, "-".repeat(width), ""];

  for (const row of panel.rows) {
    const values = wrapText(row.value, valueWidth);
    values.forEach((value, index) => {
      const label = index === 0 ? row.label.padEnd(labelWidth) : "".padEnd(labelWidth);
      const renderedLabel = color ? chalk.cyan(label) : label;
      lines.push(`${renderedLabel}  ${applyTone(value, row.tone ?? "normal", color)}`);
    });
  }

  if (panel.warnings?.length) {
    lines.push("");
    panel.warnings.forEach((warning) => {
      wrapText(warning, width - 2).forEach((warningLine, index) => {
        const message = `${index === 0 ? "!" : " "} ${warningLine}`;
        lines.push(color ? chalk.yellow(message) : message);
      });
    });
  }

  return lines.join("\n");
}

export function renderReviewPanel(panel: ReviewPanel): void {
  if (isJsonOutput()) return;
  logInfo(formatReviewPanel(panel, { color: true }));
}
