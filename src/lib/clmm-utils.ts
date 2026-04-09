import Decimal from "decimal.js";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

// Q64.64 fixed point constant
const Q64 = new Decimal(2).pow(64);

/**
 * Convert sqrtPriceX64 (Q64.64 fixed point) to decimal price
 * sqrtPriceX64 = sqrt(price) * 2^64
 * price = (sqrtPriceX64 / 2^64)^2 = sqrtPriceX64^2 / 2^128
 */
export function sqrtPriceX64ToPrice(
  sqrtPriceX64: BN | string,
  decimalsA: number,
  decimalsB: number
): Decimal {
  const sqrtPrice = new Decimal(sqrtPriceX64.toString()).div(Q64);
  const price = sqrtPrice.pow(2);
  // Adjust for decimal differences: price is token1/token0, so we need to adjust
  const decimalAdjustment = new Decimal(10).pow(decimalsA - decimalsB);
  return price.mul(decimalAdjustment);
}

/**
 * Convert a tick index to price
 * price = 1.0001^tick
 */
export function tickToPrice(tick: number, decimalsA: number, decimalsB: number): Decimal {
  const price = new Decimal(1.0001).pow(tick);
  const decimalAdjustment = new Decimal(10).pow(decimalsA - decimalsB);
  return price.mul(decimalAdjustment);
}

/**
 * Convert tick to sqrtPriceX64
 * sqrtPriceX64 = 1.0001^(tick/2) * 2^64
 */
export function tickToSqrtPriceX64(tick: number): Decimal {
  return new Decimal(1.0001).pow(tick / 2).mul(Q64);
}

/**
 * Calculate token amounts from liquidity for a position
 * Based on Uniswap V3 math:
 * - amount0 = L * (1/sqrt(P_lower) - 1/sqrt(P_upper)) when price <= lower
 * - amount1 = L * (sqrt(P_upper) - sqrt(P_lower)) when price >= upper
 * - Both when price is in range
 */
export function getAmountsFromLiquidity(
  liquidity: BN | string,
  currentSqrtPriceX64: BN | string,
  tickLower: number,
  tickUpper: number,
  decimalsA: number,
  decimalsB: number
): { amount0: Decimal; amount1: Decimal } {
  const L = new Decimal(liquidity.toString());
  const sqrtPriceCurrent = new Decimal(currentSqrtPriceX64.toString());
  const sqrtPriceLower = tickToSqrtPriceX64(tickLower);
  const sqrtPriceUpper = tickToSqrtPriceX64(tickUpper);

  let amount0 = new Decimal(0);
  let amount1 = new Decimal(0);

  if (sqrtPriceCurrent.lte(sqrtPriceLower)) {
    // Current price is below the range - all liquidity is in token0
    // amount0 = L * (sqrt(P_upper) - sqrt(P_lower)) / (sqrt(P_lower) * sqrt(P_upper))
    amount0 = L.mul(sqrtPriceUpper.sub(sqrtPriceLower))
      .div(sqrtPriceLower.mul(sqrtPriceUpper))
      .mul(Q64); // Multiply by Q64 because sqrtPrices are scaled
  } else if (sqrtPriceCurrent.gte(sqrtPriceUpper)) {
    // Current price is above the range - all liquidity is in token1
    // amount1 = L * (sqrt(P_upper) - sqrt(P_lower)) / Q64
    amount1 = L.mul(sqrtPriceUpper.sub(sqrtPriceLower)).div(Q64);
  } else {
    // Price is in range - split between both tokens
    // amount0 = L * (sqrt(P_upper) - sqrt(P_current)) / (sqrt(P_current) * sqrt(P_upper))
    amount0 = L.mul(sqrtPriceUpper.sub(sqrtPriceCurrent))
      .div(sqrtPriceCurrent.mul(sqrtPriceUpper))
      .mul(Q64);
    // amount1 = L * (sqrt(P_current) - sqrt(P_lower)) / Q64
    amount1 = L.mul(sqrtPriceCurrent.sub(sqrtPriceLower)).div(Q64);
  }

  // Convert to human-readable amounts by dividing by decimals
  const amount0Human = amount0.div(new Decimal(10).pow(decimalsA));
  const amount1Human = amount1.div(new Decimal(10).pow(decimalsB));

  return { amount0: amount0Human, amount1: amount1Human };
}

