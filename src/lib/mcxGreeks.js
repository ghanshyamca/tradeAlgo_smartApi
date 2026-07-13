/**
 * MCX option-greek helper (GOLD / SILVER).
 *
 * Angel's optionGreek endpoint only covers NSE F&O — it has no MCX chain — so
 * for commodities we build the chain ourselves:
 *
 *   1. read the option contracts (OPTFUT) for the underlying out of master.json
 *   2. take the nearest live expiry, keep the strikes bracketing the futures LTP
 *   3. quote them in one marketData(FULL) call
 *   4. back out IV from each option's LTP and compute delta with Black-76
 *      (Black-76, not Black-Scholes: MCX options are options *on the future*)
 *   5. apply the same Plan-4 d3 rule as NSE — |delta| >= 0.5, closest to 0.5
 *
 * The delta is therefore ours, not the exchange's. It is only as good as the
 * option's last traded price: an illiquid strike with a stale LTP gives a stale
 * IV, which is why we drop zero-volume strikes before selecting.
 */

const fs = require('fs');
const path = require('path');

const MASTER_PATH = path.join(__dirname, '..', '..', 'master.json');
const RISK_FREE = Number(process.env.RISK_FREE_RATE) || 0.065;

// MCX strikes are stored in paise in the scrip master (16350000 -> 163500).
const STRIKE_SCALE = 100;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "25SEP2026" -> Date (expiry ~17:00 IST, i.e. 11:30 UTC). */
function parseExpiry(s) {
    const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(String(s).trim().toUpperCase());
    if (!m) return null;
    const mo = MONTHS.indexOf(m[2]);
    if (mo === -1) return null;
    return new Date(Date.UTC(+m[3], mo, +m[1], 11, 30));
}

let _chainCache = null; // { GOLD: [rows], SILVER: [rows] } — master.json is 37 MB, parse once

/**
 * All OPTFUT contracts for an underlying, from the scrip master.
 * The 37 MB parse is done once and only the matching rows are retained, so the
 * full master array can be garbage-collected afterwards.
 */
function loadChain(name) {
    if (!_chainCache) _chainCache = {};
    if (_chainCache[name]) return _chainCache[name];

    if (!fs.existsSync(MASTER_PATH)) {
        throw new Error('master.json not found — download the SmartAPI scrip master to the project root');
    }

    const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8'));
    const rows = master
        .filter((r) => r.exch_seg === 'MCX' && r.instrumenttype === 'OPTFUT' && r.name === name)
        .map((r) => ({
            token: String(r.token),
            symbol: r.symbol,
            expiry: r.expiry,
            expiryDate: parseExpiry(r.expiry),
            strike: parseFloat(r.strike) / STRIKE_SCALE,
            // GOLD25SEP26163500CE -> CE | PE
            optionType: /CE$/.test(r.symbol) ? 'CE' : /PE$/.test(r.symbol) ? 'PE' : null,
            lotsize: Number(r.lotsize) || 1,
        }))
        .filter((r) => r.optionType && r.expiryDate && Number.isFinite(r.strike));

    if (!rows.length) throw new Error(`no MCX OPTFUT contracts for ${name} in master.json`);

    _chainCache[name] = rows;
    return rows;
}

/** Nearest expiry not yet past. */
function nearestExpiry(rows, now = new Date()) {
    const live = rows
        .filter((r) => r.expiryDate.getTime() > now.getTime())
        .sort((a, b) => a.expiryDate - b.expiryDate);
    if (!live.length) {
        throw new Error('every MCX expiry in master.json is in the past — refresh master.json');
    }
    return live[0].expiry;
}

// --- Black-76 ---------------------------------------------------------------

/** Abramowitz & Stegun 7.1.26 — plenty accurate for a delta. */
function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x >= 0 ? 1 - p : p;
}

/** Option on a future: F = futures price, T = years, sigma = vol. */
function black76(F, K, T, sigma, type) {
    const df = Math.exp(-RISK_FREE * T);
    if (T <= 0 || sigma <= 0) {
        const intrinsic = type === 'CE' ? Math.max(F - K, 0) : Math.max(K - F, 0);
        return { price: df * intrinsic, delta: intrinsic > 0 ? (type === 'CE' ? 1 : -1) : 0 };
    }
    const vt = sigma * Math.sqrt(T);
    const d1 = (Math.log(F / K) + (sigma * sigma / 2) * T) / vt;
    const d2 = d1 - vt;

    return type === 'CE'
        ? { price: df * (F * normCdf(d1) - K * normCdf(d2)), delta: df * normCdf(d1) }
        : { price: df * (K * normCdf(-d2) - F * normCdf(-d1)), delta: -df * normCdf(-d1) };
}

