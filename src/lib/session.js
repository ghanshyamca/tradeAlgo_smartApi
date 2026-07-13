/**
 * Shared SmartAPI session helper.
 *
 * Order of preference:
 *   1. mint a fresh JWT from the stored refresh token (cheap, no TOTP)
 *   2. fall back to a full TOTP login (src/login.js) — auto-generated code, so
 *      this works unattended when the engine starts at market open
 *
 * createSession({ forceLogin: true }) skips straight to (2).
 *
 * Returns: { smartAPI, jwtToken, feedToken }
 */

const { SmartAPI } = require('smartapi-javascript');
require('dotenv').config();

const { login } = require('../login');

function clean(v) {
    return v ? v.replace(/^"|"$/g, '') : v;
}

async function createSession({ forceLogin = false } = {}) {
    const apiKey = process.env.SMARTAPI_API_KEY;
    if (!apiKey) throw new Error('Missing SMARTAPI_API_KEY in .env');

    const smartAPI = new SmartAPI({ api_key: apiKey });
    const refreshToken = clean(process.env.SMARTAPI_REFRESH_TOKEN);

    if (!forceLogin && refreshToken) {
        try {
            const res = await smartAPI.generateToken(refreshToken);
            if (res && res.data && res.data.jwtToken) {
                const jwtToken = res.data.jwtToken;
                const feedToken = res.data.feedToken || clean(process.env.SMARTAPI_FEED_TOKEN);
                smartAPI.setAccessToken(jwtToken);
                console.log('[session] fresh JWT from refresh token');
                return { smartAPI, jwtToken, feedToken };
            }
            console.log('[session] refresh token returned no JWT — logging in with TOTP');
        } catch (err) {
            console.log(`[session] generateToken failed (${err.message}) — logging in with TOTP`);
        }
    }

    // Refresh token missing or expired (Angel's expires overnight): full login.
    const s = await login();
    s.smartAPI.setAccessToken(s.jwtToken);
    return { smartAPI: s.smartAPI, jwtToken: s.jwtToken, feedToken: s.feedToken };
}

module.exports = { createSession, clean };
