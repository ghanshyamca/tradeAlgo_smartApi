/**
 * SmartAPI WebSocket - Live Nifty 50 Index Data
 * Uses WebSocket to get real-time data for Nifty 50 index
 *
 * Usage: node src/nifty50LiveData.js
 */

const { SmartAPI, WebSocketV2 } = require('smartapi-javascript');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Nifty 50 Index Token
const NIFTY50_INDEX = {
    symbol: "NIFTY 50",
    token: "99926000",
    exchange: "NSE"
};

class Nifty50LiveDataFetcher {
    constructor() {
        this.ws = null;
        this.csvFilePath = path.join(__dirname, '..', 'nifty50_live_data.csv');
        this.isRunning = false;
    }

    async initialize() {
        console.log('Initializing SmartAPI...');

        const smartAPI = new SmartAPI({
            api_key: process.env.SMARTAPI_API_KEY
        });

        // Try refresh token first - remove quotes if present
        const refreshToken = process.env.SMARTAPI_REFRESH_TOKEN?.replace(/^"|"$/g, '');

        if (refreshToken) {
            console.log('Generating new access token from refresh token...');
            try {
                const tokenResponse = await smartAPI.generateToken(refreshToken);

                if (tokenResponse && tokenResponse.status && tokenResponse.data && tokenResponse.data.jwtToken) {
                    this.jwtToken = tokenResponse.data.jwtToken;
                    this.feedToken = tokenResponse.data.feedToken;
                    console.log('Token generated successfully');
                } else {
                    console.log('Refresh token expired, using stored tokens...');
                    this.useStoredTokens();
                }
            } catch (error) {
                console.log('Error generating token, using stored tokens:', error.message);
                this.useStoredTokens();
            }
        } else {
            this.useStoredTokens();
        }

        console.log('Initializing WebSocket...');
        this.ws = new WebSocketV2({
            clientcode: process.env.SMARTAPI_CLIENT_CODE,
            jwttoken: this.jwtToken,
            apikey: process.env.SMARTAPI_API_KEY,
            feedtype: this.feedToken
        });
    }

    useStoredTokens() {
        // Remove quotes if present in .env file values
        this.jwtToken = process.env.SMARTAPI_ACCESS_TOKEN?.replace(/^"|"$/g, '');
        this.feedToken = process.env.SMARTAPI_FEED_TOKEN?.replace(/^"|"$/g, '');

        console.log('JWT Token:', this.jwtToken ? 'Present (' + this.jwtToken.length + ' chars)' : 'MISSING');
        console.log('Feed Token:', this.feedToken ? 'Present (' + this.feedToken.length + ' chars)' : 'MISSING');

        if (!this.jwtToken || !this.feedToken) {
            throw new Error('No tokens available. Please run: node src/login.js <totp>');
        }
    }

    startWebSocket() {
        return new Promise((resolve, reject) => {
            // Set up tick handler
            this.ws.connect().then(() => {
                console.log('WebSocket connected!');

                // Subscribe to Nifty 50 index
                const subscribeData = {
                    correlationID: "nifty50_live",
                    action: 1, // Subscribe
                    mode: 2,   // Quote - full quote data
                    exchangeType: 1, // NSE Cash Market
                    tokens: [NIFTY50_INDEX.token]
                };

                this.ws.fetchData(subscribeData);
                console.log(`Subscribed to ${NIFTY50_INDEX.symbol} (Token: ${NIFTY50_INDEX.token})`);

                this.isRunning = true;
                resolve();

            }).catch(error => {
                console.error('WebSocket connection error:', error.message);
                reject(error);
            });

            // Handle incoming data
            this.ws.on('tick', (data) => {
                console.log('Received tick data:', JSON.stringify(data)); // Debug log
                this.processTick(data);
            });
        });
    }

    // Convert paise to rupees
    toRupees(paise) {
        return (parseFloat(paise) / 100).toFixed(2);
    }