/**
 * Calculate token amounts from liquidity for a tick range (for tick listing)
 * This shows how much liquidity is available in a given tick range
 */
export function getAmountsForTickRange(
  liquidityNet: BN | string,
  tickIndex: number,
  tickSpacing: number,
  currentTick: number,
  currentSqrtPriceX64: BN | string,
  decimalsA: number,
  decimalsB: number
): { amount0: Decimal; amount1: Decimal } {
  // For a tick, liquidityNet represents the change in liquidity when crossing
  // We calculate the amounts assuming the liquidity covers the next tick spacing
  const tickLower = tickIndex;
  const tickUpper = tickIndex + tickSpacing;

  const L = new Decimal(liquidityNet.toString()).abs();
  if (L.isZero()) {
    return { amount0: new Decimal(0), amount1: new Decimal(0) };
  }

  const sqrtPriceCurrent = new Decimal(currentSqrtPriceX64.toString());
  const sqrtPriceLower = tickToSqrtPriceX64(tickLower);
  const sqrtPriceUpper = tickToSqrtPriceX64(tickUpper);

  let amount0 = new Decimal(0);
  let amount1 = new Decimal(0);

  if (currentTick < tickLower) {
    // Range is above current price - all in token0
    amount0 = L.mul(sqrtPriceUpper.sub(sqrtPriceLower))
      .div(sqrtPriceLower.mul(sqrtPriceUpper))
      .mul(Q64);
  } else if (currentTick >= tickUpper) {
    // Range is below current price - all in token1
    amount1 = L.mul(sqrtPriceUpper.sub(sqrtPriceLower)).div(Q64);
  } else {
    // Current price is in this range
    amount0 = L.mul(sqrtPriceUpper.sub(sqrtPriceCurrent))
      .div(sqrtPriceCurrent.mul(sqrtPriceUpper))
      .mul(Q64);
    amount1 = L.mul(sqrtPriceCurrent.sub(sqrtPriceLower)).div(Q64);
  }

  const amount0Human = amount0.div(new Decimal(10).pow(decimalsA));
  const amount1Human = amount1.div(new Decimal(10).pow(decimalsB));

  return { amount0: amount0Human, amount1: amount1Human };
}

/**
 * Format a token amount for display
 */
export function formatTokenAmount(amount: Decimal, decimals = 6): string {
  if (amount.isZero()) return "0";
  const fixed = amount.toFixed(decimals);
  // Remove trailing zeros after decimal
  return fixed.replace(/\.?0+$/, "");
}

/**
 * Format a USD value for display
 */
