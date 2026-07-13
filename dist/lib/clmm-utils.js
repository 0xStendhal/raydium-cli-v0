"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateWithdrawAmounts = exports.hasUnclaimedFees = exports.findPositionByNftMint = exports.applySlippage = exports.getTickSpacingFromFeeTier = exports.isTickAligned = exports.priceToAlignedTick = exports.priceToTick = exports.isPositionInRange = exports.formatFeeRate = exports.formatPrice = exports.calculateUsdValue = exports.formatUsd = exports.formatTokenAmount = exports.getAmountsForTickRange = exports.getAmountsFromLiquidity = exports.tickToSqrtPriceX64 = exports.tickToPrice = exports.sqrtPriceX64ToPrice = void 0;
const decimal_js_1 = __importDefault(require("decimal.js"));
const bn_js_1 = __importDefault(require("bn.js"));
// Q64.64 fixed point constant
const Q64 = new decimal_js_1.default(2).pow(64);
/**
 * Convert sqrtPriceX64 (Q64.64 fixed point) to decimal price
 * sqrtPriceX64 = sqrt(price) * 2^64
 * price = (sqrtPriceX64 / 2^64)^2 = sqrtPriceX64^2 / 2^128
 */
function sqrtPriceX64ToPrice(sqrtPriceX64, decimalsA, decimalsB) {
    const sqrtPrice = new decimal_js_1.default(sqrtPriceX64.toString()).div(Q64);
    const price = sqrtPrice.pow(2);
    // Adjust for decimal differences: price is token1/token0, so we need to adjust
    const decimalAdjustment = new decimal_js_1.default(10).pow(decimalsA - decimalsB);
    return price.mul(decimalAdjustment);
}
exports.sqrtPriceX64ToPrice = sqrtPriceX64ToPrice;
/**
 * Convert a tick index to price
 * price = 1.0001^tick
 */
function tickToPrice(tick, decimalsA, decimalsB) {
    const price = new decimal_js_1.default(1.0001).pow(tick);
    const decimalAdjustment = new decimal_js_1.default(10).pow(decimalsA - decimalsB);
    return price.mul(decimalAdjustment);
}
exports.tickToPrice = tickToPrice;
/**
 * Convert tick to sqrtPriceX64
 * sqrtPriceX64 = 1.0001^(tick/2) * 2^64
 */
function tickToSqrtPriceX64(tick) {
    return new decimal_js_1.default(1.0001).pow(tick / 2).mul(Q64);
}
exports.tickToSqrtPriceX64 = tickToSqrtPriceX64;
/**
 * Calculate token amounts from liquidity for a position
 * Based on Uniswap V3 math:
 * - amount0 = L * (1/sqrt(P_lower) - 1/sqrt(P_upper)) when price <= lower
 * - amount1 = L * (sqrt(P_upper) - sqrt(P_lower)) when price >= upper
 * - Both when price is in range
 */
function getAmountsFromLiquidity(liquidity, currentSqrtPriceX64, tickLower, tickUpper, decimalsA, decimalsB) {
    const L = new decimal_js_1.default(liquidity.toString());
    const sqrtPriceCurrent = new decimal_js_1.default(currentSqrtPriceX64.toString());
    const sqrtPriceLower = tickToSqrtPriceX64(tickLower);
    const sqrtPriceUpper = tickToSqrtPriceX64(tickUpper);
    let amount0 = new decimal_js_1.default(0);
    let amount1 = new decimal_js_1.default(0);
    if (sqrtPriceCurrent.lte(sqrtPriceLower)) {
        // Current price is below the range - all liquidity is in token0
        // amount0 = L * (sqrt(P_upper) - sqrt(P_lower)) / (sqrt(P_lower) * sqrt(P_upper))
        amount0 = L.mul(sqrtPriceUpper.sub(sqrtPriceLower))
            .div(sqrtPriceLower.mul(sqrtPriceUpper))
            .mul(Q64); // Multiply by Q64 because sqrtPrices are scaled
    }
    else if (sqrtPriceCurrent.gte(sqrtPriceUpper)) {
        // Current price is above the range - all liquidity is in token1
        // amount1 = L * (sqrt(P_upper) - sqrt(P_lower)) / Q64
        amount1 = L.mul(sqrtPriceUpper.sub(sqrtPriceLower)).div(Q64);
    }
    else {
        // Price is in range - split between both tokens
        // amount0 = L * (sqrt(P_upper) - sqrt(P_current)) / (sqrt(P_current) * sqrt(P_upper))
        amount0 = L.mul(sqrtPriceUpper.sub(sqrtPriceCurrent))
            .div(sqrtPriceCurrent.mul(sqrtPriceUpper))
            .mul(Q64);
        // amount1 = L * (sqrt(P_current) - sqrt(P_lower)) / Q64
        amount1 = L.mul(sqrtPriceCurrent.sub(sqrtPriceLower)).div(Q64);
    }
    // Convert to human-readable amounts by dividing by decimals
    const amount0Human = amount0.div(new decimal_js_1.default(10).pow(decimalsA));
    const amount1Human = amount1.div(new decimal_js_1.default(10).pow(decimalsB));
    return { amount0: amount0Human, amount1: amount1Human };
}
exports.getAmountsFromLiquidity = getAmountsFromLiquidity;
/**
 * Calculate token amounts from liquidity for a tick range (for tick listing)
 * This shows how much liquidity is available in a given tick range
 */