    processTick(data) {
        console.log('Processing tick data:', JSON.stringify(data)); // Debug log
        if (!data) return;

        // Extract token - handle both formats
        let token = data.token;
        if (token) {
            token = token.replace(/"/g, ''); // Remove quotes if any
        }

        // Check if it's Nifty 50 index
        if (token === NIFTY50_INDEX.token) {
            const timestamp = new Date().toISOString();

            // Parse the WebSocket data format
            const marketData = {
                symbol: NIFTY50_INDEX.symbol,
                token: token,
                ltp: this.toRupees(data.last_traded_price || 0),
                open: this.toRupees(data.open_price_day || 0),
                high: this.toRupees(data.high_price_day || 0),
                low: this.toRupees(data.low_price_day || 0),
                close: this.toRupees(data.close_price || 0),
                volume: data.vol_traded || 0,
                avgTradedPrice: this.toRupees(data.avg_traded_price || 0),
                totalBuyQty: data.total_buy_quantity || 0,
                totalSellQty: data.total_sell_quantity || 0,
                timestamp: timestamp
            };

            // Calculate change
            const close = parseFloat(marketData.close);
            const ltp = parseFloat(marketData.ltp);
            const netChange = (ltp - close).toFixed(2);
            const percentChange = close > 0 ? ((netChange / close) * 100).toFixed(2) : 0;

            marketData.netChange = netChange;
            marketData.percentChange = percentChange;

            // Display live data
            console.log(`\n[${timestamp}]`);
            console.log(`  ${marketData.symbol}: ${marketData.ltp}`);
            console.log(`  Open: ${marketData.open}, High: ${marketData.high}, Low: ${marketData.low}, Close: ${marketData.close}`);
            console.log(`  Change: ${netChange} (${percentChange}%)`);
            console.log(`  Volume: ${marketData.volume}`);

            // Write to CSV (overwrite each time for latest data)
            this.writeToCSV(marketData);
        }
    }

    writeToCSV(data) {
        const headers = ['Symbol', 'Token', 'LTP', 'Open', 'High', 'Low', 'Close', 'Volume', 'AvgPrice', 'NetChange', 'PercentChange', 'Timestamp'];

        const values = [
            data.symbol,
            data.token,
            data.ltp,
            data.open,
            data.high,
            data.low,
            data.close,
            data.volume,
            data.avgTradedPrice,
            data.netChange,
            data.percentChange,
            data.timestamp
        ];

        const csvRow = values.join(',');

        // Check if file exists to decide whether to write header
        let fileExists = false;
        try {
            fileExists = fs.existsSync(this.csvFilePath);
        } catch (e) {
            fileExists = false;
        }

        if (fileExists) {
            // Append data row only
            fs.appendFileSync(this.csvFilePath, csvRow + '\n', 'utf8');
        } else {
            // Write header + data row
            const csvContent = headers.join(',') + '\n' + csvRow + '\n';
            fs.writeFileSync(this.csvFilePath, csvContent, 'utf8');
        }
    }

    async run(durationSeconds = 60) {
        try {
            // Initialize API
            await this.initialize();

            // Start WebSocket
            await this.startWebSocket();

            console.log(`\n=== Streaming Live Nifty 50 Data ===`);
            console.log(`Press Ctrl+C to stop\n`);

            // Keep running for specified duration or until interrupted
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.log('\nDuration completed. Closing connection...');
                    this.stop();
                    resolve();
                }, durationSeconds * 1000);

                process.on('SIGINT', () => {
                    clearTimeout(timeout);
                    console.log('\nInterrupted. Closing connection...');
                    this.stop();
                    resolve();
                });
            });

            return { success: true };

        } catch (error) {
            console.error('Error running fetcher:', error);
            return { success: false, error: error.message };
        }
    }

    stop() {
        this.isRunning = false;
        if (this.ws) {
            try {
                // Unsubscribe
                const unsubscribeData = {
                    correlationID: "nifty50_live",
                    action: 0, // Unsubscribe
                    mode: 2,
                    exchangeType: 1,
                    tokens: [NIFTY50_INDEX.token]
                };
                this.ws.fetchData(unsubscribeData);
                console.log('Unsubscribed from Nifty 50');
            } catch (e) {
                // Ignore errors during cleanup
            }
        }
        process.exit(0);
    }
}

// Run if executed directly
if (require.main === module) {
    // Get duration from command line argument (default 60 seconds)
    const duration = process.argv[2] ? parseInt(process.argv[2]) : 60;

    console.log(`Starting for ${duration} seconds...`);

    const fetcher = new Nifty50LiveDataFetcher();
    fetcher.run(duration).then(result => {
        console.log('\nResult:', result.success ? 'Success!' : 'Failed!');
        process.exit(result.success ? 0 : 1);
    }).catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = Nifty50LiveDataFetcher;