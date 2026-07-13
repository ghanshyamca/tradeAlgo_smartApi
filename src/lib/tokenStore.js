/**
 * Shared session store — one login per day, reused by every script.
 *
 * The engines run as separate processes (nifty-engine, gold-engine, the push
 * jobs), and each used to do its own TOTP login. Angel's JWT expires at
 * midnight IST, so a token minted at the NSE open is still good for the MCX
 * close — there is no reason to log in more than once a day.
 *
 * The token lives in .session.json (gitignored — it is a credential).
 * A lock file keeps two engines starting at the same moment from both logging
 * in: the loser waits for the winner and picks up its token.
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', '.session.json');
const LOCK_PATH = STORE_PATH + '.lock';

// Treat a token as dead this many seconds before its real expiry, so we never
// hand a nearly-expired JWT to an engine that is about to run for hours.
const EXPIRY_SKEW_SEC = 5 * 60;

const LOCK_STALE_MS = 60 * 1000;   // a lock older than this is from a crashed process
const LOCK_WAIT_MS = 45 * 1000;    // how long to wait for the other process's login

/** exp claim out of the JWT, in ms. Null if unreadable. */
function jwtExpiryMs(jwt) {
    try {
        const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64').toString());
        return payload.exp ? payload.exp * 1000 : null;
    } catch (_) {
        return null;
    }
}

/** Is this JWT still good, with the safety margin applied? */
function isJwtLive(jwt) {
    if (!jwt) return false;
    const exp = jwtExpiryMs(jwt);
    if (!exp) return false; // can't read an expiry -> don't trust it
    return exp - EXPIRY_SKEW_SEC * 1000 > Date.now();
}

function load() {
    try {
        return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch (_) {
        return null;
    }
}

/** The stored session if it is still usable, else null. */
function loadLive() {
    const s = load();
    return s && isJwtLive(s.jwtToken) ? s : null;
}

function save(session) {
    const body = {
        jwtToken: session.jwtToken,
        refreshToken: session.refreshToken,
        feedToken: session.feedToken,
        savedAt: new Date().toISOString(),
        expiresAt: jwtExpiryMs(session.jwtToken)
            ? new Date(jwtExpiryMs(session.jwtToken)).toISOString()
            : null,
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(body, null, 2), 'utf8');
    return body;
}

// --- cross-process lock -----------------------------------------------------

/** Take the login lock. False if someone else holds it. */
function acquireLock() {
    try {
        // 'wx' fails if the file exists — atomic, so only one process can win
        const fd = fs.openSync(LOCK_PATH, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;

        // A process that died mid-login would leave the lock behind forever.
        try {
            if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
                fs.unlinkSync(LOCK_PATH);
                return acquireLock();
            }
        } catch (_) { /* someone else cleaned it up first */ }

        return false;
    }
}

function releaseLock() {
    try {
        fs.unlinkSync(LOCK_PATH);
    } catch (_) { /* already gone */ }
}

/**
 * Wait for whoever holds the lock to finish logging in, then return their token.
 * Null if they never produced one (crashed, or still going after LOCK_WAIT_MS).
 */
async function waitForOtherLogin() {
    const deadline = Date.now() + LOCK_WAIT_MS;

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (!fs.existsSync(LOCK_PATH)) return loadLive(); // they're done — may still be null
    }
    return null;
}

module.exports = {
    STORE_PATH,
    load,
    loadLive,
    save,
    isJwtLive,
    jwtExpiryMs,
    acquireLock,
    releaseLock,
    waitForOtherLogin,
};
