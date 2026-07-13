/**
 * Gold (MCX) runner for the Plan-4 engine.
 * Sets MARKET=GOLD before loading the engine, then runs it.
 *
 * Usage:
 *   node src/recordGold.js
 *
 * Optional env overrides:
 *   GOLD_TOKEN=466583 GOLD_SYMBOL=GOLD05AUG26FUT   (front-month future)
 *   CANDLE_MINUTES=1     (record 1-min candles for a quick test)
 *   SESSION_START=09:00 SESSION_END=23:30
 */
process.env.MARKET = 'GOLD';

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
