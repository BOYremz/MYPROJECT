/**
 * ═══════════════════════════════════════════════════════════════════
 *  FREE BOOKMAP - LIVE TRADING HEATMAP
 *  Uses Binance REST + WebSocket with fallback
 *  Style: Bookmap-style volume dots + heatmap
 * ═══════════════════════════════════════════════════════════════════
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════
// INSTRUMENTS
// ═══════════════════════════════════════════════════════════════════
const INSTRUMENTS = {
  'XAUUSD': { symbol: 'paxgusdt', name: 'Gold / XAUUSD', decimals: 2 },
  'BTCUSD': { symbol: 'btcusdt', name: 'Bitcoin / USD', decimals: 2 },
  'ETHUSD': { symbol: 'ethusdt', name: 'Ethereum / USD', decimals: 2 },
  'EURUSD': { symbol: 'eurusdt', name: 'EUR / USD', decimals: 5 },
  'GBPUSD': { symbol: 'gbpusdt', name: 'GBP / USD', decimals: 5 },
  'NAS100': { symbol: 'bnbusdt', name: 'Nasdaq Proxy (BNB)', decimals: 2 },
  'SOLUSD': { symbol: 'solusdt', name: 'Solana / USD', decimals: 2 },
};

const TIMEFRAMES = {
  '1m': { ms: 60000, binance: '1m' },
  '5m': { ms: 300000, binance: '5m' },
  '15m': { ms: 900000, binance: '15m' },
  '30m': { ms: 1800000, binance: '30m' },
  '1h': { ms: 3600000, binance: '1h' },
  '4h': { ms: 14400000, binance: '4h' },
  '1D': { ms: 86400000, binance: '1d' },
};

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
let CONFIG = {
  currentInstrument: 'BTCUSD',
  currentTimeframe: '1m',
};

let orderBook = { bids: {}, asks: {} };
let previousOrderBook = { bids: {}, asks: {} };
let currentPrice = 0;
let trades = [];
let volumeDots = []; // Bookmap-style volume dots
let candles = {};    // Candles per timeframe
let events = [];
let icebergTracker = {};
let avgTradeSize = 0;
let tradeCount = 0;
let connected = false;

Object.keys(TIMEFRAMES).forEach(tf => { candles[tf] = []; });

let depthWs = null;
let tradeWs = null;

// ═══════════════════════════════════════════════════════════════════
// HTTP FETCH HELPER (for REST API fallback)
// ═══════════════════════════════════════════════════════════════════
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════
// LOAD HISTORICAL DATA VIA REST API (fallback if WS fails)
// ═══════════════════════════════════════════════════════════════════
async function loadHistoricalCandles(symbol, timeframe, limit = 200) {
  try {
    const interval = TIMEFRAMES[timeframe]?.binance || '1m';
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
    const data = await fetchJSON(url);
    
    if (Array.isArray(data)) {
      const tfCandles = data.map(k => ({
        openTime: k[0],
        closeTime: k[6],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        buyVolume: parseFloat(k[9]) || parseFloat(k[5]) * 0.5, // taker buy volume
        sellVolume: parseFloat(k[5]) - (parseFloat(k[9]) || parseFloat(k[5]) * 0.5),
        trades: parseInt(k[8]) || 0,
      }));
      
      candles[timeframe] = tfCandles;
      currentPrice = tfCandles[tfCandles.length - 1]?.close || 0;
      console.log(`[REST] Loaded ${tfCandles.length} candles for ${symbol} ${timeframe}`);
      return tfCandles;
    }
  } catch (err) {
    console.error(`[REST] Failed to load candles: ${err.message}`);
  }
  return [];
}

async function loadOrderBook(symbol) {
  try {
    const url = `https://api.binance.com/api/v3/depth?symbol=${symbol.toUpperCase()}&limit=20`;
    const data = await fetchJSON(url);
    
    if (data.bids && data.asks) {
      orderBook.bids = {};
      orderBook.asks = {};
      data.bids.forEach(([p, q]) => { orderBook.bids[parseFloat(p)] = parseFloat(q); });
      data.asks.forEach(([p, q]) => { orderBook.asks[parseFloat(p)] = parseFloat(q); });
      console.log(`[REST] Loaded order book for ${symbol}`);
    }
  } catch (err) {
    console.error(`[REST] Failed to load order book: ${err.message}`);
  }
}

async function loadRecentTrades(symbol) {
  try {
    const url = `https://api.binance.com/api/v3/trades?symbol=${symbol.toUpperCase()}&limit=100`;
    const data = await fetchJSON(url);
    
    if (Array.isArray(data)) {
      trades = data.map(t => ({
        price: parseFloat(t.price),
        qty: parseFloat(t.qty),
        time: t.time,
        isBuy: t.isBuyerMaker === false,
      }));
      
      // Build volume dots from trades
      trades.forEach(t => {
        addVolumeDot(t.price, t.qty, t.time, t.isBuy);
      });
      
      // Calculate avg trade size
      const totalQty = trades.reduce((a, t) => a + t.qty, 0);
      avgTradeSize = totalQty / trades.length;
      
      console.log(`[REST] Loaded ${trades.length} recent trades`);
    }
  } catch (err) {
    console.error(`[REST] Failed to load trades: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// VOLUME DOTS (Bookmap style)
// ═══════════════════════════════════════════════════════════════════
function addVolumeDot(price, qty, time, isBuy) {
  volumeDots.push({ price, qty, time, isBuy });
  if (volumeDots.length > 5000) {
    volumeDots = volumeDots.slice(-5000);
  }
}

// ═══════════════════════════════════════════════════════════════════
// BINANCE WEBSOCKET (with reconnection)
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
    console.log(`[WS-DEPTH] Connected: ${symbol.toUpperCase()}`);
    connected = true;
  });

  depthWs.on('message', (data) => {
    try {
      const depth = JSON.parse(data);
      previousOrderBook = JSON.parse(JSON.stringify(orderBook));
      orderBook.bids = {};
      orderBook.asks = {};
      if (depth.bids) depth.bids.forEach(([p, q]) => { if (parseFloat(q) > 0) orderBook.bids[parseFloat(p)] = parseFloat(q); });
      if (depth.asks) depth.asks.forEach(([p, q]) => { if (parseFloat(q) > 0) orderBook.asks[parseFloat(p)] = parseFloat(q); });
      
      const bidPs = Object.keys(orderBook.bids).map(Number);
      const askPs = Object.keys(orderBook.asks).map(Number);
      if (bidPs.length && askPs.length) currentPrice = (Math.max(...bidPs) + Math.min(...askPs)) / 2;
      
      detectEvents();
    } catch (e) {}
  });

  depthWs.on('close', () => {
    connected = false;
    setTimeout(connectDepthStream, 5000);
  });

  depthWs.on('error', () => {
    connected = false;
  });
}

function connectTradeStream() {
  if (tradeWs) { try { tradeWs.close(); } catch(e){} }
  
  const symbol = getSymbol();
  const url = `wss://stream.binance.com:9443/ws/${symbol}@aggTrade`;
  
  tradeWs = new WebSocket(url);
  
  tradeWs.on('open', () => {
    console.log(`[WS-TRADE] Connected: ${symbol.toUpperCase()}`);
  });

  tradeWs.on('message', (data) => {
    try {
      const t = JSON.parse(data);
      const price = parseFloat(t.p);
      const qty = parseFloat(t.q);
      const time = t.T || Date.now();
      const isBuy = !t.m;
      
      currentPrice = price;
      
      const trade = { price, qty, time, isBuy };
      trades.push(trade);
      if (trades.length > 2000) trades = trades.slice(-2000);
      
      // Volume dot
      addVolumeDot(price, qty, time, isBuy);
      
      // Update candles
      updateCandle(price, qty, time, isBuy);
      
      // Avg size
      tradeCount++;
      avgTradeSize = avgTradeSize + (qty - avgTradeSize) / Math.min(tradeCount, 200);
      
      // Aggressive detection
      if (qty >= avgTradeSize * 3 && avgTradeSize > 0) {
        addEvent({ type: isBuy ? 'AGGRESSIVE_BUY' : 'AGGRESSIVE_SELL', price, size: qty, time: Date.now() });
      }
    } catch (e) {}
  });

  tradeWs.on('close', () => {
    setTimeout(connectTradeStream, 5000);
  });

  tradeWs.on('error', () => {});
}

// ═══════════════════════════════════════════════════════════════════
// CANDLE UPDATE
// ═══════════════════════════════════════════════════════════════════
function updateCandle(price, qty, timestamp, isBuy) {
  Object.entries(TIMEFRAMES).forEach(([tf, info]) => {
    const openTime = Math.floor(timestamp / info.ms) * info.ms;
    const tfCandles = candles[tf];
    let last = tfCandles.length > 0 ? tfCandles[tfCandles.length - 1] : null;
    
    if (!last || last.openTime !== openTime) {
      tfCandles.push({
        openTime, closeTime: openTime + info.ms,
        open: price, high: price, low: price, close: price,
        volume: qty, buyVolume: isBuy ? qty : 0, sellVolume: isBuy ? 0 : qty, trades: 1,
      });
      if (tfCandles.length > 500) candles[tf] = tfCandles.slice(-500);
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += qty;
      if (isBuy) last.buyVolume += qty; else last.sellVolume += qty;
      last.trades++;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// EVENT DETECTION
// ═══════════════════════════════════════════════════════════════════
function detectEvents() {
  const threshold = avgTradeSize * 2;
  
  // Order pulling
  for (const p of Object.keys(previousOrderBook.bids)) {
    const old = previousOrderBook.bids[p] || 0;
    const now = orderBook.bids[p] || 0;
    if (old >= threshold && now < old * 0.4) {
      addEvent({ type: 'ORDER_PULL', side: 'BID', price: parseFloat(p), time: Date.now() });
    }
  }
  for (const p of Object.keys(previousOrderBook.asks)) {
    const old = previousOrderBook.asks[p] || 0;
    const now = orderBook.asks[p] || 0;
    if (old >= threshold && now < old * 0.4) {
      addEvent({ type: 'ORDER_PULL', side: 'ASK', price: parseFloat(p), time: Date.now() });
    }
  }
  
  // Order stacking
  for (const p of Object.keys(orderBook.bids)) {
    const old = previousOrderBook.bids[p] || 0;
    const now = orderBook.bids[p] || 0;
    if (now >= threshold && old > 0 && now > old * 2.5) {
      addEvent({ type: 'ORDER_STACK', side: 'BID', price: parseFloat(p), time: Date.now() });
    }
  }
  for (const p of Object.keys(orderBook.asks)) {
    const old = previousOrderBook.asks[p] || 0;
    const now = orderBook.asks[p] || 0;
    if (now >= threshold && old > 0 && now > old * 2.5) {
      addEvent({ type: 'ORDER_STACK', side: 'ASK', price: parseFloat(p), time: Date.now() });
    }
  }
}

function addEvent(event) {
  const dup = events.some(e => e.type === event.type && e.price === event.price && Date.now() - e.time < 2000);
  if (dup) return;
  events.push(event);
  if (events.length > 300) events = events.slice(-300);
}

// ═══════════════════════════════════════════════════════════════════
// REST API POLLING (fallback when WebSocket fails)
// ═══════════════════════════════════════════════════════════════════
let restPollInterval = null;

function startRestPolling() {
  if (restPollInterval) return;
  
  const poll = async () => {
    if (connected) return; // WS is working, skip REST
    
    const symbol = getSymbol();
    try {
      await loadOrderBook(symbol);
      await loadRecentTrades(symbol);
    } catch (e) {}
  };
  
  restPollInterval = setInterval(poll, 2000);
  console.log('[REST] Polling started (fallback mode)');
}

function stopRestPolling() {
  if (restPollInterval) {
    clearInterval(restPollInterval);
    restPollInterval = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// INITIAL DATA LOAD
// ═══════════════════════════════════════════════════════════════════
async function loadInitialData() {
  const symbol = getSymbol();
  console.log(`[INIT] Loading data for ${symbol}...`);
  
  // Load historical candles for all timeframes
  for (const tf of Object.keys(TIMEFRAMES)) {
    await loadHistoricalCandles(symbol, tf, 200);
  }
  
  // Load order book and recent trades
  await loadOrderBook(symbol);
  await loadRecentTrades(symbol);
  
  console.log(`[INIT] Data loaded. Price: ${currentPrice}`);
}

// ═══════════════════════════════════════════════════════════════════
// CLIENT WEBSOCKET
// ═══════════════════════════════════════════════════════════════════
wss.on('connection', (ws) => {
  console.log('[CLIENT] Connected');
  
  const tf = CONFIG.currentTimeframe;
  ws.send(JSON.stringify({
    type: 'INIT',
    config: CONFIG,
    instruments: INSTRUMENTS,
    timeframes: Object.keys(TIMEFRAMES),
    candles: candles[tf] || [],
    volumeDots: volumeDots.slice(-2000),
    orderBook,
    events: events.slice(-50),
    currentPrice,
    connected,
  }));

  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const tf = CONFIG.currentTimeframe;
      const tfCandles = candles[tf] || [];
      const currentCandle = tfCandles.length > 0 ? tfCandles[tfCandles.length - 1] : null;
      
      ws.send(JSON.stringify({
        type: 'UPDATE',
        orderBook,
        currentPrice,
        currentCandle,
        volumeDots: volumeDots.slice(-200),
        trades: trades.slice(-50),
        events: events.filter(e => Date.now() - e.time < 15000).slice(-20),
        avgTradeSize,
        connected,
      }));
    }
  }, 200);

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      
      if (data.type === 'CHANGE_INSTRUMENT') {
        if (INSTRUMENTS[data.instrument]) {
          CONFIG.currentInstrument = data.instrument;
          orderBook = { bids: {}, asks: {} };
          previousOrderBook = { bids: {}, asks: {} };
          trades = [];
          volumeDots = [];
          events = [];
          Object.keys(TIMEFRAMES).forEach(tf => { candles[tf] = []; });
          avgTradeSize = 0;
          tradeCount = 0;
          connected = false;
          
          await loadInitialData();
          connectDepthStream();
          connectTradeStream();
          
          ws.send(JSON.stringify({
            type: 'INSTRUMENT_CHANGED',
            instrument: data.instrument,
            candles: candles[CONFIG.currentTimeframe] || [],
            volumeDots: volumeDots.slice(-2000),
            orderBook,
            currentPrice,
          }));
        }
      }
      
      if (data.type === 'CHANGE_TIMEFRAME') {
        if (TIMEFRAMES[data.timeframe]) {
          CONFIG.currentTimeframe = data.timeframe;
          ws.send(JSON.stringify({
            type: 'TIMEFRAME_CHANGED',
            timeframe: data.timeframe,
            candles: candles[data.timeframe] || [],
          }));
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    clearInterval(interval);
    console.log('[CLIENT] Disconnected');
  });
});

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          FREE BOOKMAP - LIVE TRADING HEATMAP                ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  URL: http://localhost:${PORT}                                 ║`);
  console.log('║  Style: Bookmap volume dots + heatmap                       ║');
  console.log('║  Timeframes: 1m | 5m | 15m | 30m | 1h | 4h | 1D            ║');
  console.log('║  Data: Binance REST + WebSocket                             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Instruments:                                               ║');
  Object.entries(INSTRUMENTS).forEach(([key, val]) => {
    console.log(`║    ${key.padEnd(8)} → ${val.name.padEnd(30)}         ║`);
  });
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  // Load initial data via REST API first (always works)
  await loadInitialData();
  
  // Then try WebSocket (may fail behind firewall)
  connectDepthStream();
  connectTradeStream();
  
  // Start REST polling as fallback
  startRestPolling();
});
