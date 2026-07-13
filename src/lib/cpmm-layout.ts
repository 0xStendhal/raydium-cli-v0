import { getErrorMessage } from "./output";

const INVALID_BOOL_PATTERN = /^Invalid bool: \d+$/;

/**
 * The pinned SDK decodes CPMM configuration flags as a one-byte boolean.
 * A different value means the account layout no longer matches that decoder.
 */
export function getUnsupportedCpmmLayoutMessage(error: unknown): string | undefined {
  const message = getErrorMessage(error, "");
  if (!INVALID_BOOL_PATTERN.test(message)) return undefined;

  return [
    "This CPMM pool uses an on-chain layout unsupported by the installed Raydium SDK.",
    "Pool inspection can use indexed API data, but CPMM quotes and transactions are disabled for this pool.",
    "Update and validate the SDK before attempting an on-chain CPMM action."
  ].join(" ");
}