/** Back out sigma from the traded price by bisection. Null if the price is unpriceable. */
function impliedVol(price, F, K, T, type) {
    const df = Math.exp(-RISK_FREE * T);
    const intrinsic = df * (type === 'CE' ? Math.max(F - K, 0) : Math.max(K - F, 0));
    // below intrinsic (stale/crossed quote) there is no positive vol that fits
    if (!(price > intrinsic) || T <= 0) return null;

    let lo = 1e-4;
    let hi = 5; // 500% vol — far above anything gold trades at
    if (black76(F, K, T, hi, type).price < price) return null; // price above the model's ceiling

    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (black76(F, K, T, mid, type).price < price) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

// --- chain + selection ------------------------------------------------------

/**
 * Quote the strikes around the money and compute their greeks.
 *
 * @param {object} smartAPI  authenticated client
 * @param {string} name      'GOLD' | 'SILVER'
 * @param {number} futLTP    current futures price (the engine's live LTP)
 * @param {'CE'|'PE'} side
 * @param {object} [opts]    { expiry, window } — window = strikes each side of ATM
 * @returns {Promise<Array>} rows shaped like lib/greeks.js: { strikePrice, optionType, delta, impliedVolatility, tradeVolume }
 */
async function fetchMcxGreeks(smartAPI, name, futLTP, side, opts = {}) {
    if (!(futLTP > 0)) throw new Error(`no futures LTP for ${name} — cannot price the chain`);

    const rows = loadChain(name);
    const expiry = opts.expiry || process.env[`${name}_OPT_EXPIRY`] || nearestExpiry(rows);
    const window = Number(opts.window) || Number(process.env.MCX_STRIKE_WINDOW) || 12;

    const candidates = rows
        .filter((r) => r.expiry === expiry && r.optionType === side)
        .sort((a, b) => Math.abs(a.strike - futLTP) - Math.abs(b.strike - futLTP))
        .slice(0, window * 2 + 1); // marketData FULL caps at 50 tokens per call

    if (!candidates.length) throw new Error(`no ${side} strikes for ${name} ${expiry}`);

    const res = await smartAPI.marketData({
        mode: 'FULL',
        exchangeTokens: { MCX: candidates.map((c) => c.token) },
    });
    const fetched = (res && res.data && res.data.fetched) || [];
    if (!fetched.length) {
        const why = (res && (res.message || res.errorcode)) || 'empty fetched[]';
        throw new Error(`marketData returned no MCX quotes: ${why}`);
    }

    const quoteByToken = new Map(fetched.map((q) => [String(q.symbolToken), q]));

    const expiryDate = parseExpiry(expiry);
    const T = Math.max((expiryDate.getTime() - Date.now()) / (365 * 24 * 3600 * 1000), 0);

    const out = [];
    for (const c of candidates) {
        const q = quoteByToken.get(c.token);
        if (!q) continue;

        const ltp = Number(q.ltp);
        const volume = Number(q.tradeVolume) || 0;
        if (!(ltp > 0)) continue; // never traded today — nothing to imply a vol from

        const iv = impliedVol(ltp, futLTP, c.strike, T, c.optionType);
        if (iv == null) continue;

        const { delta } = black76(futLTP, c.strike, T, iv, c.optionType);

        out.push({
            strikePrice: c.strike,
            symbol: c.symbol,
            token: c.token,
            expiry: c.expiry,
            optionType: c.optionType,
            delta,
            impliedVolatility: +(iv * 100).toFixed(2), // percent, to match the NSE rows
            tradeVolume: volume,
            ltp,
        });
    }

    if (!out.length) throw new Error(`no priceable ${side} strikes for ${name} ${expiry} (all illiquid or stale)`);
    return out;
}

module.exports = { fetchMcxGreeks, nearestExpiry, loadChain, black76, impliedVol, parseExpiry };
