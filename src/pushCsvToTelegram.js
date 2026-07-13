/**
 * Push the day's two CSVs to the Telegram channel after the close (15:30 IST).
 *
 *   data/<market>_30min_<YYYY-MM-DD>.csv          — the candle log
 *   data/plan4_<market>_signals_<YYYY-MM-DD>.csv  — the signal log
 *
 * Usage:
 *   node src/pushCsvToTelegram.js          # waits until 15:30 IST, then uploads
 *   node src/pushCsvToTelegram.js --now    # upload immediately, whatever the time
 *
 * Env:
 *   MARKET=NIFTY|SILVER   which day's files to send (default NIFTY)
 *   PUSH_AT=15:30         IST time to push at (default 15:30)
 *   CANDLE_MINUTES=30     must match the engine, so the filename matches
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   (see lib/telegram.js)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { sendTelegram, sendTelegramDocument, isConfigured } = require('./lib/telegram');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MARKET = (process.env.MARKET || 'NIFTY').toUpperCase();
const CANDLE_MINUTES = Number(process.env.CANDLE_MINUTES) || 30;
const SEND_NOW = process.argv.includes('--now');

// --- IST helpers (same convention as plan4Engine: shift UTC by +5:30) --------
const nowIST = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);

function istDateStr(d = nowIST()) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function istMinutesOfDay(d = nowIST()) {
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function hhmmToMin(s, def) {
    const m = s && /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    return m ? +m[1] * 60 + +m[2] : def;
}

const PUSH_AT_MIN = hhmmToMin(process.env.PUSH_AT, 15 * 60 + 30); // 15:30 IST

/** Resolve until the IST clock reaches PUSH_AT_MIN. Returns at once if already past. */
function waitUntilPushTime() {
    return new Promise((resolve) => {
        const tick = () => {
            const mins = istMinutesOfDay();
            if (mins >= PUSH_AT_MIN) return resolve();

            const left = PUSH_AT_MIN - mins;
            console.log(`[push] ${left} min until ${process.env.PUSH_AT || '15:30'} IST — waiting…`);
            // re-check every minute, so an overnight/long wait stays accurate
            setTimeout(tick, 60 * 1000);
        };
        tick();
    });
}

function rowCount(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return Math.max(0, lines.length - 1); // minus header
}

async function main() {
    if (!isConfigured()) {
        console.error('[push] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env — nothing to do.');
        process.exit(1);
    }

    if (SEND_NOW) {
        console.log('[push] --now given, skipping the 15:30 wait.');
    } else {
        await waitUntilPushTime();
    }

    const date = istDateStr();
    const mkt = MARKET.toLowerCase();
    const files = [
        { label: 'Candles', file: path.join(DATA_DIR, `${mkt}_${CANDLE_MINUTES}min_${date}.csv`) },
        { label: 'Signals', file: path.join(DATA_DIR, `plan4_${mkt}_signals_${date}.csv`) },
    ];

    const missing = files.filter((f) => !fs.existsSync(f.file));
    if (missing.length === files.length) {
        const msg = `⚠️ <b>${MARKET}</b> ${date} — no CSVs found in data/ to push.`;
        console.error('[push] ' + msg);
        await sendTelegram(msg);
        process.exit(1);
    }

    const present = files.filter((f) => fs.existsSync(f.file));
    await sendTelegram(
        `📊 <b>${MARKET} — end of day ${date}</b>\n` +
        present.map((f) => `• ${f.label}: ${rowCount(f.file)} rows`).join('\n') +
        (missing.length ? `\n⚠️ missing: ${missing.map((f) => f.label).join(', ')}` : '')
    );

    let failed = 0;
    for (const { label, file } of present) {
        const res = await sendTelegramDocument(file, `<b>${MARKET} ${label}</b> — ${date}`);
        if (!res.ok) failed++;
    }

    if (failed) {
        console.error(`[push] ${failed} of ${present.length} upload(s) failed.`);
        process.exit(1);
    }
    console.log(`[push] done — ${present.length} file(s) sent to the channel.`);
}

main().catch((err) => {
    console.error('[push] fatal:', err);
    process.exit(1);
});
