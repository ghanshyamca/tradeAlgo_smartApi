/**
 * SmartAPI Authentication Script
 * Generates new access and refresh tokens
 * Run this first before using other scripts
 *
 * Usage: node src/login.js <totp>
 * Example: node src/login.js 123456
 */

const { SmartAPI } = require('smartapi-javascript');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function login(totp) {
    console.log('=== SmartAPI Login ===\n');

    const apiKey = process.env.SMARTAPI_API_KEY;
    const clientCode = process.env.SMARTAPI_CLIENT_CODE;
    const password = process.env.SMARTAPI_PASSWORD;

    if (!apiKey || !clientCode || !password) {
        console.error('Missing credentials in .env file');
        console.log('Required: SMARTAPI_API_KEY, SMARTAPI_CLIENT_CODE, SMARTAPI_PASSWORD');
        console.log('\nUsage: node src/login.js <totp>');
        console.log('Example: node src/login.js 123456');
        process.exit(1);
    }

    if (!totp) {
        console.error('TOTP is required');
        console.log('\nUsage: node src/login.js <totp>');
        console.log('Example: node src/login.js 123456');
        process.exit(1);
    }

    console.log(`Logging in with client code: ${clientCode}`);

    const smartAPI = new SmartAPI({
        api_key: apiKey
    });

    try {
        // Generate session with credentials
        const session = await smartAPI.generateSession(clientCode, password, totp);

        console.log('\nLogin successful!');

        console.log('Session response:', JSON.stringify(session, null, 2));

        if (session && session.data) {
            const jwtToken = session.data.jwtToken;
            const refreshToken = session.data.refreshToken;
            const feedToken = session.data.feedToken;

            console.log('\n=== New Tokens Generated ===');
            console.log('\nUpdate your .env file with these values:\n');

            console.log(`SMARTAPI_ACCESS_TOKEN="${jwtToken}"`);
            console.log(`SMARTAPI_REFRESH_TOKEN="${refreshToken}"`);
            console.log(`SMARTAPI_FEED_TOKEN="${feedToken}"`);

            // Also update the .env file directly
            const envPath = path.join(__dirname, '..', '.env');
            let envContent = fs.readFileSync(envPath, 'utf8');

            // Update access token
            envContent = envContent.replace(
                /SMARTAPI_ACCESS_TOKEN=.*/,
                `SMARTAPI_ACCESS_TOKEN="${jwtToken}"`
            );

            // Update refresh token
            envContent = envContent.replace(
                /SMARTAPI_REFRESH_TOKEN=.*/,
                `SMARTAPI_REFRESH_TOKEN="${refreshToken}"`
            );

            // Update feed token
            envContent = envContent.replace(
                /SMARTAPI_FEED_TOKEN=.*/,
                `SMARTAPI_FEED_TOKEN="${feedToken}"`
            );

            fs.writeFileSync(envPath, envContent, 'utf8');

            console.log('\n✓ .env file updated with new tokens!');
        }

        return session;

    } catch (error) {
        console.error('\nLogin failed:', error.message);
        if (error.response) {
            console.error('Error details:', JSON.stringify(error.response.data));
        }
        process.exit(1);
    }
}

if (require.main === module) {
    const totp = process.argv[2];
    login(totp).then(() => {
        console.log('\nYou can now run the data fetcher script.');
        process.exit(0);
    }).catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { login };