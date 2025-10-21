/**
 * Jest Setup File
 * Loads environment variables from .env file before running tests
 */

import { config } from 'dotenv';

// Load .env file
config();

console.log('Jest Setup: Loading environment variables');
console.log(`  PROXY_URL: ${process.env.PROXY_URL || '(not set)'}`);
console.log(`  API_KEY: ${process.env.API_KEY ? '***' + process.env.API_KEY.slice(-8) : '(not set)'}`);
