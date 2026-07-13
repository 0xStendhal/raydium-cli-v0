"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeExport = exports.serializeCsv = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
function escapeCsv(value) {
    if (value === null || value === undefined)
        return "";
    const text = String(value);
    if (!/[",\r\n]/.test(text))
        return text;
    return `"${text.replace(/"/g, '""')}"`;
}
function serializeCsv(rows, columns) {
    const lines = [
        columns.map((column) => escapeCsv(column.header)).join(","),
        ...rows.map((row) => columns.map((column) => escapeCsv(column.value(row))).join(","))
    ];
    return `${lines.join("\n")}\n`;
}
exports.serializeCsv = serializeCsv;
async function writeExport(content, outputPath, force = false) {
    if (!outputPath || outputPath === "-") {
        process.stdout.write(content);
        return undefined;
    }
    const resolved = path_1.default.resolve(outputPath);
    await promises_1.default.mkdir(path_1.default.dirname(resolved), { recursive: true });
    await promises_1.default.writeFile(resolved, content, { flag: force ? "w" : "wx" });
    return resolved;
}
exports.writeExport = writeExport;
