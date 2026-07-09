/**
 * Shared SmartAPI session helper.
 * Reuses the refresh token to mint a fresh JWT + feed token, and falls back
 * to the stored tokens in .env when the refresh token is expired.
 *
 * Returns: { smartAPI, jwtToken, feedToken }
 */

const { SmartAPI } = require('smartapi-javascript');
require('dotenv').config();

function clean(v) {
    return v ? v.replace(/^"|"$/g, '') : v;
}

async function createSession() {
    const apiKey = process.env.SMARTAPI_API_KEY;
    if (!apiKey) throw new Error('Missing SMARTAPI_API_KEY in .env');

    const smartAPI = new SmartAPI({ api_key: apiKey });

    let jwtToken = clean(process.env.SMARTAPI_ACCESS_TOKEN);
    let feedToken = clean(process.env.SMARTAPI_FEED_TOKEN);

    const refreshToken = clean(process.env.SMARTAPI_REFRESH_TOKEN);

    if (refreshToken) {
        try {
            const res = await smartAPI.generateToken(refreshToken);
            if (res && res.data && res.data.jwtToken) {
                jwtToken = res.data.jwtToken;
                feedToken = res.data.feedToken || feedToken;
                smartAPI.setAccessToken(jwtToken);
                console.log('[session] Fresh JWT generated from refresh token');
            } else {
                console.log('[session] Refresh token did not return JWT, using stored tokens');
            }
        } catch (err) {
            console.log('[session] generateToken failed, using stored tokens:', err.message);
        }
    }

    if (!jwtToken) {
        throw new Error('No JWT token available. Run: node src/login.js <totp>');
    }

    // Ensure the REST client carries the access token for authenticated calls.
    smartAPI.setAccessToken(jwtToken);

    return { smartAPI, jwtToken, feedToken };
}

module.exports = { createSession, clean };
