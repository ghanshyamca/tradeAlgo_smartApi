/**
 * ============================================================================
 *  Plan-4 (30-min Bollinger-Band) live engine  —  NIFTY 50
 * ============================================================================
 *
 *  WHAT IT DOES
 *  ------------
 *   1. Runs the market session 09:15 -> 15:30 IST.
 *   2. Streams live NIFTY 50 LTP over SmartAPI WebSocket and aggregates the
 *      ticks into 30-minute OHLC candles.
 *   3. Writes every completed candle (+ Bollinger Bands + pattern flags) to
 *      a per-day CSV:  data/nifty50_30min_<YYYY-MM-DD>.csv
 *   4. Seeds the 20-period Bollinger Band from historical candles on startup
 *      so bands are valid from the first live candle.
 *   5. Evaluates the Plan-4 setup on each closed candle. When it triggers it
 *      fetches the option-greek chain, selects the delta>=0.5 strike, logs a
 *      PAPER trade to data/plan4_trades_<date>.csv and posts to Telegram.
 *
 *  MODE: ALERT-ONLY. No trades are taken (not even paper). The engine only
 *  detects the Plan-4 condition and, once CONFIRMED, posts the signal to the
 *  Telegram channel. All "levels" below are posted as heads-up info, not orders.
 *
 *  PLAN-4 RULES IMPLEMENTED (see mapping in comments below):
 *   cond : NIFTY spot candle closes OUTSIDE the Bollinger Band
 *   a3   : mark previous-candle HIGH and the OUT-OF-BB candle OPEN (CALL & PUT)
 *   c3   : wait 25 minutes
 *   d3   : BUY the strike whose |delta| >= 0.5 (CALL or PUT, single strike)
 *   f3   : if spot hits the marked previous-high -> flip to the opposite side
 *   g3   : 2nd lot when premium = 1st BUY - 15 pts   (needs option premium feed)
 *   h3   : 3rd lot when premium = 2nd BUY - 15 pts   (needs option premium feed)
 *   i3   : STOP-LOSS  -> square off at MKT when spot = markedHigh + 15 pts
 *   j3   : TARGET     -> exit ALL when spot = reference + 60 pts
 * ============================================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { WebSocketV2 } = require('smartapi-javascript');

const { createSession } = require('./lib/session');
const { bollingerBands, bandPosition, isReversalCandle } = require('./lib/indicators');
const { fetchOptionGreeks, selectStrike } = require('./lib/greeks');
const { sendTelegram } = require('./lib/telegram');

// ----------------------------------------------------------------------------
// CONFIG  (tune the ambiguous Plan-4 numbers here)
// ----------------------------------------------------------------------------
const CONFIG = {
    SYMBOL: 'NIFTY 50',
    TOKEN: '99926000',
    EXCHANGE: 'NSE',
    UNDERLYING: 'NIFTY',                        // for optionGreek
    EXPIRY: process.env.NIFTY_EXPIRY || '07JUL2026', // set current weekly expiry

    BB_PERIOD: 20,
    BB_MULT: 2,
    CANDLE_MINUTES: 30,

    SESSION_START_MIN: 9 * 60 + 15,             // 09:15 IST
    SESSION_END_MIN: 15 * 60 + 30,              // 15:30 IST

    WAIT_AFTER_TRIGGER_MIN: 25,                 // c3
    DELTA_THRESHOLD: 0.5,                       // d3

    // Mean-reversion side selection:
    //   close ABOVE upper band  -> expect pullback -> buy PUT
    //   close BELOW lower band   -> expect bounce   -> buy CALL
    // Set REVERSAL_MODE=false for momentum (above->CALL, below->PUT).
    REVERSAL_MODE: true,

    SL_POINTS: 15,                              // i3  (markedHigh + 15)
    TARGET_POINTS: 60,                          // j3  (reference + 60)
    LOT_AVERAGE_POINTS: 15,                     // g3/h3 premium step
    MAX_LOTS: 3,

    TAKE_TRADES: false,                         // ALERT-ONLY: never place/track a position
    POST_SETUP_ALERT: false,                    // post the early (pre-wait) setup too? default: only post CONFIRMED
    LIVE_TRADING: false,                        // kept FALSE; unused while TAKE_TRADES is false

    DATA_DIR: path.join(__dirname, '..', 'data'),
};

// ----------------------------------------------------------------------------
// IST time helpers (work regardless of the host machine timezone)
// ----------------------------------------------------------------------------
function nowIST() {
    // shift UTC by +5:30
    return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}
function istParts(d = nowIST()) {
    return {
        y: d.getUTCFullYear(),
        mo: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        h: d.getUTCHours(),
        mi: d.getUTCMinutes(),
        s: d.getUTCSeconds(),
    };
}
function istMinutesOfDay(d = nowIST()) {
    const p = istParts(d);
    return p.h * 60 + p.mi;
}
function istDateStr(d = nowIST()) {
    const p = istParts(d);
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function istTimeStr(d = nowIST()) {
    const p = istParts(d);
    return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}:${String(p.s).padStart(2, '0')}`;
}
/** Bucket start (minutes-of-day) for the 30-min candle that contains `mins`. */
function bucketStartMin(mins) {
    const off = mins - CONFIG.SESSION_START_MIN;
    return CONFIG.SESSION_START_MIN + Math.floor(off / CONFIG.CANDLE_MINUTES) * CONFIG.CANDLE_MINUTES;
}
function minToHHMM(mins) {
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// ----------------------------------------------------------------------------
// Engine
// ----------------------------------------------------------------------------
class Plan4Engine {
    constructor() {
        this.smartAPI = null;
        this.jwtToken = null;
        this.feedToken = null;
        this.ws = null;

        this.candles = [];          // completed candles (seed + live) oldest->newest
        this.current = null;        // in-progress candle { startMin, open, high, low, close }
        this.lastLTP = null;

        this.setup = null;          // active Plan-4 setup / trade state
        this.dateStr = istDateStr();

        if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
        this.candleCsv = path.join(CONFIG.DATA_DIR, `nifty50_30min_${this.dateStr}.csv`);
        this.tradeCsv = path.join(CONFIG.DATA_DIR, `plan4_trades_${this.dateStr}.csv`);
        this._initCsv();
    }

    _initCsv() {
        if (!fs.existsSync(this.candleCsv)) {
            fs.writeFileSync(
                this.candleCsv,
                'Date,CandleStart,CandleEnd,Open,High,Low,Close,BB_Mid,BB_Upper,BB_Lower,Position,Reversal\n'
            );
        }
        if (!fs.existsSync(this.tradeCsv)) {
            fs.writeFileSync(
                this.tradeCsv,
                'Time,Event,Side,Strike,Delta,RefSpot,Level,Note\n'
            );
        }
    }

    logTrade(event, obj = {}) {
        const row = [
            istTimeStr(),
            event,
            obj.side || '',
            obj.strike || '',
            obj.delta != null ? obj.delta : '',
            obj.refSpot != null ? obj.refSpot : '',
            obj.level != null ? obj.level : '',
            (obj.note || '').replace(/,/g, ';'),
        ].join(',');
        fs.appendFileSync(this.tradeCsv, row + '\n');
        console.log(`[trade] ${row}`);
    }

    // --- startup / seed --------------------------------------------------------
    async init() {
        const s = await createSession();
        this.smartAPI = s.smartAPI;
        this.jwtToken = s.jwtToken;
        this.feedToken = s.feedToken;
        await this.seedHistorical();
    }

    async seedHistorical() {
        try {
            const to = nowIST();
            const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000); // ~10 calendar days
            const fmt = (d) => {
                const p = istParts(d);
                return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ` +
                    `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
            };
            const res = await this.smartAPI.getCandleData({
                exchange: CONFIG.EXCHANGE,
                symboltoken: CONFIG.TOKEN,
                interval: 'THIRTY_MINUTE',
                fromdate: fmt(from),
                todate: fmt(to),
            });
            if (res && res.status && Array.isArray(res.data)) {
                for (const row of res.data) {
                    // row = [timestamp, open, high, low, close, volume]
                    this.candles.push({
                        time: row[0],
                        open: +row[1],
                        high: +row[2],
                        low: +row[3],
                        close: +row[4],
                        seed: true,
                    });
                }
                console.log(`[seed] loaded ${this.candles.length} historical 30-min candles`);
            } else {
                console.log('[seed] historical candle fetch returned no data:', res && res.message);
            }
        } catch (err) {
            console.log('[seed] historical fetch failed (BB warms up live):', err.message);
        }
    }

    // --- websocket -------------------------------------------------------------
    connectWS() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocketV2({
                clientcode: process.env.SMARTAPI_CLIENT_CODE,
                jwttoken: this.jwtToken,
                apikey: process.env.SMARTAPI_API_KEY,
                feedtype: this.feedToken,
            });

            this.ws.connect().then(() => {
                console.log('[ws] connected, subscribing NIFTY 50');
                this.ws.fetchData({
                    correlationID: 'plan4',
                    action: 1,          // subscribe
                    mode: 1,            // LTP
                    exchangeType: 1,    // NSE
                    tokens: [CONFIG.TOKEN],
                });
                resolve();
            }).catch(reject);

            this.ws.on('tick', (data) => this.onTick(data));
            this.ws.on('error', (e) => console.error('[ws] error', e && e.message));
        });
    }

    onTick(data) {
        if (!data) return;
        let token = data.token ? String(data.token).replace(/"/g, '') : null;
        if (token !== CONFIG.TOKEN) return;
        const ltp = parseFloat(data.last_traded_price) / 100;
        if (!ltp || Number.isNaN(ltp)) return;
        this.lastLTP = ltp;
        this.updateCandle(ltp);
        if (this.setup) this.monitorTrade(ltp); // f3 / i3 / j3 live checks
    }

    updateCandle(ltp) {
        const mins = istMinutesOfDay();
        if (mins < CONFIG.SESSION_START_MIN || mins >= CONFIG.SESSION_END_MIN) return;
        const bStart = bucketStartMin(mins);

        if (!this.current) {
            this.current = { startMin: bStart, open: ltp, high: ltp, low: ltp, close: ltp };
            return;
        }
        if (bStart !== this.current.startMin) {
            this.closeCandle(this.current);
            this.current = { startMin: bStart, open: ltp, high: ltp, low: ltp, close: ltp };
            return;
        }
        this.current.high = Math.max(this.current.high, ltp);
        this.current.low = Math.min(this.current.low, ltp);
        this.current.close = ltp;
    }

    closeCandle(c) {
        const closes = this.candles.map((x) => x.close).concat(c.close);
        const bands = bollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_MULT);
        const pos = bandPosition(c, bands);
        const rev = isReversalCandle(c);

        this.candles.push({ ...c, time: `${this.dateStr} ${minToHHMM(c.startMin)}` });

        const endMin = Math.min(c.startMin + CONFIG.CANDLE_MINUTES, CONFIG.SESSION_END_MIN);
        fs.appendFileSync(
            this.candleCsv,
            [
                this.dateStr,
                minToHHMM(c.startMin),
                minToHHMM(endMin),
                c.open.toFixed(2),
                c.high.toFixed(2),
                c.low.toFixed(2),
                c.close.toFixed(2),
                bands ? bands.mid.toFixed(2) : '',
                bands ? bands.upper.toFixed(2) : '',
                bands ? bands.lower.toFixed(2) : '',
                pos,
                rev ? 'YES' : 'NO',
            ].join(',') + '\n'
        );
        console.log(
            `[candle] ${minToHHMM(c.startMin)}-${minToHHMM(endMin)} ` +
            `O${c.open.toFixed(1)} H${c.high.toFixed(1)} L${c.low.toFixed(1)} C${c.close.toFixed(1)} ` +
            `| ${pos}${rev ? ' + reversal' : ''}`
        );

        this.evaluateSetup(c, bands, pos, rev, endMin);
    }

    // --- Plan-4 state machine --------------------------------------------------
    evaluateSetup(candle, bands, pos, rev, endMin) {
        if (this.setup) return; // one active setup at a time

        // cond + a3: candle closed outside BB AND is a doji/hammer reversal candle
        if (!bands || pos === 'inside' || !rev) return;

        const prev = this.candles[this.candles.length - 2]; // candle before the trigger
        const previousHigh = prev ? prev.high : candle.high;

        // side selection (see CONFIG.REVERSAL_MODE)
        let side;
        if (CONFIG.REVERSAL_MODE) side = pos === 'above' ? 'PE' : 'CE';
        else side = pos === 'above' ? 'CE' : 'PE';

        this.setup = {
            state: 'WAIT',
            direction: pos,               // 'above' | 'below'
            side,                         // 'CE' | 'PE' primary
            triggerOpen: candle.open,     // a3
            previousHigh,                 // a3 (marked high used by f3/i3/j3)
            triggerClose: candle.close,
            waitUntilMin: endMin + CONFIG.WAIT_AFTER_TRIGGER_MIN, // c3
            entries: [],                  // paper lots
            flipped: false,
        };

        const msg =
            `⚠️ <b>Plan-4 SETUP forming</b> — NIFTY outside BB\n` +
            `Candle ${minToHHMM(candle.startMin)}-${minToHHMM(endMin)} closed <b>${pos.toUpperCase()}</b> band (doji/hammer)\n` +
            `Close: ${candle.close.toFixed(2)} | BB ${bands.lower.toFixed(0)}–${bands.upper.toFixed(0)}\n` +
            `Marked prev-high: <b>${previousHigh.toFixed(2)}</b> | trigger open: ${candle.open.toFixed(2)}\n` +
            `Likely side: <b>${side}</b>. Confirming in ${CONFIG.WAIT_AFTER_TRIGGER_MIN}m…`;
        console.log('\n' + msg.replace(/<[^>]+>/g, '') + '\n');
        if (CONFIG.POST_SETUP_ALERT) sendTelegram(msg); // otherwise wait for CONFIRMED post
        this.logTrade('SETUP', {
            side, refSpot: candle.close, level: previousHigh,
            note: `${pos} band reversal, open=${candle.open.toFixed(2)}`,
        });
    }

    /** Called on a timer to progress WAIT -> ENTRY once c3 (25 min) elapses. */
    async tick1s() {
        const mins = istMinutesOfDay();
        if (mins >= CONFIG.SESSION_END_MIN) return this.endOfDay();

        if (this.setup && this.setup.state === 'WAIT' && mins >= this.setup.waitUntilMin) {
            await this.confirmSignal();
        }
    }

    /** c3 wait elapsed -> confirm the signal (d3 strike) and POST to Telegram. No trade. */
    async confirmSignal() {
        this.setup.state = 'CONFIRMING';
        try {
            const greeks = await fetchOptionGreeks(this.smartAPI, CONFIG.UNDERLYING, CONFIG.EXPIRY);
            const pick = selectStrike(greeks, this.setup.side, CONFIG.DELTA_THRESHOLD);
            if (!pick) {
                this.logTrade('NO_SIGNAL', { side: this.setup.side, note: 'no strike with delta>=0.5' });
                console.log(`[signal] no ${this.setup.side} strike with |delta|>=${CONFIG.DELTA_THRESHOLD}; nothing posted`);
                this.setup = null;
                return;
            }
            this.setup.state = 'CONFIRMED';
            this.setup.pick = pick;

            const msg =
                `✅ <b>Plan-4 SIGNAL CONFIRMED</b> — NIFTY\n` +
                `Direction: broke <b>${this.setup.direction.toUpperCase()}</b> BB → side <b>${this.setup.side}</b>\n` +
                `Strike: <b>${pick.strikePrice} ${this.setup.side}</b>  (delta ${pick.delta.toFixed(3)}, IV ${pick.impliedVolatility}%)\n` +
                `Spot now: ${this.lastLTP != null ? this.lastLTP.toFixed(2) : 'n/a'}\n` +
                `Marked prev-high: <b>${this.setup.previousHigh.toFixed(2)}</b>\n` +
                `Watch levels → SL ${ (this.setup.previousHigh + CONFIG.SL_POINTS).toFixed(2) } · ` +
                `Target ${ (this.setup.previousHigh + CONFIG.TARGET_POINTS).toFixed(2) }\n` +
                `ℹ️ Alert only — no order placed.`;
            console.log('\n' + msg.replace(/<[^>]+>/g, '') + '\n');
            sendTelegram(msg);
            this.logTrade('SIGNAL', {
                side: this.setup.side, strike: pick.strikePrice, delta: pick.delta,
                refSpot: this.lastLTP, level: this.setup.previousHigh, note: 'confirmed',
            });

            if (!CONFIG.TAKE_TRADES) {
                // Alert-only: keep watching levels for info alerts, then clear on target/SL.
                this.setup.state = 'WATCHING';
            }
        } catch (err) {
            console.error('[signal] failed:', err.message);
            this.logTrade('SIGNAL_ERROR', { note: err.message });
            sendTelegram(`❌ Plan-4 signal error: ${err.message}`);
            this.setup.state = 'WAIT'; // retry on next tick
        }
    }

    /** Post informational level alerts for a CONFIRMED signal. Never trades. */
    monitorTrade(spot) {
        const st = this.setup;
        if (!st || st.state !== 'WATCHING') return;

        // i3 level (info): spot reaches markedHigh + 15
        const slLevel = st.previousHigh + CONFIG.SL_POINTS;
        if (spot >= slLevel && !st.slDone) {
            st.slDone = true;
            this.logTrade('SL_LEVEL', { refSpot: spot, level: slLevel, note: 'info' });
            sendTelegram(`⚠️ <b>Plan-4</b> SL-watch level reached — spot ${spot.toFixed(2)} ≥ ${slLevel.toFixed(2)}.`);
            this.setup = null; // close this signal; ready to detect the next
            return;
        }

        // j3 level (info): spot reaches markedHigh + 60
        const tgtLevel = st.previousHigh + CONFIG.TARGET_POINTS;
        if (spot >= tgtLevel && !st.tgtDone) {
            st.tgtDone = true;
            this.logTrade('TARGET_LEVEL', { refSpot: spot, level: tgtLevel, note: 'info' });
            sendTelegram(`🎯 <b>Plan-4</b> Target-watch level reached — spot ${spot.toFixed(2)} ≥ ${tgtLevel.toFixed(2)}.`);
            this.setup = null;
            return;
        }

        // f3 (info): spot hits the marked previous-high -> reversal side heads-up
        if (!st.flipped && spot >= st.previousHigh) {
            st.flipped = true;
            const opp = st.side === 'CE' ? 'PE' : 'CE';
            this.logTrade('FLIP_LEVEL', { side: opp, refSpot: spot, level: st.previousHigh, note: 'info' });
            sendTelegram(`🔄 <b>Plan-4</b> spot hit prev-high ${st.previousHigh.toFixed(2)} — reversal side would be ${opp}.`);
        }
    }

    endOfDay() {
        if (this._ended) return;
        this._ended = true;
        console.log('\n[eod] 15:30 IST — session complete.');
        if (this.current) this.closeCandle(this.current);
        this.logTrade('EOD', { note: 'session end' });
        sendTelegram('🔔 Plan-4: 15:30 IST — session ended. No more alerts today.');
        this.stop();
    }

    stop() {
        try {
            if (this.ws && this.ws.close) this.ws.close();
        } catch (_) { /* ignore */ }
        setTimeout(() => process.exit(0), 1000);
    }

    async run() {
        await this.init();

        // Idle-wait until 09:15 if started early.
        let mins = istMinutesOfDay();
        if (mins >= CONFIG.SESSION_END_MIN) {
            console.log('[run] market already closed for today. Exiting.');
            return this.stop();
        }
        while (istMinutesOfDay() < CONFIG.SESSION_START_MIN) {
            console.log(`[run] waiting for 09:15 IST (now ${istTimeStr()})…`);
            await new Promise((r) => setTimeout(r, 15000));
        }

        await this.connectWS();
        console.log(`[run] streaming — CSV: ${this.candleCsv}`);
        sendTelegram(`▶️ Plan-4 alert bot started for ${this.dateStr} (alert-only, no trades).`);

        // 1-second scheduler drives the WAIT->ENTRY transition and EOD.
        this._timer = setInterval(() => this.tick1s().catch((e) => console.error(e)), 1000);
    }
}

if (require.main === module) {
    const engine = new Plan4Engine();
    engine.run().catch((err) => {
        console.error('Fatal:', err);
        process.exit(1);
    });

    process.on('SIGINT', () => {
        console.log('\n[run] interrupted, closing…');
        engine.stop();
    });
}

module.exports = Plan4Engine;
