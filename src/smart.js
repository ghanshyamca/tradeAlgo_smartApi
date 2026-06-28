require('dotenv').config();
const WebSocket = require('ws');

const apiKey = process.env.SMARTAPI_API_KEY;
const clientCode = process.env.SMARTAPI_CLIENT_CODE;
const feedToken = process.env.SMARTAPI_FEED_TOKEN;

// NIFTY 50 index token
const symbolToken = '99926000';
const exchange = 'NSE';

// Subscription parameters
const wsMode = 1;          // LTP mode
const wsAction = 1;        // Subscribe
const wsExchangeType = 1;  // NSE

function requireEnv(value, name) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

async function main() {
  requireEnv(apiKey, 'SMARTAPI_API_KEY');
  requireEnv(clientCode, 'SMARTAPI_CLIENT_CODE');
  requireEnv(feedToken, 'SMARTAPI_FEED_TOKEN');

  const url = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${clientCode}&feedToken=${feedToken}&apiKey=${apiKey}`;
  console.log(`Connecting to SmartAPI WebSocket: ${url}`);

  const socket = new WebSocket(url);

  socket.on('open', () => {
    console.log(`Streaming live NIFTY 50 (${symbolToken}) over websocket`);

    // Subscription payload
    const payload = {
      correlationID: `nifty50-${Date.now()}`,
      action: wsAction,
      mode: wsMode,
      exchangeType: wsExchangeType,
      tokens: [symbolToken],
    };

    socket.send(JSON.stringify(payload));
    console.log('Websocket subscribed. Press Ctrl+C to stop.');
  });

  socket.on('message', (data) => {
    try {
      const tick = JSON.parse(data);
      console.log(JSON.stringify({
        timestamp: new Date(),
        symbolToken,
        exchange,
        tick,
      }));
    } catch (err) {
      console.error('Failed to parse tick data:', data);
    }
  });

  socket.on('error', (error) => {
    console.error('Websocket error:', error?.message || error);
  });

  socket.on('close', () => {
    console.log('Websocket closed');
  });
}

main().catch((error) => {
  console.error('Failed to fetch NIFTY50 data');
  console.error(error?.response?.data || error.message || error);
  process.exit(1);
});
