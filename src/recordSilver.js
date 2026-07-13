/**
 * Silver (MCX) test runner for the Plan-4 engine.
 * Sets MARKET=SILVER before loading the engine, then runs it.
 *
 * Usage:
 *   node src/recordSilver.js
 *
 * Optional env overrides:
 *   SILVER_TOKEN=471725 SILVER_SYMBOL=SILVER04SEP26FUT   (front-month future)
 *   CANDLE_MINUTES=1     (record 1-min candles for a quick test)
 *   SESSION_START=09:00 SESSION_END=23:30
 */
process.env.MARKET = 'SILVER';

const Plan4Engine = require('./plan4Engine');

const engine = new Plan4Engine();
engine.run().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
process.on('SIGINT', () => {
    console.log('\n[run] interrupted, closing…');
    engine.stop();
});
