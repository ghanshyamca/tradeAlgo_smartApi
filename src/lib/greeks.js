/**
 * Option-greek helper.
 * Fetches the full NIFTY option-greek chain from SmartAPI and selects the
 * single strike (CALL or PUT) to trade per Plan-4 rule d3:
 *   "Trade BUY where delta is 0.5 or more, take single strike price."
 *
 * For CE we compare delta directly; for PE we compare |delta| (delta is negative).
 * Among strikes with |delta| >= threshold we pick the one CLOSEST to 0.5
 * (i.e. the most ATM strike that still satisfies the rule) — that is the
 * strike nearest the money, which is what "single strike price" implies.
 */

/**
 * @param {object} smartAPI     authenticated SmartAPI client
 * @param {string} name         underlying, e.g. "NIFTY"
 * @param {string} expirydate   e.g. "07JUL2026"
 * @returns {Promise<Array>}    raw greek rows
 */
async function fetchOptionGreeks(smartAPI, name, expirydate) {
    const res = await smartAPI.optionGreek({ name, expirydate });
    if (!res || res.status !== true || !Array.isArray(res.data)) {
        throw new Error(`optionGreek failed: ${JSON.stringify(res && res.message)}`);
    }
    return res.data.map((r) => ({
        strikePrice: Math.round(parseFloat(r.strikePrice)),
        optionType: r.optionType, // "CE" | "PE"
        delta: parseFloat(r.delta),
        gamma: parseFloat(r.gamma),
        theta: parseFloat(r.theta),
        vega: parseFloat(r.vega),
        impliedVolatility: parseFloat(r.impliedVolatility),
        tradeVolume: parseFloat(r.tradeVolume),
    }));
}

/**
 * Pick the delta>=threshold strike for a given side.
 * @param {Array} greeks       output of fetchOptionGreeks
 * @param {'CE'|'PE'} side
 * @param {number} threshold   default 0.5
 * @returns {object|null}      selected greek row, or null if none qualify
 */
function selectStrike(greeks, side, threshold = 0.5) {
    const candidates = greeks
        .filter((g) => g.optionType === side)
        .map((g) => ({ ...g, absDelta: Math.abs(g.delta) }))
        .filter((g) => g.absDelta >= threshold)
        // require some liquidity so we don't pick a dead deep-ITM strike
        .filter((g) => g.tradeVolume > 0)
        // closest to the threshold = most ATM strike satisfying the rule
        .sort((a, b) => a.absDelta - b.absDelta);

    return candidates[0] || null;
}

module.exports = { fetchOptionGreeks, selectStrike };