function getAmountsForTickRange(liquidityNet, tickIndex, tickSpacing, currentTick, currentSqrtPriceX64, decimalsA, decimalsB) {
    // For a tick, liquidityNet represents the change in liquidity when crossing
    // We calculate the amounts assuming the liquidity covers the next tick spacing
    const tickLower = tickIndex;
    const tickUpper = tickIndex + tickSpacing;
    const L = new decimal_js_1.default(liquidityNet.toString()).abs();
    if (L.isZero()) {
        return { amount0: new decimal_js_1.default(0), amount1: new decimal_js_1.default(0) };
    }
    const sqrtPriceCurrent = new decimal_js_1.default(currentSqrtPriceX64.toString());
    const sqrtPriceLower = tickToSqrtPriceX64(tickLower);
    const sqrtPriceUpper = tickToSqrtPriceX64(tickUpper);
    let amount0 = new decimal_js_1.default(0);
    let amount1 = new decimal_js_1.default(0);
    if (currentTick < tickLower) {
        // Range is above current price - all in token0
        amount0 = L.mul(sqrtPriceUpper.sub(sqrtPriceLower))
            .div(sqrtPriceLower.mul(sqrtPriceUpper))
            .mul(Q64);
    }
    else if (currentTick >= tickUpper) {
        // Range is below current price - all in token1
        amount1 = L.mul(sqrtPriceUpper.sub(sqrtPriceLower)).div(Q64);
    }
    else {
        // Current price is in this range
        amount0 = L.mul(sqrtPriceUpper.sub(sqrtPriceCurrent))
            .div(sqrtPriceCurrent.mul(sqrtPriceUpper))
            .mul(Q64);
        amount1 = L.mul(sqrtPriceCurrent.sub(sqrtPriceLower)).div(Q64);
    }
    const amount0Human = amount0.div(new decimal_js_1.default(10).pow(decimalsA));
    const amount1Human = amount1.div(new decimal_js_1.default(10).pow(decimalsB));
    return { amount0: amount0Human, amount1: amount1Human };
}
exports.getAmountsForTickRange = getAmountsForTickRange;
/**
 * Format a token amount for display
 */
function formatTokenAmount(amount, decimals = 6) {
    if (amount.isZero())
        return "0";
    const fixed = amount.toFixed(decimals);
    // Remove trailing zeros after decimal
    return fixed.replace(/\.?0+$/, "");
}
exports.formatTokenAmount = formatTokenAmount;
/**
 * Format a USD value for display
 */
