/**
 * pm2 config — NIFTY (NSE) and GOLD (MCX), engine + end-of-day CSV push.
 *
 *   pm2 start ecosystem.config.js     # register all four apps
 *   pm2 save                          # remember them across a reboot
 *
 * Every app is autorestart:false + cron_restart. That is deliberate:
 * the engine exits at the close and the push job exits after uploading, so a
 * restarting app would just churn — instead each one sits "stopped" overnight
 * and its cron wakes it the next trading morning.
 *
 * The engines idle-wait for SESSION_START on their own, so the cron only has to
 * fire *before* the open, not exactly on it.
 *
 * Cron times are the machine's local clock — this assumes the box is on IST.
 * Fields: min hour day month weekday   (1-5 = Mon-Fri)
 */

const NSE_OPEN = '55 8 * * 1-5';    // 08:55 — engine seeds history, waits for 09:15
const NSE_CLOSE = '25 15 * * 1-5';  // 15:25 — push job waits for the 15:30 close
const MCX_OPEN = '50 8 * * 1-5';    // 08:50 — MCX session starts 09:00
const MCX_CLOSE = '20 23 * * 1-5';  // 23:20 — push job waits for the 23:30 close

/** Shared defaults: run once per cron firing, never restart on exit. */
const oneShotDaily = (cron) => ({
    autorestart: false,
    cron_restart: cron,
    time: true,                     // timestamp every log line
    max_restarts: 3,                // only applies to crash-loops before a clean exit
    merge_logs: true,
});

module.exports = {
    apps: [
        {
            name: 'nifty-engine',
            script: 'src/plan4Engine.js',
            env: { MARKET: 'NIFTY' },
            ...oneShotDaily(NSE_OPEN),
        },
        {
            name: 'nifty-push',
            script: 'src/pushCsvToTelegram.js',
            args: '--market NIFTY',
            ...oneShotDaily(NSE_CLOSE),
        },
        {
            name: 'gold-engine',
            script: 'src/recordGold.js',   // sets MARKET=GOLD itself
            ...oneShotDaily(MCX_OPEN),
        },
        {
            name: 'gold-push',
            script: 'src/pushCsvToTelegram.js',
            args: '--market GOLD',
            ...oneShotDaily(MCX_CLOSE),
        },
    ],
};
