/**
 * FREE BOOKMAP CLONE - Real Bookmap-style heatmap
 * Loads historical klines + builds structured DOM history heatmap
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const INSTRUMENTS = {
  'XAUUSD': { symbol: 'paxgusdt', name: 'Gold / XAUUSD' },
  'BTCUSD': { symbol: 'btcusdt', name: 'Bitcoin / USD' },
  'ETHUSD': { symbol: 'ethusdt', name: 'Ethereum / USD' },
  'EURUSD': { symbol: 'eurusdt', name: 'EUR / USD' },
  'GBPUSD': { symbol: 'gbpusdt', name: 'GBP / USD' },
  'NAS100': { symbol: 'bnbusdt', name: 'Nasdaq Proxy (BNB)' },
  'SOLUSD': { symbol: 'solusdt', name: 'Solana / USD' },
};

const TIMEFRAMES = {
  '1m':  { ms: 60000,    binance: '1m'  },
  '5m':  { ms: 300000,   binance: '5m'  },
  '15m': { ms: 900000,   binance: '15m' },
  '30m': { ms: 1800000,  binance: '30m' },
  '1h':  { ms: 3600000,  binance: '1h'  },
  '4h':  { ms: 14400000, binance: '4h'  },
  '1D':  { ms: 86400000, binance: '1d'  },
};

let CONFIG = { currentInstrument: 'BTCUSD', currentTimeframe: '1m' };

let orderBook = { bids: {}, asks: {} };
let previousOrderBook = { bids: {}, asks: {} };
let currentPrice = 0;
let trades = [];
let candles = {};
let domHistory = [];
let events = [];
let avgTradeSize = 0;
let tradeCount = 0;
let connected = false;

Object.keys(TIMEFRAMES).forEach(tf => { candles[tf] = []; });

let depthWs = null;
let tradeWs = null;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Generate synthetic footprint data for historical candles
// Distributes buy/sell volume across price levels within the candle range
function generateSyntheticFootprint(open, high, low, close, buyVol, sellVol, tf) {
  const footprint = {};
  let tick;
  const price = (open + close) / 2;
  if (price > 10000) tick = 10;
  else if (price > 1000) tick = 1;
  else if (price > 100) tick = 0.5;
  else if (price > 10) tick = 0.1;
  else tick = 0.01;
  if (tf === '1h' || tf === '4h') tick *= 2;
  if (tf === '1D') tick *= 5;

  const roundLow = Math.floor(low / tick) * tick;
  const roundHigh = Math.ceil(high / tick) * tick;
  const levels = Math.max(1, Math.round((roundHigh - roundLow) / tick));
  
  // Distribute volume with a bell-curve-like distribution centered near close
  const center = close;
  const totalLevels = Math.min(levels, 30); // Cap at 30 levels for performance
  const stepSize = (roundHigh - roundLow) / totalLevels;
  
  let totalWeight = 0;
  const weights = [];
  for (let i = 0; i < totalLevels; i++) {
    const levelPrice = roundLow + i * stepSize;
    const dist = Math.abs(levelPrice - center) / (roundHigh - roundLow || 1);
    const w = Math.exp(-dist * 3) + 0.1; // More volume near close
    weights.push(w);
    totalWeight += w;
  }
  
  for (let i = 0; i < totalLevels; i++) {
    const levelPrice = Math.round((roundLow + i * stepSize) / tick) * tick;
    const ratio = weights[i] / totalWeight;
    // Bias: if close > open (bullish), more buying near bottom, selling near top
    const isBullish = close >= open;
    const posInRange = i / totalLevels;
    let buyRatio = isBullish ? (0.6 - posInRange * 0.3) : (0.3 + posInRange * 0.3);
    buyRatio = Math.max(0.2, Math.min(0.8, buyRatio));
    
    const levelVol = (buyVol + sellVol) * ratio;
    footprint[levelPrice] = {
      buy: +(levelVol * buyRatio).toFixed(4),
      sell: +(levelVol * (1 - buyRatio)).toFixed(4)
    };
  }
  return footprint;
}

async function loadHistoricalCandles(symbol, tf, limit = 200) {
  try {
    const interval = TIMEFRAMES[tf].binance;
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
    const data = await fetchJSON(url);
    if (Array.isArray(data)) {
      candles[tf] = data.map(k => {
        const open = parseFloat(k[1]), high = parseFloat(k[2]);
        const low = parseFloat(k[3]), close = parseFloat(k[4]);
        const volume = parseFloat(k[5]);
        const buyVolume = parseFloat(k[9]) || volume * 0.5;
        const sellVolume = volume - buyVolume;
        // Generate synthetic footprint from OHLCV for historical candles
        const footprint = generateSyntheticFootprint(open, high, low, close, buyVolume, sellVolume, tf);
        return {
          openTime: k[0], closeTime: k[6],
          open, high, low, close, volume, buyVolume, sellVolume, footprint
        };
      });
      currentPrice = candles[tf][candles[tf].length-1]?.close || 0;
      console.log(`[REST] Loaded ${candles[tf].length} ${tf} candles`);
    }
  } catch (err) {
    console.error(`[REST] Candles error: ${err.message}`);
  }
}

async function loadOrderBook(symbol) {
  try {
    const url = `https://api.binance.com/api/v3/depth?symbol=${symbol.toUpperCase()}&limit=100`;
    const data = await fetchJSON(url);
    if (data.bids && data.asks) {
      previousOrderBook = JSON.parse(JSON.stringify(orderBook));
      orderBook.bids = {};
      orderBook.asks = {};
      data.bids.forEach(([p, q]) => { orderBook.bids[parseFloat(p)] = parseFloat(q); });
      data.asks.forEach(([p, q]) => { orderBook.asks[parseFloat(p)] = parseFloat(q); });
      takeDOMSnapshot();
    }
  } catch (err) {}
}

async function loadRecentTrades(symbol) {
  try {
    const url = `https://api.binance.com/api/v3/trades?symbol=${symbol.toUpperCase()}&limit=200`;
    const data = await fetchJSON(url);
    if (Array.isArray(data)) {
      trades = data.map(t => ({
        price: parseFloat(t.price),
        qty: parseFloat(t.qty),
        time: t.time,
        isBuy: !t.isBuyerMaker,
      }));
      const total = trades.reduce((a,t) => a+t.qty, 0);
      avgTradeSize = total / trades.length;
      currentPrice = trades[trades.length-1]?.price || currentPrice;
    }
  } catch (err) {}
}

function takeDOMSnapshot() {
  if (Object.keys(orderBook.bids).length === 0) return;
  domHistory.push({
    time: Date.now(),
    price: currentPrice,
    bids: { ...orderBook.bids },
    asks: { ...orderBook.asks },
  });
  if (domHistory.length > 600) domHistory = domHistory.slice(-600);
}

setInterval(takeDOMSnapshot, 1000);

function getSymbol() { return INSTRUMENTS[CONFIG.currentInstrument].symbol; }

function connectDepthStream() {
  if (depthWs) try { depthWs.close(); } catch(e){}
  const symbol = getSymbol();
  try {
    depthWs = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@depth20@100ms`, { rejectUnauthorized: false });
    depthWs.on('open', () => { connected = true; console.log(`[WS] Depth: ${symbol}`); });
    depthWs.on('message', (data) => {
      try {
        const d = JSON.parse(data);
        previousOrderBook = JSON.parse(JSON.stringify(orderBook));
        orderBook.bids = {};
        orderBook.asks = {};
        if (d.bids) d.bids.forEach(([p,q]) => { if (parseFloat(q)>0) orderBook.bids[parseFloat(p)] = parseFloat(q); });
        if (d.asks) d.asks.forEach(([p,q]) => { if (parseFloat(q)>0) orderBook.asks[parseFloat(p)] = parseFloat(q); });
        const bP = Object.keys(orderBook.bids).map(Number);
        const aP = Object.keys(orderBook.asks).map(Number);
        if (bP.length && aP.length) currentPrice = (Math.max(...bP) + Math.min(...aP))/2;
        detectEvents();
      } catch(e) {}
    });
    depthWs.on('close', () => { connected = false; setTimeout(connectDepthStream, 5000); });
    depthWs.on('error', () => { connected = false; });
  } catch(e) { connected = false; }
}

function connectTradeStream() {
  if (tradeWs) try { tradeWs.close(); } catch(e){}
  const symbol = getSymbol();
  try {
    tradeWs = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@aggTrade`, { rejectUnauthorized: false });
    tradeWs.on('open', () => console.log(`[WS] Trade: ${symbol}`));
    tradeWs.on('message', (data) => {
      try {
        const t = JSON.parse(data);
        const price = parseFloat(t.p), qty = parseFloat(t.q), time = t.T || Date.now();
        const isBuy = !t.m;
        currentPrice = price;
        trades.push({ price, qty, time, isBuy });
        if (trades.length > 2000) trades = trades.slice(-2000);
        updateCandle(price, qty, time, isBuy);
        tradeCount++;
        avgTradeSize = avgTradeSize + (qty - avgTradeSize) / Math.min(tradeCount, 200);
        if (qty >= avgTradeSize * 3 && avgTradeSize > 0) {
          addEvent({ type: isBuy?'AGGRESSIVE_BUY':'AGGRESSIVE_SELL', price, size: qty, time: Date.now() });
        }
      } catch(e) {}
    });
    tradeWs.on('close', () => setTimeout(connectTradeStream, 5000));
    tradeWs.on('error', () => {});
  } catch(e) {}
}

function updateCandle(price, qty, ts, isBuy) {
  Object.entries(TIMEFRAMES).forEach(([tf, info]) => {
    const openTime = Math.floor(ts/info.ms)*info.ms;
    const arr = candles[tf];
    let last = arr[arr.length-1];
    if (!last || last.openTime !== openTime) {
      const footprint = {};
      const roundedPrice = roundToTick(price, tf);
      footprint[roundedPrice] = { buy: isBuy ? qty : 0, sell: isBuy ? 0 : qty };
      arr.push({ openTime, closeTime: openTime+info.ms, open: price, high: price, low: price, close: price, volume: qty, buyVolume: isBuy?qty:0, sellVolume: isBuy?0:qty, footprint });
      if (arr.length > 500) candles[tf] = arr.slice(-500);
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += qty;
      if (isBuy) last.buyVolume += qty; else last.sellVolume += qty;
      // Update footprint data
      if (!last.footprint) last.footprint = {};
      const roundedPrice = roundToTick(price, tf);
      if (!last.footprint[roundedPrice]) last.footprint[roundedPrice] = { buy: 0, sell: 0 };
      if (isBuy) last.footprint[roundedPrice].buy += qty;
      else last.footprint[roundedPrice].sell += qty;
    }
  });
}

// Round price to appropriate tick size for footprint grouping
function roundToTick(price, tf) {
  // Adaptive tick size based on price magnitude and timeframe
  let tick;
  if (price > 10000) tick = 10;        // BTC - $10 levels
  else if (price > 1000) tick = 1;      // Gold/PAXG - $1 levels
  else if (price > 100) tick = 0.5;     // SOL/BNB
  else if (price > 10) tick = 0.1;      // ETH etc
  else tick = 0.01;                     // Forex pairs
  
  // Wider ticks for larger timeframes
  if (tf === '1h' || tf === '4h') tick *= 2;
  if (tf === '1D') tick *= 5;
  
  return Math.round(price / tick) * tick;
}

function detectEvents() {
  const threshold = avgTradeSize * 2;
  for (const p of Object.keys(previousOrderBook.bids)) {
    const old = previousOrderBook.bids[p]||0, nw = orderBook.bids[p]||0;
    if (old >= threshold && nw < old*0.4) addEvent({ type:'ORDER_PULL', side:'BID', price: parseFloat(p), time: Date.now() });
  }
  for (const p of Object.keys(previousOrderBook.asks)) {
    const old = previousOrderBook.asks[p]||0, nw = orderBook.asks[p]||0;
    if (old >= threshold && nw < old*0.4) addEvent({ type:'ORDER_PULL', side:'ASK', price: parseFloat(p), time: Date.now() });
  }
  for (const p of Object.keys(orderBook.bids)) {
    const old = previousOrderBook.bids[p]||0, nw = orderBook.bids[p]||0;
    if (nw >= threshold && old > 0 && nw > old*2.5) addEvent({ type:'ORDER_STACK', side:'BID', price: parseFloat(p), time: Date.now() });
  }
}

function addEvent(e) {
  const dup = events.some(x => x.type===e.type && x.price===e.price && Date.now()-x.time<2000);
  if (dup) return;
  events.push(e);
  if (events.length > 300) events = events.slice(-300);
}

async function startRestPolling() {
  setInterval(async () => {
    if (connected) return;
    try {
      await loadOrderBook(getSymbol());
      await loadRecentTrades(getSymbol());
    } catch(e) {}
  }, 2000);
}

async function loadInitialData() {
  const symbol = getSymbol();
  console.log(`[INIT] Loading ${symbol.toUpperCase()}...`);
  for (const tf of Object.keys(TIMEFRAMES)) {
    await loadHistoricalCandles(symbol, tf, 200);
  }
  await loadOrderBook(symbol);
  await loadRecentTrades(symbol);
  
  // Pre-fill DOM history so heatmap shows immediately
  for (let i = 0; i < 60; i++) {
    domHistory.push({
      time: Date.now() - (60-i) * 1000,
      price: currentPrice,
      bids: { ...orderBook.bids },
      asks: { ...orderBook.asks },
    });
  }
  
  console.log(`[INIT] Done. Price=${currentPrice} Candles=${candles['1m'].length} DOM=${domHistory.length}`);
}

wss.on('connection', (ws) => {
  console.log('[CLIENT] Connected');
  ws.send(JSON.stringify({
    type: 'INIT',
    config: CONFIG,
    instruments: INSTRUMENTS,
    timeframes: Object.keys(TIMEFRAMES),
    candles: candles[CONFIG.currentTimeframe] || [],
    domHistory,
    orderBook,
    trades: trades.slice(-200),
    events: events.slice(-50),
    currentPrice,
    connected,
  }));

  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const tf = CONFIG.currentTimeframe;
    const tfCandles = candles[tf] || [];
    ws.send(JSON.stringify({
      type: 'UPDATE',
      orderBook,
      currentPrice,
      currentCandle: tfCandles[tfCandles.length-1] || null,
      domHistory: domHistory.slice(-100),
      trades: trades.slice(-50),
      events: events.filter(e => Date.now()-e.time < 30000).slice(-30),
      connected,
    }));
  }, 500);

  ws.on('message', async (msg) => {
    try {
      const d = JSON.parse(msg);
      if (d.type === 'CHANGE_INSTRUMENT' && INSTRUMENTS[d.instrument]) {
        CONFIG.currentInstrument = d.instrument;
        orderBook = { bids:{}, asks:{} };
        previousOrderBook = { bids:{}, asks:{} };
        trades = []; events = []; domHistory = [];
        Object.keys(TIMEFRAMES).forEach(tf => { candles[tf] = []; });
        avgTradeSize = 0; tradeCount = 0; connected = false;
        await loadInitialData();
        connectDepthStream();
        connectTradeStream();
        ws.send(JSON.stringify({
          type: 'INSTRUMENT_CHANGED',
          instrument: d.instrument,
          candles: candles[CONFIG.currentTimeframe]||[],
          domHistory,
          orderBook,
          currentPrice,
        }));
      }
      if (d.type === 'CHANGE_TIMEFRAME' && TIMEFRAMES[d.timeframe]) {
        CONFIG.currentTimeframe = d.timeframe;
        ws.send(JSON.stringify({
          type: 'TIMEFRAME_CHANGED',
          timeframe: d.timeframe,
          candles: candles[d.timeframe]||[],
        }));
      }
    } catch(e) {}
  });

  ws.on('close', () => { clearInterval(interval); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log('\n========================================');
  console.log('  FREE BOOKMAP - Real Heatmap Style');
  console.log(`  URL: http://localhost:${PORT}`);
  console.log('========================================\n');
  await loadInitialData();
  connectDepthStream();
  connectTradeStream();
  startRestPolling();
});
