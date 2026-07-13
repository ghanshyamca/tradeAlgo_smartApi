/**
 * SmartAPI Authentication
 * Generates new access / refresh / feed tokens and writes them back to .env.
 *
 * The TOTP is generated from SMARTAPI_TOTP_SECRET (the base32 secret behind the
 * QR code on Angel One's "Enable TOTP" page), so this runs unattended — pm2 can
 * call it at market start. Pass a code by hand to override:
 *
 *   node src/login.js            # auto TOTP from SMARTAPI_TOTP_SECRET
 *   node src/login.js 123456     # use this code instead
 */

const { SmartAPI } = require('smartapi-javascript');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { generateTotp, secondsUntilRotation } = require('./lib/totp');

const ENV_PATH = path.join(__dirname, '..', '.env');

/** Upsert KEY="value" in .env, and in this process's env so callers see it too. */
function writeEnvTokens(tokens) {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';

    for (const [key, value] of Object.entries(tokens)) {
        if (!value) continue;
        const line = `${key}="${value}"`;
        const re = new RegExp(`^${key}=.*$`, 'm');
        content = re.test(content) ? content.replace(re, line) : `${content.replace(/\s*$/, '')}\n${line}\n`;
        process.env[key] = value;
    }

    fs.writeFileSync(ENV_PATH, content, 'utf8');
}

/** The code rotates every 30s; a code with <5s left can expire in flight at Angel's end. */
function freshTotp(secret) {
    if (secondsUntilRotation() >= 5) return Promise.resolve(generateTotp(secret));

    console.log('[login] TOTP about to rotate — waiting for the next window…');
    return new Promise((resolve) => {
        setTimeout(() => resolve(generateTotp(secret)), secondsUntilRotation() * 1000 + 500);
    });
}

/**
 * Log in and persist the tokens.
 * @param {string} [totp] explicit 6-digit code; omit to derive it from SMARTAPI_TOTP_SECRET
 */
async function login(totp) {
    const apiKey = process.env.SMARTAPI_API_KEY;
    const clientCode = process.env.SMARTAPI_CLIENT_CODE;
    const password = process.env.SMARTAPI_PASSWORD;
    const secret = process.env.SMARTAPI_TOTP_SECRET;

    if (!apiKey || !clientCode || !password) {
        throw new Error('Missing SMARTAPI_API_KEY / SMARTAPI_CLIENT_CODE / SMARTAPI_PASSWORD in .env');
    }

    if (!totp) {
        if (!secret) {
            throw new Error(
                'No TOTP available. Add SMARTAPI_TOTP_SECRET=<base32 secret> to .env ' +
                '(Angel One → Enable TOTP → the key behind the QR code), or pass a code: node src/login.js 123456'
            );
        }
        totp = await freshTotp(secret);
        console.log(`[login] TOTP generated automatically (valid ${secondsUntilRotation()}s)`);
    }

    console.log(`[login] client ${clientCode} — requesting session…`);

    const smartAPI = new SmartAPI({ api_key: apiKey });
    const session = await smartAPI.generateSession(clientCode, password, totp);

    const data = session && session.data;
    if (!data || !data.jwtToken) {
        // Angel returns 200 with { status: false, message } on a bad TOTP/password.
        const why = (session && (session.message || session.errorcode)) || 'no jwtToken in response';
        throw new Error(`Login failed: ${why}`);
    }

    writeEnvTokens({
        SMARTAPI_ACCESS_TOKEN: data.jwtToken,
        SMARTAPI_REFRESH_TOKEN: data.refreshToken,
        SMARTAPI_FEED_TOKEN: data.feedToken,
    });
    console.log('[login] ok — tokens written to .env');

    return {
        smartAPI,
        jwtToken: data.jwtToken,
        refreshToken: data.refreshToken,
        feedToken: data.feedToken,
    };
}

if (require.main === module) {
    login(process.argv[2])
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('[login] fatal:', err.message);
            if (err.response) console.error('details:', JSON.stringify(err.response.data));
            process.exit(1);
        });
}

module.exports = { login };
