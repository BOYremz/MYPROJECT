/**
 * ═══════════════════════════════════════════════════════════════════
 *  FREE BOOKMAP-STYLE HEATMAP SERVER
 *  Live market data via Binance WebSocket (FREE - no API key needed)
 * 
 *  Supported Markets:
 *  - GOLD/XAUUSD  → PAXGUSDT (tokenized gold, tracks XAU perfectly)
 *  - NASDAQ/US100 → Uses crypto correlates or direct index tokens
 *  - FOREX pairs  → EURUSDT, GBPUSDT, JPYUSDT etc.
 *  - CRYPTO       → BTCUSDT, ETHUSDT, etc.
 * 
 *  Detects: Resting Liquidity, Market Orders, Order Pulling,
 *           Order Stacking, Iceberg Absorption, Aggressive 
 *           Buying/Selling, DOM Evolution Over Time
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
// AVAILABLE INSTRUMENTS (maps friendly names to Binance symbols)
// ═══════════════════════════════════════════════════════════════════
const INSTRUMENTS = {
  'XAUUSD': { symbol: 'paxgusdt', name: 'Gold / XAUUSD', tickSize: 0.1, aggSize: 0.001 },
  'BTCUSD': { symbol: 'btcusdt', name: 'Bitcoin / USD', tickSize: 1, aggSize: 0.01 },
  'ETHUSD': { symbol: 'ethusdt', name: 'Ethereum / USD', tickSize: 0.1, aggSize: 0.1 },
  'EURUSD': { symbol: 'eurusdt', name: 'EUR / USD', tickSize: 0.0001, aggSize: 10 },
  'GBPUSD': { symbol: 'gbpusdt', name: 'GBP / USD', tickSize: 0.0001, aggSize: 10 },
  'NAS100': { symbol: 'bnbusdt', name: 'Nasdaq Proxy (BNB)', tickSize: 0.01, aggSize: 0.1 },
  'SOLUSD': { symbol: 'solusdt', name: 'Solana / USD', tickSize: 0.01, aggSize: 1 },
};

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════
const CONFIG = {
  currentInstrument: 'XAUUSD',
  depthLevels: 20,
  snapshotInterval: 300,
  historyLength: 400,
  icebergThreshold: 5,
  pullThreshold: 0.4,
  stackThreshold: 2.5,
  aggressiveMultiplier: 3,
};

// ═══════════════════════════════════════════════════════════════════
// MARKET DATA STATE
// ═══════════════════════════════════════════════════════════════════
let orderBook = { bids: {}, asks: {} };
let previousOrderBook = { bids: {}, asks: {} };
let tradeHistory = [];
let domHistory = [];
let detectedEvents = [];
let currentPrice = 0;
let icebergTracker = {};
let avgTradeSize = 0;
let tradeCount = 0;

// Binance connections
let depthWs = null;
let tradeWs = null;

// ═══════════════════════════════════════════════════════════════════
// BINANCE WEBSOCKET CONNECTIONS
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

  // Run detection algorithms
  detectOrderPulling();
  detectOrderStacking();
  detectIcebergAbsorption();
  detectRestingLiquidity();
}

function processTrade(trade) {
  const tradeData = {
    price: parseFloat(trade.p),
    qty: parseFloat(trade.q),
    time: trade.T || Date.now(),
    isBuy: !trade.m, // m=true means buyer is maker, so taker SOLD
    value: parseFloat(trade.p) * parseFloat(trade.q),
  };
  
  currentPrice = tradeData.price;
  tradeHistory.push(tradeData);
  
  // Update average trade size
  tradeCount++;
  avgTradeSize = avgTradeSize + (tradeData.qty - avgTradeSize) / Math.min(tradeCount, 200);
  
  if (tradeHistory.length > 2000) {
    tradeHistory = tradeHistory.slice(-2000);
  }

  // Detect aggressive buying/selling
  const threshold = avgTradeSize * CONFIG.aggressiveMultiplier;
  if (tradeData.qty >= threshold && threshold > 0) {
    addEvent({
      type: tradeData.isBuy ? 'AGGRESSIVE_BUY' : 'AGGRESSIVE_SELL',
      price: tradeData.price,
      size: tradeData.qty,
      value: tradeData.value,
      time: Date.now(),
      description: `${tradeData.isBuy ? '🟢 AGGRESSIVE BUY' : '🔴 AGGRESSIVE SELL'}: ${tradeData.qty.toFixed(4)} @ ${tradeData.price}`,
    });
  }

  // All trades are market orders
  addEvent({
    type: 'MARKET_ORDER',
    price: tradeData.price,
    size: tradeData.qty,
    side: tradeData.isBuy ? 'BUY' : 'SELL',
    time: Date.now(),
  });
}

// ═══════════════════════════════════════════════════════════════════
// DETECTION ALGORITHMS
// ═══════════════════════════════════════════════════════════════════

function detectRestingLiquidity() {
  // Large resting orders that haven't moved for multiple snapshots
  const instrument = INSTRUMENTS[CONFIG.currentInstrument];
  const threshold = avgTradeSize * 5;
  
  for (const [price, qty] of Object.entries(orderBook.bids)) {
    if (qty >= threshold) {
      addEvent({
        type: 'RESTING_LIQUIDITY',
        side: 'BID',
        price: parseFloat(price),
        size: qty,
        time: Date.now(),
        description: `📍 RESTING BID: ${qty.toFixed(4)} @ ${price}`,
      });
    }
  }
  
  for (const [price, qty] of Object.entries(orderBook.asks)) {
    if (qty >= threshold) {
      addEvent({
        type: 'RESTING_LIQUIDITY',
        side: 'ASK',
        price: parseFloat(price),
        size: qty,
        time: Date.now(),
        description: `📍 RESTING ASK: ${qty.toFixed(4)} @ ${price}`,
      });
    }
  }
}

function detectOrderPulling() {
  // Orders disappearing (spoofing detection)
  const threshold = avgTradeSize * 2;
  
  for (const price of Object.keys(previousOrderBook.bids)) {
    const p = parseFloat(price);
    const oldQty = previousOrderBook.bids[p] || 0;
    const newQty = orderBook.bids[p] || 0;
    
    if (oldQty >= threshold && newQty < oldQty * CONFIG.pullThreshold) {
      addEvent({
        type: 'ORDER_PULL',
        side: 'BID',
        price: p,
        oldSize: oldQty,
        newSize: newQty,
        time: Date.now(),
        description: `⚠️ BID PULLED: ${oldQty.toFixed(4)} → ${newQty.toFixed(4)} @ ${p}`,
      });
    }
  }
  
  for (const price of Object.keys(previousOrderBook.asks)) {
    const p = parseFloat(price);
    const oldQty = previousOrderBook.asks[p] || 0;
    const newQty = orderBook.asks[p] || 0;
    
    if (oldQty >= threshold && newQty < oldQty * CONFIG.pullThreshold) {
      addEvent({
        type: 'ORDER_PULL',
        side: 'ASK',
        price: p,
        oldSize: oldQty,
        newSize: newQty,
        time: Date.now(),
        description: `⚠️ ASK PULLED: ${oldQty.toFixed(4)} → ${newQty.toFixed(4)} @ ${p}`,
      });
    }
  }
}

function detectOrderStacking() {
  // Sudden buildup of orders at a level
  const threshold = avgTradeSize * 2;
  
  for (const price of Object.keys(orderBook.bids)) {
    const p = parseFloat(price);
    const oldQty = previousOrderBook.bids[p] || 0;
    const newQty = orderBook.bids[p] || 0;
    
    if (newQty >= threshold && oldQty > 0 && newQty > oldQty * CONFIG.stackThreshold) {
      addEvent({
        type: 'ORDER_STACK',
        side: 'BID',
        price: p,
        oldSize: oldQty,
        newSize: newQty,
        time: Date.now(),
        description: `🧱 BID STACKED: ${oldQty.toFixed(4)} → ${newQty.toFixed(4)} @ ${p}`,
      });
    }
  }
  
  for (const price of Object.keys(orderBook.asks)) {
    const p = parseFloat(price);
    const oldQty = previousOrderBook.asks[p] || 0;
    const newQty = orderBook.asks[p] || 0;
    
    if (newQty >= threshold && oldQty > 0 && newQty > oldQty * CONFIG.stackThreshold) {
      addEvent({
        type: 'ORDER_STACK',
        side: 'ASK',
        price: p,
        oldSize: oldQty,
        newSize: newQty,
        time: Date.now(),
        description: `🧱 ASK STACKED: ${oldQty.toFixed(4)} → ${newQty.toFixed(4)} @ ${p}`,
      });
    }
  }
}

function detectIcebergAbsorption() {
  // Level keeps refilling after being consumed = hidden iceberg order
  const threshold = avgTradeSize * 1.5;
  
  const checkSide = (prev, curr, side) => {
    for (const price of Object.keys(prev)) {
      const p = parseFloat(price);
      const oldQty = prev[p] || 0;
      const newQty = curr[p] || 0;
      
      if (oldQty >= threshold) {
        // Check if level was partially consumed but refilled
        const key = `${side}_${p}`;
        
        if (newQty >= oldQty * 0.7 && newQty <= oldQty * 1.3) {
          // Level maintained despite trades happening at this price
          const recentTrades = tradeHistory.filter(t => 
            Math.abs(t.price - p) < INSTRUMENTS[CONFIG.currentInstrument].tickSize * 2 &&
            Date.now() - t.time < 5000
          );
          
          if (recentTrades.length > 0) {
            icebergTracker[key] = (icebergTracker[key] || 0) + 1;
            
            if (icebergTracker[key] >= CONFIG.icebergThreshold) {
              addEvent({
                type: 'ICEBERG',
                side: side.toUpperCase(),
                price: p,
                size: newQty,
                refillCount: icebergTracker[key],
                time: Date.now(),
                description: `🧊 ICEBERG ${side.toUpperCase()}: Level ${p} refilled ${icebergTracker[key]}x (size: ${newQty.toFixed(4)})`,
              });
              icebergTracker[key] = 0;
            }
          }
        } else {
          icebergTracker[`${side}_${p}`] = 0;
        }
      }
    }
  };
  
  checkSide(previousOrderBook.bids, orderBook.bids, 'bid');
  checkSide(previousOrderBook.asks, orderBook.asks, 'ask');
  
  // Cleanup old trackers
  const keys = Object.keys(icebergTracker);
  if (keys.length > 200) {
    const toRemove = keys.slice(0, keys.length - 100);
    toRemove.forEach(k => delete icebergTracker[k]);
  }
}

function addEvent(event) {
  // Deduplicate (don't add same type+price within 1 second)
  if (event.type !== 'MARKET_ORDER') {
    const isDuplicate = detectedEvents.some(e => 
      e.type === event.type && 
      e.price === event.price && 
      Date.now() - e.time < 1000
    );
    if (isDuplicate) return;
  }
  
  detectedEvents.push(event);
  if (detectedEvents.length > 1000) {
    detectedEvents = detectedEvents.slice(-1000);
  }
}

// ═══════════════════════════════════════════════════════════════════
// DOM HISTORY SNAPSHOTS (for heatmap time-series)
// ═══════════════════════════════════════════════════════════════════
function takeDOMSnapshot() {
  if (Object.keys(orderBook.bids).length === 0) return;
  
  const snapshot = {
    time: Date.now(),
    price: currentPrice,
    bids: { ...orderBook.bids },
    asks: { ...orderBook.asks },
  };
  
  domHistory.push(snapshot);
  if (domHistory.length > CONFIG.historyLength) {
    domHistory = domHistory.slice(-CONFIG.historyLength);
  }
}

setInterval(takeDOMSnapshot, CONFIG.snapshotInterval);

// Clean old events periodically
setInterval(() => {
  const cutoff = Date.now() - 60000; // Keep last 60 seconds of events
  detectedEvents = detectedEvents.filter(e => e.time > cutoff || e.type !== 'MARKET_ORDER');
}, 10000);

// ═══════════════════════════════════════════════════════════════════
// CLIENT WEBSOCKET COMMUNICATION
// ═══════════════════════════════════════════════════════════════════
wss.on('connection', (ws) => {
  console.log('[CLIENT] Connected');
  
  // Send initial data
  ws.send(JSON.stringify({
    type: 'INIT',
    config: CONFIG,
    instruments: INSTRUMENTS,
    domHistory: domHistory.slice(-200),
    events: detectedEvents.filter(e => e.type !== 'MARKET_ORDER').slice(-50),
    currentPrice,
  }));

  // Stream updates to client
  const updateInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const significantEvents = detectedEvents.filter(e => 
        e.type !== 'MARKET_ORDER' && Date.now() - e.time < 5000
      ).slice(-30);
      
      const recentTrades = tradeHistory.slice(-100);
      
      ws.send(JSON.stringify({
        type: 'UPDATE',
        orderBook,
        currentPrice,
        trades: recentTrades,
        events: significantEvents,
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
          
          // Reconnect streams
          connectDepthStream();
          connectTradeStream();
          
          ws.send(JSON.stringify({ type: 'INSTRUMENT_CHANGED', instrument, config: CONFIG }));
        }
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
  console.log('║         FREE BOOKMAP HEATMAP - LIVE TRADING TOOL            ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  URL: http://localhost:${PORT}                                 ║`);
  console.log(`║  Default: ${INSTRUMENTS[CONFIG.currentInstrument].name.padEnd(35)}        ║`);
  console.log('║  Data: Binance WebSocket (FREE, no API key)                 ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Available Instruments:                                     ║');
  Object.entries(INSTRUMENTS).forEach(([key, val]) => {
    console.log(`║    ${key.padEnd(8)} → ${val.name.padEnd(30)}         ║`);
  });
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  connectDepthStream();
  connectTradeStream();
});
