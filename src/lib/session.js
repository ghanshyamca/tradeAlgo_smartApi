/**
 * Shared SmartAPI session helper.
 *
 * Every script (nifty-engine, gold-engine, the push jobs) calls this. They all
 * share ONE login per day via .session.json:
 *
 *   1. a live token in the store        -> reuse it, no network call at all
 *   2. another process is logging in    -> wait for it, use its token
 *   3. stored refresh token still good  -> mint a fresh JWT from it (no TOTP)
 *   4. otherwise                        -> full TOTP login, and store the result
 *
 * Angel's JWT expires at midnight IST, so a token minted for the 09:15 NSE open
 * is still valid at the 23:30 MCX close — one login covers the whole day.
 *
 * createSession({ forceLogin: true }) skips the cache and logs in fresh.
 *
 * Returns: { smartAPI, jwtToken, feedToken }
 */

const { SmartAPI } = require('smartapi-javascript');
require('dotenv').config();

const { login } = require('../login');
const store = require('./tokenStore');

function clean(v) {
    return v ? v.replace(/^"|"$/g, '') : v;
}

function client(apiKey, jwtToken) {
    const smartAPI = new SmartAPI({ api_key: apiKey });
    smartAPI.setAccessToken(jwtToken);
    return smartAPI;
}

/** Mint a JWT from the refresh token. Null if it's expired/rejected. */
async function tryRefresh(apiKey, refreshToken) {
    if (!refreshToken) return null;
    try {
        const smartAPI = new SmartAPI({ api_key: apiKey });
        const res = await smartAPI.generateToken(refreshToken);
        if (res && res.data && res.data.jwtToken) {
            return {
                jwtToken: res.data.jwtToken,
                refreshToken: res.data.refreshToken || refreshToken,
                feedToken: res.data.feedToken,
            };
        }
        console.log(`[session] refresh token rejected (${res && res.message})`);
    } catch (err) {
        console.log(`[session] generateToken failed: ${err.message}`);
    }
    return null;
}

async function createSession({ forceLogin = false } = {}) {
    const apiKey = process.env.SMARTAPI_API_KEY;
    if (!apiKey) throw new Error('Missing SMARTAPI_API_KEY in .env');

    // 1. someone already logged in today and the token is still live
    if (!forceLogin) {
        const cached = store.loadLive();
        if (cached) {
            console.log(`[session] reusing shared session (expires ${cached.expiresAt})`);
            return { smartAPI: client(apiKey, cached.jwtToken), jwtToken: cached.jwtToken, feedToken: cached.feedToken };
        }
    }

    // 2. no live token — take the lock so only one process performs the login
    if (!store.acquireLock()) {
        console.log('[session] another process is logging in — waiting for it…');
        const shared = await store.waitForOtherLogin();
        if (shared) {
            console.log('[session] picked up the session it created');
            return { smartAPI: client(apiKey, shared.jwtToken), jwtToken: shared.jwtToken, feedToken: shared.feedToken };
        }
        console.log('[session] that login produced nothing — doing our own');
    }

    try {
        // Re-check inside the lock: we may have been the one waiting on it.
        if (!forceLogin) {
            const cached = store.loadLive();
            if (cached) {
                return { smartAPI: client(apiKey, cached.jwtToken), jwtToken: cached.jwtToken, feedToken: cached.feedToken };
            }
        }

        // 3. refresh token first — cheaper than a TOTP login, and no rate limit
        const stored = store.load() || {};
        const refreshed = !forceLogin
            && await tryRefresh(apiKey, stored.refreshToken || clean(process.env.SMARTAPI_REFRESH_TOKEN));

        if (refreshed) {
            const saved = store.save(refreshed);
            console.log(`[session] fresh JWT from refresh token (expires ${saved.expiresAt})`);
            return { smartAPI: client(apiKey, refreshed.jwtToken), jwtToken: refreshed.jwtToken, feedToken: refreshed.feedToken };
        }

        // 4. full TOTP login — login() writes .env; mirror it into the store
        const s = await login();
        const saved = store.save(s);
        console.log(`[session] new TOTP login, shared with the other scripts (expires ${saved.expiresAt})`);
        return { smartAPI: client(apiKey, s.jwtToken), jwtToken: s.jwtToken, feedToken: s.feedToken };
    } finally {
        store.releaseLock();
    }
}

module.exports = { createSession, clean };
