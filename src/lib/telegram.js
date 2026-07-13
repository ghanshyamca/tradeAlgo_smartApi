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
const fs = require('fs');
const path = require('path');
require('dotenv').config();

function isConfigured() {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function creds() {
    return {
        token: process.env.TELEGRAM_BOT_TOKEN.replace(/^"|"$/g, ''),
        chatId: process.env.TELEGRAM_CHAT_ID.replace(/^"|"$/g, ''),
    };
}

function sendTelegram(text) {
    return new Promise((resolve) => {
        if (!isConfigured()) {
            console.log('[telegram] not configured (skipping):\n' + text);
            return resolve({ ok: false, skipped: true });
        }

        const { token, chatId } = creds();

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

/**
 * Upload a file to the channel via sendDocument (multipart/form-data).
 * Telegram caps bot uploads at 50 MB.
 */
function sendTelegramDocument(filePath, caption = '') {
    return new Promise((resolve) => {
        if (!isConfigured()) {
            console.log('[telegram] not configured (skipping upload):', filePath);
            return resolve({ ok: false, skipped: true });
        }
        if (!fs.existsSync(filePath)) {
            console.error('[telegram] file not found:', filePath);
            return resolve({ ok: false, error: 'ENOENT' });
        }

        const { token, chatId } = creds();
        const file = fs.readFileSync(filePath);
        const name = path.basename(filePath);
        const boundary = '----tradeAlgoBoundary' + Buffer.from(name).toString('hex').slice(0, 16);
        const CRLF = '\r\n';

        const field = (n, v) =>
            Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${n}"${CRLF}${CRLF}${v}${CRLF}`);

        const body = Buffer.concat([
            field('chat_id', chatId),
            field('caption', caption),
            field('parse_mode', 'HTML'),
            Buffer.from(
                `--${boundary}${CRLF}` +
                `Content-Disposition: form-data; name="document"; filename="${name}"${CRLF}` +
                `Content-Type: text/csv${CRLF}${CRLF}`
            ),
            file,
            Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
        ]);

        const req = https.request(
            {
                hostname: 'api.telegram.org',
                path: `/bot${token}/sendDocument`,
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length,
                },
            },
            (res) => {
                let out = '';
                res.on('data', (c) => (out += c));
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        console.log(`[telegram] uploaded ${name} (${(file.length / 1024).toFixed(1)} KB)`);
                        resolve({ ok: true });
                    } else {
                        console.error('[telegram] upload failed:', res.statusCode, out);
                        resolve({ ok: false, status: res.statusCode, body: out });
                    }
                });
            }
        );

        req.on('error', (err) => {
            console.error('[telegram] request error:', err.message);
            resolve({ ok: false, error: err.message });
        });

        req.write(body);
        req.end();
    });
}

module.exports = { sendTelegram, sendTelegramDocument, isConfigured };
