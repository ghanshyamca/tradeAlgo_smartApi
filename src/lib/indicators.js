/**
 * Indicators + candle-pattern helpers used by the Plan-4 engine.
 *
 * A "candle" here is: { time, open, high, low, close }
 */

/**
 * Bollinger Bands over the CLOSE series.
 * @param {number[]} closes  ordered oldest -> newest
 * @param {number} period    lookback (default 20)
 * @param {number} mult      std-dev multiplier (default 2)
 * @returns {{mid,upper,lower,stdev}|null}  bands for the LAST close, or null if not enough data
 */
function bollingerBands(closes, period = 20, mult = 2) {
    if (!Array.isArray(closes) || closes.length < period) return null;

    const window = closes.slice(closes.length - period);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const stdev = Math.sqrt(variance);

    return {
        mid: mean,
        upper: mean + mult * stdev,
        lower: mean - mult * stdev,
        stdev,
    };
}

/**
 * Where does the candle sit relative to the bands?
 * "outside" = the candle CLOSED beyond a band.
 * @returns {'above'|'below'|'inside'}
 */
function bandPosition(candle, bands) {
    if (!bands) return 'inside';
    if (candle.close > bands.upper) return 'above';
    if (candle.close < bands.lower) return 'below';
    return 'inside';
}

/**
 * Doji: very small real body relative to the full range.
 * @param {number} bodyRatio  max body/range to still count as doji (default 0.1)
 */
function isDoji(candle, bodyRatio = 0.1) {
    const range = candle.high - candle.low;
    if (range <= 0) return false;
    const body = Math.abs(candle.close - candle.open);
    return body / range <= bodyRatio;
}

/**
 * Hammer / inverted-hammer style candle: small body, one long wick (>= 2x body).
 * We accept either a long lower wick (hammer) or long upper wick (shooting star /
 * inverted hammer) because Plan-4 marks reversal candles at BOTH band extremes.
 */
function isHammer(candle, wickRatio = 2) {
    const body = Math.abs(candle.close - candle.open);
    if (body <= 0) return isDoji(candle); // flat body -> treat as doji
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    return lowerWick >= wickRatio * body || upperWick >= wickRatio * body;
}

/** Reversal/indecision candle = doji OR hammer/shooting-star. */
function isReversalCandle(candle) {
    return isDoji(candle) || isHammer(candle);
}

module.exports = {
    bollingerBands,
    bandPosition,
    isDoji,
    isHammer,
    isReversalCandle,
};
