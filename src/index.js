require('dotenv').config();

const { MongoClient } = require('mongodb');
const { SmartAPI, WebSocketV2 } = require('smartapi-javascript');

const apiKey = process.env.SMARTAPI_API_KEY;
const clientCode = process.env.SMARTAPI_CLIENT_CODE;
const password = process.env.SMARTAPI_PASSWORD;
const totp = process.env.SMARTAPI_TOTP;
const accessToken = process.env.SMARTAPI_ACCESS_TOKEN;
const refreshToken = process.env.SMARTAPI_REFRESH_TOKEN;
const feedTokenEnv = process.env.SMARTAPI_FEED_TOKEN;

const symbolToken = process.env.NIFTY50_SYMBOL_TOKEN || '99926000';
const exchange = process.env.NIFTY50_EXCHANGE || 'NSE';
const wsFeedType = process.env.SMARTAPI_WS_FEEDTYPE || 'market_data';
const wsMode = Number(process.env.SMARTAPI_WS_MODE || 1);
const wsAction = Number(process.env.SMARTAPI_WS_ACTION || 1);
const wsExchangeType = Number(process.env.SMARTAPI_WS_EXCHANGE_TYPE || 1);
const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB || 'tradeAlgo';
const mongoCollectionName = process.env.MONGODB_COLLECTION || 'nifty50_ticks';
const mongoTtlSeconds = Number(process.env.MONGODB_TTL_SECONDS || 7 * 24 * 60 * 60);

function requireEnv(value, name) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function createClient() {
  requireEnv(apiKey, 'SMARTAPI_API_KEY');
  requireEnv(clientCode, 'SMARTAPI_CLIENT_CODE');

  return new SmartAPI({
    api_key: apiKey,
    access_token: accessToken,
    refresh_token: refreshToken,
  });
}

async function createMongoCollection() {
  requireEnv(mongoUri, 'MONGODB_URI');

  const client = new MongoClient(mongoUri);
  await client.connect();

  const collection = client.db(mongoDbName).collection(mongoCollectionName);
  await collection.createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: mongoTtlSeconds, name: 'timestamp_ttl_index' },
  );

  return { client, collection };
}

function getLoginTokens(session) {
  const payload = session?.data?.data || session?.data || session;

  return {
    jwtToken: payload?.jwtToken,
    refreshToken: payload?.refreshToken,
    feedToken: payload?.feedToken,
  };
}

async function main() {
  const smartApi = createClient();
  let mongo;
  let socket;
  let stopped = false;

  const shutdown = async () => {
    if (stopped) {
      return;
    }
    stopped = true;

    try {
      if (socket) {
        socket.close();
      }
    } catch (error) {
      console.error('Websocket close failed:', error?.message || error);
    }

    try {
      if (typeof smartApi.logout === 'function') {
        await smartApi.logout();
      }
    } catch (error) {
      console.error('Logout failed:', error?.response?.data || error.message || error);
    }

    try {
      if (mongo?.client) {
        await mongo.client.close();
      }
    } catch (error) {
      console.error('MongoDB close failed:', error?.message || error);
    }
  };

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });

  try {
    let jwtToken = accessToken;
    let feedToken = feedTokenEnv;

    if (!jwtToken || !feedToken) {
      requireEnv(password, 'SMARTAPI_PASSWORD');
      requireEnv(totp, 'SMARTAPI_TOTP');

      const session = await smartApi.generateSession(clientCode, password, totp);
      const tokens = getLoginTokens(session);

      if (!tokens.jwtToken) {
        throw new Error(`SmartAPI login did not return a JWT token. status=${session?.status} message=${session?.message || 'n/a'} data=${JSON.stringify(session?.data)}`);
      }

      jwtToken = tokens.jwtToken;
      feedToken = tokens.feedToken || feedToken;
    }

    if (!jwtToken) {
      throw new Error('No JWT token available. Provide SMARTAPI_ACCESS_TOKEN or valid SMARTAPI_PASSWORD and SMARTAPI_TOTP.');
    }

    if (!feedToken) {
      throw new Error('No feed token available. Provide SMARTAPI_FEED_TOKEN or use a successful SmartAPI login.');
    }

    mongo = await createMongoCollection();

    console.log(`Streaming live NIFTY 50 (${symbolToken}) over websocket`);

    socket = new WebSocketV2({
      jwttoken: jwtToken,
      apikey: apiKey,
      clientcode: clientCode,
      feedtype: wsFeedType,
    });

    socket.on('tick', (tick) => {
      const document = {
        timestamp: new Date(),
        receivedAt: new Date().toISOString(),
        symbolToken,
        exchange,
        tick,
      };

      mongo.collection.insertOne(document).catch((error) => {
        console.error('MongoDB insert failed:', error?.message || error);
      });

      console.log(JSON.stringify(document));
    });

    socket.on('error', (error) => {
      console.error('Websocket error:', error?.message || error);
    });

    socket.on('close', async () => {
      if (!stopped) {
        await shutdown();
      }
    });

    await socket.connect();
    socket.fetchData({
      correlationID: `nifty50-${Date.now()}`,
      action: wsAction,
      mode: wsMode,
      exchangeType: wsExchangeType,
      tokens: [symbolToken],
    });

    console.log('Websocket subscribed. Press Ctrl+C to stop.');
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch((error) => {
  console.error('Failed to fetch NIFTY50 data');
  console.error(error?.response?.data || error.message || error);
  process.exit(1);
});