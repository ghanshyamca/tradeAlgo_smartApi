/**
 * RFC 6238 TOTP — the same 6-digit code the authenticator app shows.
 *
 * The secret is the base32 string Angel One gives you on the "Enable TOTP"
 * page (the one behind the QR code), stored as SMARTAPI_TOTP_SECRET in .env.
 * Implemented on node's crypto so we don't take a dependency for ~30 lines.
 */

const crypto = require('crypto');

/** Base32 (RFC 4648, no padding) -> Buffer. Tolerates spaces/lowercase/'=' padding. */
function base32Decode(secret) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(secret).toUpperCase().replace(/[\s=]/g, '');

    let bits = 0;
    let value = 0;
    const out = [];

    for (const ch of clean) {
        const idx = A.indexOf(ch);
        if (idx === -1) throw new Error(`SMARTAPI_TOTP_SECRET is not valid base32 (bad char "${ch}")`);
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push((value >>> bits) & 0xff);
        }
    }
    if (!out.length) throw new Error('SMARTAPI_TOTP_SECRET decoded to an empty key');
    return Buffer.from(out);
}

/**
 * @param {string} secret base32 TOTP secret
 * @param {number} [atMs]  point in time (default now) — the code rotates every 30s
 * @returns {string} 6-digit code, zero-padded
 */
function generateTotp(secret, atMs = Date.now()) {
    const key = base32Decode(secret);

    // 8-byte big-endian counter = unix time / 30s step
    const counter = Math.floor(atMs / 1000 / 30);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
    buf.writeUInt32BE(counter >>> 0, 4);

    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = hmac.readUInt32BE(offset) & 0x7fffffff;

    return String(code % 1_000_000).padStart(6, '0');
}

/** Seconds left before the current code rotates — handy to avoid using a dying code. */
function secondsUntilRotation(atMs = Date.now()) {
    return 30 - Math.floor(atMs / 1000) % 30;
}

module.exports = { generateTotp, secondsUntilRotation, base32Decode };
