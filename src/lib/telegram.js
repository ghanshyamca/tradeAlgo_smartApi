/**
 * Minimal Telegram alerter (no external dependency — uses built-in https).
 *
 * Configure in .env:
 *   TELEGRAM_BOT_TOKEN=123456:ABC...      (from @BotFather)
 *   TELEGRAM_CHAT_ID=@your_channel  or  -1001234567890
 *
 * If either is missing, sendTelegram() no-ops (so the engine still runs).
 * To post to a channel, add the bot as an admin of that channel.
 */

const https = require('https');
require('dotenv').config();

function isConfigured() {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function sendTelegram(text) {
    return new Promise((resolve) => {
        if (!isConfigured()) {
            console.log('[telegram] not configured (skipping):\n' + text);
            return resolve({ ok: false, skipped: true });
        }

        const token = process.env.TELEGRAM_BOT_TOKEN.replace(/^"|"$/g, '');
        const chatId = process.env.TELEGRAM_CHAT_ID.replace(/^"|"$/g, '');

        const payload = JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        });

        const req = https.request(
            {
                hostname: 'api.telegram.org',
                path: `/bot${token}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve({ ok: true });
                    } else {
                        console.error('[telegram] send failed:', res.statusCode, body);
                        resolve({ ok: false, status: res.statusCode, body });
                    }
                });
            }
        );

        req.on('error', (err) => {
            console.error('[telegram] request error:', err.message);
            resolve({ ok: false, error: err.message });
        });

        req.write(payload);
        req.end();
    });
}

module.exports = { sendTelegram, isConfigured };
