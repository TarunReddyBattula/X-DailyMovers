require('dotenv').config();
const ccxt = require('ccxt');
const { EMA, RSI, BollingerBands, PSAR, VWAP } = require('technicalindicators');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const http = require('http');
const { TwitterApi } = require('twitter-api-v2'); // NEW: Import Twitter Library

const port = process.env.PORT || 8080;
const STORAGE_FILE = './master_picks.json';

// Tiny server to keep the service alive
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!\n');
}).listen(port, () => {
  console.log(`[Keep-Alive] Server listening on port ${port}`);
});

// NEW: Initialize Twitter Client with User Context (OAuth 1.0a)
const twitterClient = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
});

// Updated to Kraken as per your latest preference
const binance = new ccxt.kraken({ 'enableRateLimit': true });

// NEW: Helper function to prevent API rate limit bans
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// API Keys from .env
const LUNAR_API_KEY = process.env.LUNARCRUSH_KEY;
const WHALE_API_KEY = process.env.WHALE_ALERT_KEY;

/**
 * CORE SCORING ENGINE
 * Combines 17 technical/psychological strategies + Social + On-chain
 */
async function getUnifiedPicks() {
    console.log(`[${new Date().toLocaleTimeString()}] Initializing 32-Point Master Scan...`);

    // Add this temporary check after initializing the twitterClient
    const verifyUser = async () => {
        try {
            const user = await twitterClient.v2.me();
            console.log("✅ Authenticated as:", user.data.username);
        } catch (e) {
            console.error("❌ Auth Check Failed:", e.data ? e.data.detail : e.message);
        }
    };
    verifyUser();
    try {
        // --- 1. GLOBAL DATA FETCHING (Outside the loop for efficiency) ---

        // NEW: Fetch Comprehensive Stablecoin List from DefiLlama
        console.log("[Setup] Fetching master stablecoin list from DefiLlama...");
        let stablecoinBlacklist = new Set(['usdt', 'usdc', 'dai', 'busd', 'fdusd', 'pyusd', 'usdg', 'rlusd']);
        // Fallback defaults
        try {
            const llamaRes = await axios.get('https://stablecoins.llama.fi/stablecoins');
            const llamaSymbols = llamaRes.data.peggedAssets.map(s => s.symbol.toLowerCase());
            llamaSymbols.forEach(s => stablecoinBlacklist.add(s));
            console.log("[Setup] Blacklisted Assets:", Array.from(stablecoinBlacklist).join(', '));
            console.log(`[Setup] Blacklisted ${stablecoinBlacklist.size} total stablecoins.`);
        } catch (e) {
            console.log("[Error] DefiLlama unavailable, using fallback list.");
        }
        
        // NEW: Fetch Top 500 from CoinGecko (2 pages of 250)
        console.log("[Gecko] Fetching Top 500 Market Cap assets...");
        let top500BaseSymbols = [];
        try {
            for (let page = 1; page <= 4; page++) {
                const geckoRes = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
                    params: {
                        vs_currency: 'usd',
                        order: 'market_cap_desc',
                        per_page: 250,
                        page: page,
                        sparkline: false
                    }
                });
                // Extract base symbols (e.g., "BTC", "ETH")
                const filtered = geckoRes.data
                    .filter(coin => !stablecoinBlacklist.has(coin.symbol.toLowerCase()))
                    .map(coin => coin.symbol.toUpperCase());
                top500BaseSymbols.push(...filtered);
            }
        } catch (e) {
            console.log("CoinGecko API error, falling back to original logic.");
        }

        // Strategy 17: Inverse Sentiment (Fear & Greed)
        const fngRes = await axios.get('https://api.alternative.me/fng/');
        const fearIndex = parseInt(fngRes.data.data[0].value);

        // Strategy 13: Social Sentiment (LunarCrush)
        let socialData = {};
        try {
            const lunarRes = await axios.get(`https://lunarcrush.com/api4/public/coins/list/v1`, {
                headers: { 'Authorization': `Bearer ${LUNAR_API_KEY}` }
            });
            lunarRes.data.data.forEach(coin => socialData[coin.symbol] = coin);
        } catch (e) { console.log("LunarCrush API unavailable, using volume proxy."); }

        // Strategy 15: Whale Inflow (Whale Alert)
        let whaleFlows = [];
        try {
            const whaleRes = await axios.get(`https://api.whale-alert.io/v1/transactions?min_value=500000&api_key=${WHALE_API_KEY}`);
            whaleFlows = whaleRes.data.transactions;
        } catch (e) { console.log("Whale Alert API unavailable."); }

        const tickers = await binance.fetchTickers();
        // NEW: Dynamic Pair Discovery Logic
        // This checks for BASE/USDT, then BASE/USD, then Kraken's unique X/Z naming
        let symbols = top500BaseSymbols.map(base => {
            const options = [`${base}/USDT`, `${base}/USD`, `X${base}/ZUSD`, `${base}/XBT`];
            return options.find(pair => tickers[pair]);
        }).filter(s => s != null);
        console.log(`[Process] Starting scan of ${symbols.length} assets...`);

        let finalCandidates = [];
        let scanCount = 0;
        for (const symbol of symbols) {
            scanCount++;
            // NEW: Respect Rate Limits (Kraken is sensitive)
            await sleep(200);
            try {
                // FETCH DATA
                const ohlcv = await binance.fetchOHLCV(symbol, '1h', undefined, 100);
                const dailyOhlcv = await binance.fetchOHLCV(symbol, '1d', undefined, 30);
                
                const closes = ohlcv.map(d => d[4]);
                const highs = ohlcv.map(d => d[2]);
                const lows = ohlcv.map(d => d[3]);
                const volumes = ohlcv.map(d => d[5]);
                const coinSymbol = symbol.split('/')[0];
                const currentPrice = tickers[symbol].last;
                let score = 0;
                let triggers = [];

                // --- I. TECHNICAL & PATTERN (The Chartists) ---
                // 1. Rounding Bottom
                const mid = Math.min(...dailyOhlcv.slice(10, 20).map(d => d[4]));
                if (mid < dailyOhlcv[0][4] && dailyOhlcv[29][4] > mid) { score += 5; triggers.push("Rounding Bottom"); }
                
                // 2. Ascending Triangle
                if (lows[99] > lows[98] && lows[98] > lows[97]) { score += 4;
                triggers.push("Higher Lows (Triangle)"); }

                // 4. PSAR Flip
                const psar = PSAR.calculate({ step: 0.02, max: 0.2, high: highs, low: lows });
                if (psar[psar.length - 1] < closes[99] && psar[psar.length - 2] > closes[98]) { score += 6; triggers.push("PSAR Flip"); }

                // --- II. MOMENTUM & SPEED ---
                // 5. 10/20 EMA Cross
                const ema10 = EMA.calculate({ period: 10, values: closes });
                const ema20 = EMA.calculate({ period: 20, values: closes });
                if (ema10[ema10.length-1] > ema20[ema20.length-1]) { score += 3; triggers.push("EMA Cross"); }

                // 6. Bollinger Squeeze
                const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
                const lastBB = bb[bb.length-1];
                if ((lastBB.upper - lastBB.lower) / lastBB.middle < 0.03) { score += 7; triggers.push("Volatility Squeeze"); }

                // 8. The Gapper
                const dayOpen = dailyOhlcv[dailyOhlcv.length-1][1];
                if ((closes[99] - dayOpen) / dayOpen >= 0.03) { score += 4; triggers.push("Gapper Continuation"); }

                // --- III. QUANT & MATH ---
                // 9. Mean Reversion
                const mean = closes.reduce((a,b) => a+b)/closes.length;
                if (closes[99] < mean * 0.88) { score += 8; triggers.push("Mean Reversion (Oversold)"); }

                // 11. VWAP Bounce
                const vwap = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes });
                if (closes[99] > vwap[vwap.length-1] && lows[99] <= vwap[vwap.length-1]) { score += 4; triggers.push("VWAP Bounce"); }

                // --- IV. BEHAVIORAL & ON-CHAIN (Whale/Social) ---
                // 12. Unit Bias
                if (currentPrice < 0.01) { score += 2; triggers.push("Unit Bias"); }

                // 13. LunarCrush Galaxy Score
                if (socialData[coinSymbol] && socialData[coinSymbol].galaxy_score > 70) {
                    score += 10;
                    triggers.push(`Social: Galaxy Score ${socialData[coinSymbol].galaxy_score}`);
                }

                // 15. Whale Alert Inflow
                const symbolWhaleMoves = whaleFlows.filter(t => t.symbol.toUpperCase() === coinSymbol);
                if (symbolWhaleMoves.some(t => t.to.owner_type === 'exchange')) {
                    score += 6;
                    triggers.push("Whale Activity Detected");
                }

                // --- V. PSYCHOLOGY ---
                // 16. Max Pain / Funding
                try {
                    const funding = await binance.fetchFundingRate(symbol);
                    if (funding.fundingRate < -0.01) { score += 8; triggers.push("Short Squeeze potential"); }
                } catch(e){}

                // 17. Inverse Sentiment
                if (fearIndex < 25) { score += 5; triggers.push("Market Extreme Fear"); }

                // NEW: Updated logging to prevent line disappearing and show full details
                console.log(`Scanning: [${scanCount}/${symbols.length}] | Symbol: ${symbol} | Score: ${score} | Price: ${currentPrice.toFixed(4)} | Triggers: [${triggers.join(", ")}]`);
                finalCandidates.push({ symbol, score, triggers, priceAt5am: currentPrice });
            } catch (e) { continue; }
        }

        const top5 = finalCandidates.sort((a, b) => b.score - a.score).slice(0, 5);
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(top5));
        
        console.log("\n--- UNIFIED MORNING TOP 5 ---");
        console.table(top5.map(p => ({ 
            Symbol: p.symbol, 
            Score: p.score, 
            Primary_Catalyst: p.triggers[0],
            Secondary: p.triggers[1] || "None"
        })));

        // Wait 2 seconds before posting to avoid rate limits
        await sleep(2000);
        // Post top suggestions to X
        await postSuggestionsToTwitter(top5);

    } catch (err) {
        console.error("Critical error during scan:", err);
    }
}

