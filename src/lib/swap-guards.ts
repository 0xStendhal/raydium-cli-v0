import Decimal from "decimal.js";

export const MAX_SAFE_SLIPPAGE_PERCENT = new Decimal(5);
export const MAX_SLIPPAGE_PERCENT = new Decimal(100);
export const MAX_SAFE_PRIORITY_FEE_SOL = new Decimal("0.01");
export const MAX_PRIORITY_FEE_SOL = new Decimal("0.1");
const COMPUTE_UNITS = new Decimal(600_000);

function parseNonNegativeDecimal(value: string, label: string): Decimal {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`${label} must be a non-negative decimal number`);
  }

  const parsed = new Decimal(normalized);
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new Error(`${label} must be a non-negative decimal number`);
  }
  return parsed;
}

export function parseSlippagePercent(value: string, allowHigh: boolean): Decimal {
  const slippage = parseNonNegativeDecimal(value, "Slippage");
  if (slippage.gt(MAX_SLIPPAGE_PERCENT)) {
    throw new Error(`Slippage cannot exceed ${MAX_SLIPPAGE_PERCENT.toString()}%`);
  }
  if (!allowHigh && slippage.gt(MAX_SAFE_SLIPPAGE_PERCENT)) {
    throw new Error(
      `Slippage above ${MAX_SAFE_SLIPPAGE_PERCENT.toString()}% requires --allow-high-slippage`
    );
  }
  return slippage;
}

export function parsePriorityFeeMicroLamports(value: string, allowHigh: boolean): number {
  const feeSol = parseNonNegativeDecimal(value, "Priority fee");
  if (feeSol.gt(MAX_PRIORITY_FEE_SOL)) {
    throw new Error(`Priority fee cannot exceed ${MAX_PRIORITY_FEE_SOL.toString()} SOL`);
  }
  if (!allowHigh && feeSol.gt(MAX_SAFE_PRIORITY_FEE_SOL)) {
    throw new Error(
      `Priority fee above ${MAX_SAFE_PRIORITY_FEE_SOL.toString()} SOL requires --allow-high-priority-fee`
    );
  }

  const microLamports = feeSol
    .mul(new Decimal(1e9))
    .mul(new Decimal(1e6))
    .div(COMPUTE_UNITS)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

  if (microLamports.gt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Priority fee is too large to encode safely");
  }
  return microLamports.toNumber();
}
