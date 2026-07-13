import fs from "fs/promises";
import path from "path";

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => unknown;
};

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function serializeCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [
    columns.map((column) => escapeCsv(column.header)).join(","),
    ...rows.map((row) => columns.map((column) => escapeCsv(column.value(row))).join(","))
  ];
  return `${lines.join("\n")}\n`;
}

export async function writeExport(
  content: string,
  outputPath?: string,
  force = false
): Promise<string | undefined> {
  if (!outputPath || outputPath === "-") {
    process.stdout.write(content);
    return undefined;
  }

  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, { flag: force ? "w" : "wx" });
  return resolved;
}