export function formatUsd(value: Decimal | number | null): string {
  if (value === null) return "";
  const num = typeof value === "number" ? value : value.toNumber();
  if (!Number.isFinite(num)) return "";
  if (num < 0.01) return "<$0.01";
  if (num < 1) return `$${num.toFixed(4)}`;
  if (num < 1000) return `$${num.toFixed(2)}`;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Calculate total USD value from two token amounts and their prices
 * Returns null if neither price is available
 */
export function calculateUsdValue(
  amount0: Decimal,
  amount1: Decimal,
  price0: number | null,
  price1: number | null
): Decimal | null {
  if (price0 === null && price1 === null) return null;
  let total = new Decimal(0);
  if (price0 !== null) total = total.add(amount0.mul(price0));
  if (price1 !== null) total = total.add(amount1.mul(price1));
  return total;
}

/**
 * Format a price with appropriate precision
 */
export function formatPrice(price: Decimal): string {
  const num = price.toNumber();
  if (num === 0) return "0";
  if (num < 0.000001) return price.toExponential(4);
  if (num < 0.0001) return price.toFixed(8);
  if (num < 0.01) return price.toFixed(6);
  if (num < 1) return price.toFixed(4);
  if (num < 100) return price.toFixed(4);
  if (num < 10000) return price.toFixed(2);
  return price.toFixed(0);
}

/**
 * Format fee rate (e.g., 0.25% = 2500 basis points in 1e6)
 */
export function formatFeeRate(feeRate: number): string {
  const percent = (feeRate / 1000000) * 100;
  return `${percent}%`;
}

/**
 * Check if a position is in range
 */
export function isPositionInRange(
  tickLower: number,
  tickUpper: number,
  currentTick: number
): boolean {
  return currentTick >= tickLower && currentTick < tickUpper;
}

/**
 * Convert price to tick, aligned to the given tick spacing
 * price = 1.0001^tick, so tick = log(price) / log(1.0001)
 */
export function priceToTick(
  price: Decimal,
  decimalsA: number,
  decimalsB: number
): number {
  // Adjust price for decimals (reverse of tickToPrice)
  const decimalAdjustment = new Decimal(10).pow(decimalsA - decimalsB);
  const adjustedPrice = price.div(decimalAdjustment);
  // tick = log(adjustedPrice) / log(1.0001)
  return Math.floor(adjustedPrice.ln().div(new Decimal(1.0001).ln()).toNumber());
}

/**
 * Convert price to tick aligned to the given tick spacing
 * Rounds down to nearest valid tick
 */
export function priceToAlignedTick(
  price: Decimal,
  tickSpacing: number,
  decimalsA: number,
  decimalsB: number
): number {
  const tick = priceToTick(price, decimalsA, decimalsB);
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

/**
 * Check if a tick is aligned to the given tick spacing
 */
export function isTickAligned(tick: number, tickSpacing: number): boolean {
  return tick % tickSpacing === 0;
}

/**
 * Fee tier (in basis points) to tick spacing mapping
 * Common Raydium CLMM fee tiers:
 * - 100 bps (1%) -> tick spacing 100
 * - 500 bps (0.5%) -> tick spacing 10
 * - 2500 bps (0.25%) -> tick spacing 60
 * - 10000 bps (1%) -> tick spacing 200
 *
 * Note: The actual mapping depends on the AMM config.
 * This provides common defaults.
 */
export function getTickSpacingFromFeeTier(feeTierBps: number): number {
  switch (feeTierBps) {
    case 100:
      return 1;
    case 500:
      return 10;
    case 2500:
      return 60;
    case 3000:
      return 60;
    case 10000:
      return 200;
    default:
      throw new Error(`Unknown fee tier: ${feeTierBps} bps`);
  }
}

/**
 * Apply slippage to an amount
 * @param amount The amount to apply slippage to
 * @param slippagePercent Slippage as a percentage (e.g., 1 for 1%)
 * @param isMin If true, calculates minimum (amount - slippage), else maximum (amount + slippage)
 */
export function applySlippage(
  amount: BN,
  slippagePercent: number,
  isMin: boolean
): BN {
  const slippageBps = Math.floor(slippagePercent * 100); // Convert percent to basis points
  const factor = isMin ? 10000 - slippageBps : 10000 + slippageBps;
  return amount.mul(new BN(factor)).div(new BN(10000));
}

/**
 * Position info from getOwnerPositionInfo - minimal type for position lookups
 */
export interface PositionInfo {
  nftMint: PublicKey;
  poolId: PublicKey;
  tickLower: number;
  tickUpper: number;
  liquidity: BN;
  tokenFeesOwedA?: BN;
  tokenFeesOwedB?: BN;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  poolInfo?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Find a position by its NFT mint address from an array of positions
 */
export function findPositionByNftMint(
  positions: PositionInfo[],
  nftMint: PublicKey
): PositionInfo | undefined {
  const nftMintStr = nftMint.toBase58();
  return positions.find((p) => p.nftMint?.toBase58() === nftMintStr);
}

/**
 * Check if a position has unclaimed fees
 */
export function hasUnclaimedFees(position: PositionInfo): boolean {
  const feesA = position.tokenFeesOwedA;
  const feesB = position.tokenFeesOwedB;

  const hasFeesA = feesA && !feesA.isZero?.();
  const hasFeesB = feesB && !feesB.isZero?.();

  return hasFeesA || hasFeesB || false;
}

/**
 * Calculate amounts to receive when removing liquidity
 */
export function calculateWithdrawAmounts(
  liquidity: BN,
  totalLiquidity: BN,
  currentSqrtPriceX64: BN | string,
  tickLower: number,
  tickUpper: number,
  decimalsA: number,
  decimalsB: number
): { amount0: Decimal; amount1: Decimal } {
  return getAmountsFromLiquidity(
    liquidity.toString(),
    currentSqrtPriceX64.toString(),
    tickLower,
    tickUpper,
    decimalsA,
    decimalsB
  );
}
