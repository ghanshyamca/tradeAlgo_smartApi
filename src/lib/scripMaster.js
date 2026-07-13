/**
 * Scrip-master reader (master.json).
 *
 * The file is ~37 MB, so it is parsed at most once per process and only the
 * rows a caller asks for are retained — the full array is dropped afterwards.
 *
 * Used for expiry resolution (both NSE and MCX) and for building the MCX
 * option chain, so a hardcoded expiry can never go stale again.
 */

const fs = require('fs');
const path = require('path');

const MASTER_PATH = path.join(__dirname, '..', '..', 'master.json');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "14JUL2026" -> Date. Contracts expire during the day, so anchor at 23:59 IST (18:29 UTC). */
function parseExpiry(s) {
    const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(String(s).trim().toUpperCase());
    if (!m) return null;
    const mo = MONTHS.indexOf(m[2]);
    if (mo === -1) return null;
    return new Date(Date.UTC(+m[3], mo, +m[1], 18, 29));
}

const _cache = new Map(); // "EXCH|NAME|TYPE" -> rows

/** Every contract matching exchange + underlying + instrument type. */
function contracts(exch_seg, name, instrumenttype) {
    const key = `${exch_seg}|${name}|${instrumenttype}`;
    if (_cache.has(key)) return _cache.get(key);

    if (!fs.existsSync(MASTER_PATH)) {
        throw new Error('master.json not found — download the SmartAPI scrip master to the project root');
    }

    const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8'));
    const rows = master
        .filter((r) => r.exch_seg === exch_seg && r.name === name && r.instrumenttype === instrumenttype)
        .map((r) => ({
            token: String(r.token),
            symbol: r.symbol,
            expiry: r.expiry,
            expiryDate: parseExpiry(r.expiry),
            strike: parseFloat(r.strike),
            lotsize: Number(r.lotsize) || 1,
        }))
        .filter((r) => r.expiryDate);

    _cache.set(key, rows);
    return rows;
}

/**
 * The nearest expiry that has not passed — the current weekly for NIFTY, the
 * front-month for MCX. This is what replaces a hardcoded NIFTY_EXPIRY.
 */
function nearestExpiry(exch_seg, name, instrumenttype, now = new Date()) {
    const live = contracts(exch_seg, name, instrumenttype)
        .filter((r) => r.expiryDate.getTime() > now.getTime())
        .sort((a, b) => a.expiryDate - b.expiryDate);

    if (!live.length) {
        throw new Error(
            `no live ${name} ${instrumenttype} expiry in master.json — the scrip master is stale, re-download it`
        );
    }
    return live[0].expiry;
}

module.exports = { contracts, nearestExpiry, parseExpiry, MASTER_PATH };
