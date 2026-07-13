/**
 * SmartAPI Live Nifty 50 Data Fetcher
 * Fetches live market data for all Nifty 50 stocks and writes to CSV
 */

const { SmartAPI } = require('smartapi-javascript');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Nifty 50 Stock Tokens (Angel One Token Format)
// Format: { symbol: "SYMBOL", token: "TOKEN" }
const NIFTY50_TOKENS = [
    { symbol: "NIFTY 50", token: "99926000" },
    // { symbol: "TCS", token: "11536" },
    // { symbol: "HDFCBANK", token: "1333" },
    // { symbol: "ICICIBANK", token: "1193" },
    // { symbol: "INFY", token: "1594" },
    // { symbol: "HINDUNILVR", token: "1394" },
    // { symbol: "ITC", token: "1665" },
    // { symbol: "SBIN", token: "3045" },
    // { symbol: "BHARTIARTL", token: "10673" },
    // { symbol: "KOTAKBANK", token: "1922" },
    // { symbol: "LTIM", token: "10946" },
    // { symbol: "AXISBANK", token: "9198" },
    // { symbol: "MARUTI", token: "10999" },
    // { symbol: "BAJFINANCE", token: "811" },
    // { symbol: "TITAN", token: "8778" },
    // { symbol: "SUNPHARMA", token: "5249" },
    // { symbol: "WIPRO", token: "3787" },
    // { symbol: "NTPC", token: "11630" },
    // { symbol: "TATASTEEL", token: "3034" },
    // { symbol: "M&M", token: "6047" },
    // { symbol: "ADANIPORTS", token: "15033" },
    // { symbol: "ULTRACEMCO", token: "13096" },
    // { symbol: "NESTLEIND", token: "2393" },
    // { symbol: "POWERGRID", token: "11778" },
    // { symbol: "COALINDIA", token: "14178" },
    // { symbol: "JSWSTEEL", token: "3010" },
    // { symbol: "ADANIENT", token: "14876" },
    // { symbol: "TATACONSUM", token: "11070" },
    // { symbol: "BAJAJFINSV", token: "10170" },
    // { symbol: "HCLTECH", token: "1854" },
    // { symbol: "DIVISLAB", token: "10984" },
    // { symbol: "APOLLOPHARM", token: "10082" },
    // { symbol: "TATAMOTORS", token: "2879" },
    // { symbol: "ONGC", token: "2475" },
    // { symbol: "SBILIFE", token: "10192" },
    // { symbol: "HEROMOTOCO", token: "1589" },
    // { symbol: "BPCL", token: "1348" },
    // { symbol: "DRREDDY", token: "1852" },
    // { symbol: "CIPLA", token: "1402" },
    // { symbol: "EICHERMOT", token: "1770" },
    // { symbol: "UPL", token: "11237" },
    // { symbol: "GRASIM", token: "2515" },
    // { symbol: "SHREYCEM", token: "3103" },
    // { symbol: "INDUSINDBK", token: "1823" },
    // { symbol: "VEDL", token: "3033" },
    // { symbol: "HDFCLIFE", token: "10384" },
    // { symbol: "SIEMENS", token: "1205" },
    // { symbol: "ASIANPAINT", token: "1110" },
    // { symbol: "ACC", token: "22" },
    // { symbol: "PIDILITIND", token: "10604" },
    // { symbol: "BERGER PAINT", token: "10909" },
    // { symbol: "DLF", token: "1452" },
    // { symbol: "GAIL", token: "1843" },
    // { symbol: "IOC", token: "1409" }
];

class Nifty50LiveDataFetcher {
    constructor() {
        this.smartAPI = null;
        this.csvFilePath = path.join(__dirname, '..', 'nifty50_live_data.csv');
    }

    async initialize() {
        console.log('Initializing SmartAPI...');

        this.smartAPI = new SmartAPI({
            api_key: process.env.SMARTAPI_API_KEY
        });

        // Use refresh token to get a fresh access token
        const refreshToken = process.env.SMARTAPI_REFRESH_TOKEN;

        if (refreshToken) {
            console.log('Generating new access token from refresh token...');
            try {
                const tokenResponse = await this.smartAPI.generateToken(refreshToken);

                // Workaround: The library sets token in .then() which happens after resolve
                // Manually set the access token from response
                if (tokenResponse && tokenResponse.data && tokenResponse.data.jwtToken) {
                    this.smartAPI.setAccessToken(tokenResponse.data.jwtToken);
                    console.log('New token generated and set successfully');
                } else {
                    console.log('Token response:', JSON.stringify(tokenResponse));
                    throw new Error('Failed to get new token');
                }

                return tokenResponse;
            } catch (error) {
                console.error('Error generating token:', error.message);
                throw error;
            }
        } else {
            throw new Error('No refresh token available. Please authenticate first.');
        }
    }