/**
 * NEW: Post Nightly Top 5 Suggestions to X
 */
async function postSuggestionsToTwitter(picks) {
    try {
        const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
        let tweetText = `Nightly Crypto Scan (${timestamp})\n\n`;
        tweetText += "Top 5 High-Score Signals:\n";
        picks.forEach((p, i) => {
            tweetText += `${i + 1}. ${p.symbol.split('/')[0]} Score: ${p.score} - ${p.triggers[0]}\n`;
        });
        
        console.log("📝 Posting Nightly Suggestions to X...");
        console.log("Tweet content length:", tweetText.length);
        console.log("Tweet preview:", tweetText.substring(0, 100));
        
        await twitterClient.v2.tweet(tweetText);
        console.log("✅ Nightly suggestions posted successfully!");
    } catch (error) {
        console.error("❌ Failed to post nightly suggestions:", error.data?.detail || error.message);
        console.error("Full error data:", error.data);
    }
}

/**
 * EOD PERFORMANCE TRACKER
 */
async function reportPerformance() {
    console.log("\n--- END OF DAY PERFORMANCE REPORT ---");
    if (!fs.existsSync(STORAGE_FILE)) return;
    
    try {
        const picks = JSON.parse(fs.readFileSync(STORAGE_FILE));
        let tweetText = `📊 Daily Comparison Report 📊\n\n`;

        for (const pick of picks) {
            try {
                const now = await binance.fetchTicker(pick.symbol);
                const change = ((now.last - pick.priceAt5am) / pick.priceAt5am) * 100;
                const icon = change >= 0 ? '✅' : '🔻';
                
                console.log(`${pick.symbol}: Started @ ${pick.priceAt5am.toFixed(4)} -> Now @ ${now.last.toFixed(4)} | Change: ${change.toFixed(2)}% ${change >= 10 ? '✅ 10% TARGET MET' : ''}`);
                tweetText += `${icon} #${pick.symbol.split('/')[0]}: ${change > 0 ? '+' : ''}${change.toFixed(2)}%\n`;
            } catch (e) { console.log(`Error tracking ${pick.symbol}`); }
        }

        tweetText += "\n#PerformanceReview #CryptoResults";
        
        console.log("📝 Posting Comparison Report to X...");
        await twitterClient.v2.tweet(tweetText);
        console.log("✅ Comparison report posted successfully!");
    } catch (error) {
        console.error("❌ Failed to report performance to X:", error);
    }
}

// Schedules: 00:00 AM Scan | 00:15 PM Report
cron.schedule('0 1 * * *', getUnifiedPicks);
cron.schedule('15 1 * * *', reportPerformance);

// Initial start
getUnifiedPicks();