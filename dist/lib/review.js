"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderReviewPanel = exports.formatReviewPanel = void 0;
const chalk_1 = __importDefault(require("chalk"));
const output_1 = require("./output");
const MIN_PANEL_WIDTH = 32;
const MAX_PANEL_WIDTH = 96;
const MAX_LABEL_WIDTH = 20;
function clampWidth(width) {
    return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width));
}
function wrapText(value, width) {
    if (value.length <= width)
        return [value];
    const lines = [];
    let remaining = value;
    while (remaining.length > width) {
        let splitAt = remaining.lastIndexOf(" ", width);
        if (splitAt <= 0)
            splitAt = width;
        lines.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining)
        lines.push(remaining);
    return lines;
}
function applyTone(value, tone, color) {
    if (!color)
        return value;
    switch (tone) {
        case "positive":
            return chalk_1.default.green(value);
        case "warning":
            return chalk_1.default.yellow(value);
        case "danger":
            return chalk_1.default.red(value);
        case "muted":
            return chalk_1.default.gray(value);
        default:
            return value;
    }
}
function formatReviewPanel(panel, options = {}) {
    const color = options.color ?? false;
    const width = clampWidth(options.width ?? process.stdout.columns ?? 80);
    const desiredLabelWidth = Math.max(10, ...panel.rows.map((row) => row.label.length));
    const labelWidth = Math.min(MAX_LABEL_WIDTH, Math.max(8, Math.min(desiredLabelWidth, width - 18)));
    const valueWidth = width - labelWidth - 2;
    const context = panel.context ? `  ${panel.context}` : "";
    const title = color ? chalk_1.default.bold(panel.title) : panel.title;
    const header = `${title}${color ? chalk_1.default.gray(context) : context}`;
    const lines = [header, "-".repeat(width), ""];
    for (const row of panel.rows) {
        const values = wrapText(row.value, valueWidth);
        values.forEach((value, index) => {
            const label = index === 0 ? row.label.padEnd(labelWidth) : "".padEnd(labelWidth);
            const renderedLabel = color ? chalk_1.default.cyan(label) : label;
            lines.push(`${renderedLabel}  ${applyTone(value, row.tone ?? "normal", color)}`);
        });
    }
    if (panel.warnings?.length) {
        lines.push("");
        panel.warnings.forEach((warning) => {
            wrapText(warning, width - 2).forEach((warningLine, index) => {
                const message = `${index === 0 ? "!" : " "} ${warningLine}`;
                lines.push(color ? chalk_1.default.yellow(message) : message);
            });
        });
    }
    return lines.join("\n");
}
exports.formatReviewPanel = formatReviewPanel;
function renderReviewPanel(panel) {
    if ((0, output_1.isJsonOutput)())
        return;
    (0, output_1.logInfo)(formatReviewPanel(panel, { color: true }));
}
exports.renderReviewPanel = renderReviewPanel;