function formatUsd(value) {
    if (value === null)
        return "";
    const num = typeof value === "number" ? value : value.toNumber();
    if (!Number.isFinite(num))
        return "";
    if (num < 0.01)
        return "<$0.01";
    if (num < 1)
        return `$${num.toFixed(4)}`;
    if (num < 1000)
        return `$${num.toFixed(2)}`;
    return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
exports.formatUsd = formatUsd;
/**
 * Calculate total USD value from two token amounts and their prices
 * Returns null if neither price is available
 */
function calculateUsdValue(amount0, amount1, price0, price1) {
    if (price0 === null && price1 === null)
        return null;
    let total = new decimal_js_1.default(0);
    if (price0 !== null)
        total = total.add(amount0.mul(price0));
    if (price1 !== null)
        total = total.add(amount1.mul(price1));
    return total;
}
exports.calculateUsdValue = calculateUsdValue;
/**
 * Format a price with appropriate precision
 */
function formatPrice(price) {
    const num = price.toNumber();
    if (num === 0)
        return "0";
    if (num < 0.000001)
        return price.toExponential(4);
    if (num < 0.0001)
        return price.toFixed(8);
    if (num < 0.01)
        return price.toFixed(6);
    if (num < 1)
        return price.toFixed(4);
    if (num < 100)
        return price.toFixed(4);
    if (num < 10000)
        return price.toFixed(2);
    return price.toFixed(0);
}
exports.formatPrice = formatPrice;
/**
 * Format fee rate (e.g., 0.25% = 2500 basis points in 1e6)
 */
function formatFeeRate(feeRate) {
    const percent = (feeRate / 1000000) * 100;
    return `${percent}%`;
}
exports.formatFeeRate = formatFeeRate;
/**
 * Check if a position is in range
 */
function isPositionInRange(tickLower, tickUpper, currentTick) {
    return currentTick >= tickLower && currentTick < tickUpper;
}
exports.isPositionInRange = isPositionInRange;
/**
 * Convert price to tick, aligned to the given tick spacing
 * price = 1.0001^tick, so tick = log(price) / log(1.0001)
 */
function priceToTick(price, decimalsA, decimalsB) {
    // Adjust price for decimals (reverse of tickToPrice)
    const decimalAdjustment = new decimal_js_1.default(10).pow(decimalsA - decimalsB);
    const adjustedPrice = price.div(decimalAdjustment);
    // tick = log(adjustedPrice) / log(1.0001)
    return Math.floor(adjustedPrice.ln().div(new decimal_js_1.default(1.0001).ln()).toNumber());
}
exports.priceToTick = priceToTick;
/**
 * Convert price to tick aligned to the given tick spacing
 * Rounds down to nearest valid tick
 */
function priceToAlignedTick(price, tickSpacing, decimalsA, decimalsB) {
    const tick = priceToTick(price, decimalsA, decimalsB);
    return Math.floor(tick / tickSpacing) * tickSpacing;
}
exports.priceToAlignedTick = priceToAlignedTick;
/**
 * Check if a tick is aligned to the given tick spacing
 */
function isTickAligned(tick, tickSpacing) {
    return tick % tickSpacing === 0;
}
exports.isTickAligned = isTickAligned;
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
function getTickSpacingFromFeeTier(feeTierBps) {
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
exports.getTickSpacingFromFeeTier = getTickSpacingFromFeeTier;
/**
 * Apply slippage to an amount
 * @param amount The amount to apply slippage to
 * @param slippagePercent Slippage as a percentage (e.g., 1 for 1%)
 * @param isMin If true, calculates minimum (amount - slippage), else maximum (amount + slippage)
 */
function applySlippage(amount, slippagePercent, isMin) {
    const slippageBps = Math.floor(slippagePercent * 100); // Convert percent to basis points
    const factor = isMin ? 10000 - slippageBps : 10000 + slippageBps;
    return amount.mul(new bn_js_1.default(factor)).div(new bn_js_1.default(10000));
}
exports.applySlippage = applySlippage;
/**
 * Find a position by its NFT mint address from an array of positions
 */
function findPositionByNftMint(positions, nftMint) {
    const nftMintStr = nftMint.toBase58();
    return positions.find((p) => p.nftMint?.toBase58() === nftMintStr);
}
exports.findPositionByNftMint = findPositionByNftMint;
/**
 * Check if a position has unclaimed fees
 */
function hasUnclaimedFees(position) {
    const feesA = position.tokenFeesOwedA;
    const feesB = position.tokenFeesOwedB;
    const hasFeesA = feesA && !feesA.isZero?.();
    const hasFeesB = feesB && !feesB.isZero?.();
    return hasFeesA || hasFeesB || false;
}
exports.hasUnclaimedFees = hasUnclaimedFees;
/**
 * Calculate amounts to receive when removing liquidity
 */
function calculateWithdrawAmounts(liquidity, totalLiquidity, currentSqrtPriceX64, tickLower, tickUpper, decimalsA, decimalsB) {
    return getAmountsFromLiquidity(liquidity.toString(), currentSqrtPriceX64.toString(), tickLower, tickUpper, decimalsA, decimalsB);
}
exports.calculateWithdrawAmounts = calculateWithdrawAmounts;
