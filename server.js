/**
 * ═══════════════════════════════════════════════════════════════════
 *  FREE BOOKMAP HEATMAP + CANDLESTICK CHART SERVER
 *  Live market data via Binance WebSocket (FREE - no API key needed)
 * 
 *  Features:
 *  - Real-time candlestick chart (1m, 5m, 15m, 30m, 1h, 4h, 1D)
 *  - Volume bars with buy/sell coloring
 *  - Order book heatmap overlay
 *  - Candle close countdown timer
 *  - Order flow detection (iceberg, pulling, stacking, etc.)
 * 
 *  Supported Markets:
 *  - GOLD/XAUUSD  → PAXGUSDT (tokenized gold)
 *  - NASDAQ/US100 → BNB proxy
 *  - FOREX        → EURUSDT, GBPUSDT
 *  - CRYPTO       → BTCUSDT, ETHUSDT, SOLUSDT
 * ═══════════════════════════════════════════════════════════════════
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════
// INSTRUMENTS
// ═══════════════════════════════════════════════════════════════════
const INSTRUMENTS = {
  'XAUUSD': { symbol: 'paxgusdt', name: 'Gold / XAUUSD', tickSize: 0.1, decimals: 2 },
  'BTCUSD': { symbol: 'btcusdt', name: 'Bitcoin / USD', tickSize: 1, decimals: 2 },
  'ETHUSD': { symbol: 'ethusdt', name: 'Ethereum / USD', tickSize: 0.1, decimals: 2 },
  'EURUSD': { symbol: 'eurusdt', name: 'EUR / USD', tickSize: 0.0001, decimals: 5 },
  'GBPUSD': { symbol: 'gbpusdt', name: 'GBP / USD', tickSize: 0.0001, decimals: 5 },
  'NAS100': { symbol: 'bnbusdt', name: 'Nasdaq Proxy (BNB)', tickSize: 0.01, decimals: 2 },
  'SOLUSD': { symbol: 'solusdt', name: 'Solana / USD', tickSize: 0.01, decimals: 2 },
};

// ═══════════════════════════════════════════════════════════════════
// TIMEFRAMES (in milliseconds)
// ═══════════════════════════════════════════════════════════════════
const TIMEFRAMES = {
  '1m': 60000,
  '5m': 300000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '4h': 14400000,
  '1D': 86400000,
};

// ═══════════════════════════════════════════════════════════════════
// CONFIG & STATE
// ═══════════════════════════════════════════════════════════════════
const CONFIG = {
  currentInstrument: 'XAUUSD',
  currentTimeframe: '1m',
  maxCandles: 500,
  depthLevels: 20,
  snapshotInterval: 300,
  historyLength: 400,
  icebergThreshold: 5,
  pullThreshold: 0.4,
  stackThreshold: 2.5,
  aggressiveMultiplier: 3,
};

// Market state
let orderBook = { bids: {}, asks: {} };
let previousOrderBook = { bids: {}, asks: {} };
let tradeHistory = [];
let domHistory = [];
let detectedEvents = [];
let currentPrice = 0;
let icebergTracker = {};
let avgTradeSize = 0;
let tradeCount = 0;

// OHLC Candle state - stores candles for ALL timeframes
let candles = {};
Object.keys(TIMEFRAMES).forEach(tf => { candles[tf] = []; });

let depthWs = null;
let tradeWs = null;

// ═══════════════════════════════════════════════════════════════════
// CANDLE BUILDING
// ═══════════════════════════════════════════════════════════════════
function getCandelOpenTime(timestamp, timeframeMs) {
  return Math.floor(timestamp / timeframeMs) * timeframeMs;
}

function updateCandles(price, qty, timestamp, isBuy) {
  Object.entries(TIMEFRAMES).forEach(([tf, ms]) => {
    const openTime = getCandelOpenTime(timestamp, ms);
    const tfCandles = candles[tf];
    
    let currentCandle = tfCandles.length > 0 ? tfCandles[tfCandles.length - 1] : null;
    
    if (!currentCandle || currentCandle.openTime !== openTime) {
      // Start new candle
      const newCandle = {
        openTime: openTime,
        closeTime: openTime + ms,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: qty,
        buyVolume: isBuy ? qty : 0,
        sellVolume: isBuy ? 0 : qty,
        trades: 1,
      };
      tfCandles.push(newCandle);
      
      // Keep bounded
      if (tfCandles.length > CONFIG.maxCandles) {
        candles[tf] = tfCandles.slice(-CONFIG.maxCandles);
      }
    } else {
      // Update existing candle
      currentCandle.high = Math.max(currentCandle.high, price);
      currentCandle.low = Math.min(currentCandle.low, price);
      currentCandle.close = price;
      currentCandle.volume += qty;
      if (isBuy) currentCandle.buyVolume += qty;
      else currentCandle.sellVolume += qty;
      currentCandle.trades++;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// BINANCE CONNECTIONS
// ═══════════════════════════════════════════════════════════════════
function getSymbol() {
  return INSTRUMENTS[CONFIG.currentInstrument].symbol;
}

function connectDepthStream() {
  if (depthWs) { try { depthWs.close(); } catch(e){} }
  
  const symbol = getSymbol();
  const url = `wss://stream.binance.com:9443/ws/${symbol}@depth20@100ms`;
  
  depthWs = new WebSocket(url);
  
  depthWs.on('open', () => {
    console.log(`[DEPTH] Connected: ${symbol.toUpperCase()}`);
  });

  depthWs.on('message', (data) => {
    try {
      const depth = JSON.parse(data);
      processDepthUpdate(depth);
    } catch (e) {}
  });

  depthWs.on('close', () => {
    console.log('[DEPTH] Disconnected, reconnecting...');
    setTimeout(connectDepthStream, 2000);
  });

  depthWs.on('error', (err) => {
    console.error('[DEPTH] Error:', err.message);
  });
}

function connectTradeStream() {
  if (tradeWs) { try { tradeWs.close(); } catch(e){} }
  
  const symbol = getSymbol();
  const url = `wss://stream.binance.com:9443/ws/${symbol}@aggTrade`;
  
  tradeWs = new WebSocket(url);
  
  tradeWs.on('open', () => {
    console.log(`[TRADES] Connected: ${symbol.toUpperCase()}`);
  });

  tradeWs.on('message', (data) => {
    try {
      const trade = JSON.parse(data);
      processTrade(trade);
    } catch (e) {}
  });

  tradeWs.on('close', () => {
    console.log('[TRADES] Disconnected, reconnecting...');
    setTimeout(connectTradeStream, 2000);
  });

  tradeWs.on('error', (err) => {
    console.error('[TRADES] Error:', err.message);
  });
}

// ═══════════════════════════════════════════════════════════════════
// DATA PROCESSING
// ═══════════════════════════════════════════════════════════════════
function processDepthUpdate(depth) {
  previousOrderBook = JSON.parse(JSON.stringify(orderBook));
  orderBook.bids = {};
  orderBook.asks = {};
  
  if (depth.bids) {
    depth.bids.forEach(([price, qty]) => {
      const p = parseFloat(price);
      const q = parseFloat(qty);
      if (q > 0) orderBook.bids[p] = q;
    });
  }
  
  if (depth.asks) {
    depth.asks.forEach(([price, qty]) => {
      const p = parseFloat(price);
      const q = parseFloat(qty);
      if (q > 0) orderBook.asks[p] = q;
    });
  }

  const bidPrices = Object.keys(orderBook.bids).map(Number);
  const askPrices = Object.keys(orderBook.asks).map(Number);
  
  if (bidPrices.length > 0 && askPrices.length > 0) {
    const bestBid = Math.max(...bidPrices);
    const bestAsk = Math.min(...askPrices);
    currentPrice = (bestBid + bestAsk) / 2;
  }

  detectOrderPulling();
  detectOrderStacking();
  detectIcebergAbsorption();
}

function processTrade(trade) {
  const price = parseFloat(trade.p);
  const qty = parseFloat(trade.q);
  const timestamp = trade.T || Date.now();
  const isBuy = !trade.m;
  
  const tradeData = {
    price, qty, time: timestamp, isBuy,
    value: price * qty,
  };
  
  currentPrice = price;
  tradeHistory.push(tradeData);
  
  // Update candles
  updateCandles(price, qty, timestamp, isBuy);
  
  // Update average trade size
  tradeCount++;
  avgTradeSize = avgTradeSize + (qty - avgTradeSize) / Math.min(tradeCount, 200);
  
  if (tradeHistory.length > 2000) {
    tradeHistory = tradeHistory.slice(-2000);
  }

  // Detect aggressive trades
  const threshold = avgTradeSize * CONFIG.aggressiveMultiplier;
  if (qty >= threshold && threshold > 0) {
    addEvent({
      type: isBuy ? 'AGGRESSIVE_BUY' : 'AGGRESSIVE_SELL',
      price, size: qty,
      time: Date.now(),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// DETECTION ALGORITHMS
// ═══════════════════════════════════════════════════════════════════
function detectOrderPulling() {
  const threshold = avgTradeSize * 2;
  
  const check = (prev, curr, side) => {
    for (const price of Object.keys(prev)) {
      const p = parseFloat(price);
      const oldQty = prev[p] || 0;
      const newQty = curr[p] || 0;
      
      if (oldQty >= threshold && newQty < oldQty * CONFIG.pullThreshold) {
        addEvent({
          type: 'ORDER_PULL', side, price: p,
          oldSize: oldQty, newSize: newQty,
          time: Date.now(),
        });
      }
    }
  };
  
  check(previousOrderBook.bids, orderBook.bids, 'BID');
  check(previousOrderBook.asks, orderBook.asks, 'ASK');
}

function detectOrderStacking() {
  const threshold = avgTradeSize * 2;
  
  const check = (prev, curr, side) => {
    for (const price of Object.keys(curr)) {
      const p = parseFloat(price);
      const oldQty = prev[p] || 0;
      const newQty = curr[p] || 0;
      
      if (newQty >= threshold && oldQty > 0 && newQty > oldQty * CONFIG.stackThreshold) {
        addEvent({
          type: 'ORDER_STACK', side, price: p,
          oldSize: oldQty, newSize: newQty,
          time: Date.now(),
        });
      }
    }
  };
  
  check(previousOrderBook.bids, orderBook.bids, 'BID');
  check(previousOrderBook.asks, orderBook.asks, 'ASK');
}

function detectIcebergAbsorption() {
  const threshold = avgTradeSize * 1.5;
  
  const checkSide = (prev, curr, side) => {
    for (const price of Object.keys(prev)) {
      const p = parseFloat(price);
      const oldQty = prev[p] || 0;
      const newQty = curr[p] || 0;
      
      if (oldQty >= threshold && newQty >= oldQty * 0.7 && newQty <= oldQty * 1.3) {
        const recentTrades = tradeHistory.filter(t => 
          Math.abs(t.price - p) < INSTRUMENTS[CONFIG.currentInstrument].tickSize * 2 &&
          Date.now() - t.time < 5000
        );
        
        if (recentTrades.length > 0) {
          const key = `${side}_${p}`;
          icebergTracker[key] = (icebergTracker[key] || 0) + 1;
          
          if (icebergTracker[key] >= CONFIG.icebergThreshold) {
            addEvent({
              type: 'ICEBERG', side: side.toUpperCase(),
              price: p, size: newQty,
              refillCount: icebergTracker[key],
              time: Date.now(),
            });
            icebergTracker[key] = 0;
          }
        }
      }
    }
  };
  
  checkSide(previousOrderBook.bids, orderBook.bids, 'bid');
  checkSide(previousOrderBook.asks, orderBook.asks, 'ask');
  
  if (Object.keys(icebergTracker).length > 200) {
    const keys = Object.keys(icebergTracker);
    keys.slice(0, keys.length - 100).forEach(k => delete icebergTracker[k]);
  }
}

function addEvent(event) {
  const isDuplicate = detectedEvents.some(e => 
    e.type === event.type && e.price === event.price && Date.now() - e.time < 1000
  );
  if (isDuplicate) return;
  
  detectedEvents.push(event);
  if (detectedEvents.length > 500) {
    detectedEvents = detectedEvents.slice(-500);
  }
}

// ═══════════════════════════════════════════════════════════════════
// DOM SNAPSHOTS
// ═══════════════════════════════════════════════════════════════════
function takeDOMSnapshot() {
  if (Object.keys(orderBook.bids).length === 0) return;
  
  domHistory.push({
    time: Date.now(),
    price: currentPrice,
    bids: { ...orderBook.bids },
    asks: { ...orderBook.asks },
  });
  
  if (domHistory.length > CONFIG.historyLength) {
    domHistory = domHistory.slice(-CONFIG.historyLength);
  }
}

setInterval(takeDOMSnapshot, CONFIG.snapshotInterval);

// Clean old events
setInterval(() => {
  const cutoff = Date.now() - 120000;
  detectedEvents = detectedEvents.filter(e => e.time > cutoff);
}, 10000);

// ═══════════════════════════════════════════════════════════════════
// CLIENT WEBSOCKET
// ═══════════════════════════════════════════════════════════════════
wss.on('connection', (ws) => {
  console.log('[CLIENT] Connected');
  
  // Send initial data
  ws.send(JSON.stringify({
    type: 'INIT',
    config: CONFIG,
    instruments: INSTRUMENTS,
    timeframes: Object.keys(TIMEFRAMES),
    candles: candles[CONFIG.currentTimeframe] || [],
    domHistory: domHistory.slice(-200),
    events: detectedEvents.slice(-50),
    currentPrice,
  }));

  // Stream updates
  const updateInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const tf = CONFIG.currentTimeframe;
      const tfCandles = candles[tf] || [];
      const currentCandle = tfCandles.length > 0 ? tfCandles[tfCandles.length - 1] : null;
      
      ws.send(JSON.stringify({
        type: 'UPDATE',
        orderBook,
        currentPrice,
        currentCandle,
        trades: tradeHistory.slice(-100),
        events: detectedEvents.filter(e => Date.now() - e.time < 10000).slice(-30),
        avgTradeSize,
        domSnapshot: domHistory.length > 0 ? domHistory[domHistory.length - 1] : null,
      }));
    }
  }, 150);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      
      if (data.type === 'CHANGE_INSTRUMENT') {
        const instrument = data.instrument;
        if (INSTRUMENTS[instrument]) {
          CONFIG.currentInstrument = instrument;
          console.log(`[SWITCH] → ${INSTRUMENTS[instrument].name}`);
          
          // Reset state
          orderBook = { bids: {}, asks: {} };
          previousOrderBook = { bids: {}, asks: {} };
          domHistory = [];
          detectedEvents = [];
          tradeHistory = [];
          icebergTracker = {};
          avgTradeSize = 0;
          tradeCount = 0;
          Object.keys(TIMEFRAMES).forEach(tf => { candles[tf] = []; });
          
          connectDepthStream();
          connectTradeStream();
          
          ws.send(JSON.stringify({ 
            type: 'INSTRUMENT_CHANGED', instrument, config: CONFIG,
            candles: [],
          }));
        }
      }
      
      if (data.type === 'CHANGE_TIMEFRAME') {
        const tf = data.timeframe;
        if (TIMEFRAMES[tf]) {
          CONFIG.currentTimeframe = tf;
          ws.send(JSON.stringify({
            type: 'TIMEFRAME_CHANGED',
            timeframe: tf,
            candles: candles[tf] || [],
          }));
        }
      }
      
      if (data.type === 'GET_CANDLES') {
        const tf = data.timeframe || CONFIG.currentTimeframe;
        ws.send(JSON.stringify({
          type: 'CANDLES_DATA',
          timeframe: tf,
          candles: candles[tf] || [],
        }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('[CLIENT] Disconnected');
    clearInterval(updateInterval);
  });
});

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║      FREE BOOKMAP + CANDLESTICK CHART - LIVE TRADING        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  URL: http://localhost:${PORT}                                 ║`);
  console.log(`║  Default: ${INSTRUMENTS[CONFIG.currentInstrument].name.padEnd(35)}        ║`);
  console.log('║  Timeframes: 1m | 5m | 15m | 30m | 1h | 4h | 1D            ║');
  console.log('║  Data: Binance WebSocket (FREE, no API key)                 ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Instruments:                                               ║');
  Object.entries(INSTRUMENTS).forEach(([key, val]) => {
    console.log(`║    ${key.padEnd(8)} → ${val.name.padEnd(30)}         ║`);
  });
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  connectDepthStream();
  connectTradeStream();
});
