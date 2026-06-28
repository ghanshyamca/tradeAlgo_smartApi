require('dotenv').config();
const WebSocket = require('ws');

const apiKey = process.env.SMARTAPI_API_KEY;
const clientCode = process.env.SMARTAPI_CLIENT_CODE;
const feedToken = process.env.SMARTAPI_FEED_TOKEN;

const symbolToken = '99926000'; // NIFTY 50
const url = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${clientCode}&feedToken=${feedToken}&apiKey=${apiKey}`;

const socket = new WebSocket(url);

socket.on('open', () => {
  console.log('Connected. Subscribing to NIFTY50…');

//   const payload = {
//     correlationID: `nifty50-${Date.now()}`,
//     action: 1,
//     mode: 1,
//     exchangeType: 1,
//     tokens: [symbolToken],
//   };

  const payload = {
        "correlationID": `nifty50-${Date.now()}`,
        "action": 1,
        "params": {
            "mode": 1,
            "tokenList": [
                {
                "exchangeType": 1,
                "tokens": [
                        "99926000"
                    ]
                }
            ]
        }
    }

  socket.send(JSON.stringify(payload));
});

function decodeToken(buf, offset = 2) {
  // Slice 25 bytes starting at offset
  const tokenBytes = buf.slice(offset, offset + 25);

  // Convert to UTF-8 string
  let tokenStr = tokenBytes.toString('utf8');

  // Trim at first null character (\u0000)
  const nullIndex = tokenStr.indexOf('\u0000');
  if (nullIndex !== -1) {
    tokenStr = tokenStr.substring(0, nullIndex);
  }

  return tokenStr;
}

socket.on('message', (data) => {
  try {
    console.log('Tick:', JSON.parse(data));
  } catch {
    // console.log('Raw:', data);
    const buf = Buffer.from(data);
    // Each tick packet starts with length (2 bytes, LE)
    const packetLength = buf.readUInt16LE(0);

    // Exchange type (1 byte)
    const exchangeType = buf.readUInt8(1);

    // Token (4 bytes, LE)
    const token = decodeToken(buf, 2);

    // LTP value (8 bytes, double LE)
    const ltp = buf.readInt32LE(43);

    // Timestamp (8 bytes, LE)
    const ts = buf.readBigUInt64LE(15);

    const tick = {
      packetLength,
      exchangeType,
      token,
      ltp:ltp/100,
      timestamp: new Date(Number(ts)),
    };

    console.log(JSON.stringify(tick));
  }
});

socket.on('error', (err) => console.error('Error:', err));
socket.on('close', () => console.log('WebSocket closed'));

// Keep alive
setInterval(() => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.ping();
  }
}, 15000);
