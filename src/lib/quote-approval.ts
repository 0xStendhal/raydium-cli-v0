import crypto from "crypto";

import { isJsonOutput } from "./output";

export function getQuoteApprovalId(action: string, quote: unknown): string {
  const payload = stableStringify({ action, quote });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function withQuoteApprovalId<T extends Record<string, unknown>>(
  action: string,
  quote: T
): T & { quoteId: string } {
  return {
    ...quote,
    quoteId: getQuoteApprovalId(action, quote)
  };
}

export function assertJsonQuoteApproval(params: {
  action: string;
  quote: Record<string, unknown>;
  approvedQuoteId?: string;
}): void {
  if (!isJsonOutput()) return;
  const quoteId = getQuoteApprovalId(params.action, params.quote);
  if (!params.approvedQuoteId) {
    throw new Error(`JSON execution requires --approve-quote ${quoteId} from a fresh quote response`);
  }
  if (params.approvedQuoteId !== quoteId) {
    throw new Error(`Approved quote ID does not match the fresh quote. Expected ${quoteId}`);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