    async fetchMarketData(exchange, tokens) {
        try {
            const params = {
                mode: "FULL",
                exchangeTokens: {
                    [exchange]: tokens
                }
            };
            const response = await this.smartAPI.marketData(params);
            return response;
        } catch (error) {
            console.error('Error fetching market data:', error.message);
            return null;
        }
    }

    async fetchAllNifty50Data() {
        const exchange = "NSE";
        const tokens = NIFTY50_TOKENS.map(s => s.token);

        console.log(`Fetching live data for ${NIFTY50_TOKENS.length} Nifty 50 stocks...`);

        try {
            const response = await this.fetchMarketData(exchange, tokens);

            if (response && response.status && response.data && response.data.fetched) {
                const results = [];
                const fetchedData = response.data.fetched;

                for (const stock of NIFTY50_TOKENS) {
                    const marketData = fetchedData.find(d => d.symbolToken === stock.token);

                    if (marketData) {
                        results.push({
                            symbol: stock.symbol,
                            token: stock.token,
                            ltp: marketData.ltp || 0,
                            open: marketData.open || 0,
                            high: marketData.high || 0,
                            low: marketData.low || 0,
                            close: marketData.close || 0,
                            volume: marketData.lastTradeQty || 0,
                            netChange: marketData.netChange || 0,
                            percentChange: marketData.percentChange || 0,
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        results.push({
                            symbol: stock.symbol,
                            token: stock.token,
                            ltp: 0,
                            open: 0,
                            high: 0,
                            low: 0,
                            close: 0,
                            volume: 0,
                            timestamp: new Date().toISOString(),
                            error: 'No data'
                        });
                    }
                }

                return results;
            } else {
                console.error('Failed to fetch market data:', response);
                return NIFTY50_TOKENS.map(s => ({
                    symbol: s.symbol,
                    token: s.token,
                    error: 'API Error',
                    timestamp: new Date().toISOString()
                }));
            }
        } catch (error) {
            console.error('Error fetching all Nifty 50 data:', error.message);
            return NIFTY50_TOKENS.map(s => ({
                symbol: s.symbol,
                token: s.token,
                error: error.message,
                timestamp: new Date().toISOString()
            }));
        }
    }

    writeToCSV(data) {
        const headers = ['Symbol', 'Token', 'LTP', 'Open', 'High', 'Low', 'Close', 'Volume', 'NetChange', 'PercentChange', 'Timestamp'];
        const csvRows = [];

        // Add header
        csvRows.push(headers.join(','));

        // Add data rows
        for (const row of data) {
            const values = [
                row.symbol,
                row.token,
                row.ltp || 0,
                row.open || 0,
                row.high || 0,
                row.low || 0,
                row.close || 0,
                row.volume || 0,
                row.netChange || 0,
                row.percentChange || 0,
                row.timestamp
            ];
            csvRows.push(values.join(','));
        }

        const csvContent = csvRows.join('\n');
        fs.writeFileSync(this.csvFilePath, csvContent, 'utf8');

        console.log(`Data written to: ${this.csvFilePath}`);
        return this.csvFilePath;
    }

    async run() {
        try {
            // Initialize API
            await this.initialize();

            // Fetch all data
            const data = await this.fetchAllNifty50Data();

            // Write to CSV
            const csvPath = this.writeToCSV(data);

            // Print summary
            console.log('\n=== Summary ===');
            console.log(`Total stocks: ${data.length}`);
            console.log(`Successful: ${data.filter(d => d.ltp > 0).length}`);
            console.log(`Failed: ${data.filter(d => d.error).length}`);

            return { success: true, data, csvPath };

        } catch (error) {
            console.error('Error running fetcher:', error);
            return { success: false, error: error.message };
        }
    }
}

// Run if executed directly
if (require.main === module) {
    const fetcher = new Nifty50LiveDataFetcher();
    fetcher.run().then(result => {
        console.log('\nResult:', result.success ? 'Success!' : 'Failed!');
        process.exit(result.success ? 0 : 1);
    }).catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = Nifty50LiveDataFetcher;