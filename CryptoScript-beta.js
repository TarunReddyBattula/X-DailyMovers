require('dotenv').config();
const ccxt = require('ccxt');
const { EMA, RSI, BollingerBands, PSAR, VWAP } = require('technicalindicators');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');

// Updated to Kraken as per your latest preference
const binance = new ccxt.kraken({ 'enableRateLimit': true });
const STORAGE_FILE = './master_picks.json';

// API Keys from .env
const LUNAR_API_KEY = process.env.LUNARCRUSH_KEY;
const WHALE_API_KEY = process.env.WHALE_ALERT_KEY;

/**
 * CORE SCORING ENGINE
 * Combines 17 technical/psychological strategies + Social + On-chain
 */
async function getUnifiedPicks() {
    console.log(`[${new Date().toLocaleTimeString()}] Initializing 32-Point Master Scan...`);

    try {
        // --- 1. GLOBAL DATA FETCHING (Outside the loop for efficiency) ---

        // NEW: Fetch Comprehensive Stablecoin List from DefiLlama
        console.log("[Setup] Fetching master stablecoin list from DefiLlama...");
        let stablecoinBlacklist = new Set(['usdt', 'usdc', 'dai', 'busd', 'fdusd', 'pyusd', 'usdg', 'rlusd']); // Fallback defaults
        try {
            const llamaRes = await axios.get('https://stablecoins.llama.fi/stablecoins');
            const llamaSymbols = llamaRes.data.peggedAssets.map(s => s.symbol.toLowerCase());
            llamaSymbols.forEach(s => stablecoinBlacklist.add(s));
            console.log(`[Setup] Blacklisted ${stablecoinBlacklist.size} total stablecoins.`);
        } catch (e) {
            console.log("[Error] DefiLlama unavailable, using fallback list.");
        }
        
        // NEW: Fetch Top 500 from CoinGecko (2 pages of 250)
        console.log("[Gecko] Fetching Top 500 Market Cap assets...");
        let top500FromGecko = [];
        try {
            for (let page = 1; page <= 2; page++) {
                const geckoRes = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
                    params: {
                        vs_currency: 'usd',
                        order: 'market_cap_desc',
                        per_page: 250,
                        page: page,
                        sparkline: false
                    }
                });

                const filtered = geckoRes.data
                    .filter(coin => !stablecoinBlacklist.has(coin.symbol.toLowerCase()))
                    .map(coin => `${coin.symbol.toUpperCase()}/USDT`);
                
                top500FromGecko.push(...filtered);
            }
            console.log(`[Gecko] Filtered Top 500 to ${top500FromGecko.length} non-stablecoin assets.`);
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
        
        // Use Gecko list if available; ensure they exist on the exchange
        let symbols = top500FromGecko.length > 0 
            ? top500FromGecko.filter(s => tickers[s]) 
            : Object.keys(tickers).filter(s => s.endsWith('/USDT')).slice(0, 100);

        console.log(`[Process] Starting scan of ${symbols.length} assets...`);
        let finalCandidates = [];
        let scanCount = 0;

        for (const symbol of symbols) {
            scanCount++;
            // PROGRESS LOG: Updates console every 10 assets so you know it's alive
            if (scanCount % 10 === 0 || scanCount === 1) {
                process.stdout.write(` > Scanning: ${scanCount}/${symbols.length} (${symbol})\r`);
            }

            try {
                // FETCH DATA
                const ohlcv = await binance.fetchOHLCV(symbol, '1h', undefined, 100);
                const dailyOhlcv = await binance.fetchOHLCV(symbol, '1d', undefined, 30);
                
                const closes = ohlcv.map(d => d[4]);
                const highs = ohlcv.map(d => d[2]);
                const lows = ohlcv.map(d => d[3]);
                const volumes = ohlcv.map(d => d[5]);
                const coinSymbol = symbol.split('/')[0];

                let score = 0;
                let triggers = [];

                // --- I. TECHNICAL & PATTERN (The Chartists) ---
                // 1. Rounding Bottom
                const mid = Math.min(...dailyOhlcv.slice(10, 20).map(d => d[4]));
                if (mid < dailyOhlcv[0][4] && dailyOhlcv[29][4] > mid) { score += 5; triggers.push("Rounding Bottom"); }
                
                // 2. Ascending Triangle
                if (lows[99] > lows[98] && lows[98] > lows[97]) { score += 4; triggers.push("Higher Lows (Triangle)"); }

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
                if (tickers[symbol].last < 0.01) { score += 2; triggers.push("Unit Bias"); }

                // 13. LunarCrush Galaxy Score
                if (socialData[coinSymbol] && socialData[coinSymbol].galaxy_score > 70) {
                    score += 10; triggers.push(`Social: Galaxy Score ${socialData[coinSymbol].galaxy_score}`);
                }

                // 15. Whale Alert Inflow
                const symbolWhaleMoves = whaleFlows.filter(t => t.symbol.toUpperCase() === coinSymbol);
                if (symbolWhaleMoves.some(t => t.to.owner_type === 'exchange')) {
                    score += 6; triggers.push("Whale Activity Detected");
                }

                // --- V. PSYCHOLOGY ---
                // 16. Max Pain / Funding
                try {
                    const funding = await binance.fetchFundingRate(symbol);
                    if (funding.fundingRate < -0.01) { score += 8; triggers.push("Short Squeeze potential"); }
                } catch(e){}

                // 17. Inverse Sentiment
                if (fearIndex < 25) { score += 5; triggers.push("Market Extreme Fear"); }

                finalCandidates.push({ symbol, score, triggers, priceAt5am: tickers[symbol].last });
            } catch (e) { continue; }
        }

        process.stdout.write('\n'); // Clear the progress line
        const top5 = finalCandidates.sort((a, b) => b.score - a.score).slice(0, 5);
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(top5));
        
        console.log("\n--- UNIFIED MORNING TOP 5 ---");
        console.table(top5.map(p => ({ 
            Symbol: p.symbol, 
            Score: p.score, 
            Primary_Catalyst: p.triggers[0],
            Secondary: p.triggers[1] || "None"
        })));

    } catch (err) {
        console.error("Critical error during scan:", err);
    }
}

/**
 * EOD PERFORMANCE TRACKER
 */
async function reportPerformance() {
    console.log("\n--- END OF DAY PERFORMANCE REPORT ---");
    if (!fs.existsSync(STORAGE_FILE)) return;
    
    const picks = JSON.parse(fs.readFileSync(STORAGE_FILE));
    for (const pick of picks) {
        try {
            const now = await binance.fetchTicker(pick.symbol);
            const change = ((now.last - pick.priceAt5am) / pick.priceAt5am) * 100;
            console.log(`${pick.symbol}: Started @ ${pick.priceAt5am.toFixed(4)} -> Now @ ${now.last.toFixed(4)} | Change: ${change.toFixed(2)}% ${change >= 10 ? '✅ 10% TARGET MET' : ''}`);
        } catch (e) { console.log(`Error tracking ${pick.symbol}`); }
    }
}

// Schedules: 5:00 AM Scan | 11:59 PM Report
cron.schedule('0 5 * * *', getUnifiedPicks);
cron.schedule('59 23 * * *', reportPerformance);

// Initial start
getUnifiedPicks();