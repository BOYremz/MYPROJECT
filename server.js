const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// BOOKMAP CLONE - LIVE MARKET DATA
// Requires Node.js v22+ (uses built-in WebSocket)
// Zero npm dependencies
// ============================================================

const nodeVersion = parseInt(process.versions.node.split('.')[0]);
if (nodeVersion < 21) {
  console.error(`\n  ERROR: Node.js v22+ required (you have v${process.versions.node})`);
  console.error(`  Built-in WebSocket is needed for Binance connection.\n`);
  process.exit(1);
}

const PORT = 3000;

// MIME types
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ============================================================
// HTTP Server (static files)
// ============================================================
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ============================================================
// WebSocket Server (RFC 6455)
// ============================================================
const wsClients = new Set();

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB4C4F97C13')
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    ''
  ].join('\r\n');

  socket.write(headers);

  const client = { socket, alive: true };
  wsClients.add(client);
  
  // Send init data to new client
  try {
    sendWSFrame(socket, JSON.stringify({
      type: 'init',
      instruments: INSTRUMENTS,
      activeSymbol: activeSymbol,
      tickSize: INSTRUMENTS[activeSymbol].tickSize
    }));
  } catch (e) { /* ignore */ }

  socket.on('data', (buffer) => {
    const message = decodeWSFrame(buffer);
    if (message === null) return;
    if (message.opcode === 0x8) {
      wsClients.delete(client);
      socket.end();
      return;
    }
    if (message.opcode === 0x9) {
      sendWSFrame(socket, '', 0xA);
      return;
    }
    // Handle text messages from client
    if (message.opcode === 0x1) {
      try {
        const msg = JSON.parse(message.payload);
        if (msg.type === 'switch_instrument' && msg.symbol) {
          switchInstrument(msg.symbol);
        }
      } catch (e) { /* ignore */ }
    }
  });

  socket.on('close', () => wsClients.delete(client));
  socket.on('error', () => wsClients.delete(client));
});

function decodeWSFrame(buffer) {
  if (buffer.length < 2) return null;
  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const opcode = firstByte & 0x0F;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7F;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) return null;
  const payload = buffer.slice(offset, offset + payloadLength);
  if (masked && mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }

  return { opcode, payload: payload.toString('utf8') };
}

function sendWSFrame(socket, data, opcode = 0x1) {
  const payload = Buffer.from(data, 'utf8');
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  try {
    socket.write(Buffer.concat([header, payload]));
  } catch (e) { /* client disconnected */ }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wsClients) {
    try {
      sendWSFrame(client.socket, msg);
    } catch (e) {
      wsClients.delete(client);
    }
  }
}

// ============================================================
// Multi-Instrument Support
// ============================================================

const INSTRUMENTS = {
  'XAUUSD': { binance: 'paxgusdt', name: 'Gold / XAUUSD', tickSize: 0.01 },
  'BTCUSD': { binance: 'btcusdt', name: 'Bitcoin / USD', tickSize: 0.01 },
  'ETHUSD': { binance: 'ethusdt', name: 'Ethereum / USD', tickSize: 0.01 },
  'SOLUSD': { binance: 'solusdt', name: 'Solana / USD', tickSize: 0.001 },
  'BNBUSD': { binance: 'bnbusdt', name: 'BNB / USD (NAS100 proxy)', tickSize: 0.01 },
  'XRPUSD': { binance: 'xrpusdt', name: 'XRP / USD', tickSize: 0.0001 },
};

let activeSymbol = 'XAUUSD';
let activeBinanceSymbol = INSTRUMENTS[activeSymbol].binance;

// Market state
let orderBook = { bids: {}, asks: {} };
let currentPrice = 0;
let totalVolume = 0;
let cvd = 0;
let sessionHigh = 0;
let sessionLow = Infinity;
let openPrice = 0;
let tradeId = 0;
let binanceConnected = false;

// Active stream connections (so we can close & reopen on instrument change)
let activeDepthSocket = null;
let activeTradeSocket = null;

// Buffers for client updates
let pendingTrades = [];
let lastBookBroadcast = 0;

// ============================================================
// Connect to Binance using Node.js built-in WebSocket
// ============================================================
function connectDepthStream() {
  const symbol = activeBinanceSymbol;
  const url = `wss://stream.binance.com:9443/ws/${symbol}@depth20@100ms`;
  
  console.log(`[WS] Connecting depth: ${symbol}...`);
  
  try {
    const ws = new WebSocket(url);
    activeDepthSocket = ws;
    
    ws.addEventListener('open', () => {
      console.log(`[WS] Depth connected (${symbol})`);
      binanceConnected = true;
    });
    
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.bids && msg.asks) {
          orderBook.bids = {};
          orderBook.asks = {};
          
          msg.bids.forEach(([price, qty]) => {
            const p = parseFloat(price);
            const q = parseFloat(qty);
            if (q > 0) orderBook.bids[p.toFixed(2)] = q;
          });
          
          msg.asks.forEach(([price, qty]) => {
            const p = parseFloat(price);
            const q = parseFloat(qty);
            if (q > 0) orderBook.asks[p.toFixed(2)] = q;
          });
          
          const bidPrices = Object.keys(orderBook.bids).map(Number);
          const askPrices = Object.keys(orderBook.asks).map(Number);
          if (bidPrices.length && askPrices.length) {
            const bestBid = Math.max(...bidPrices);
            const bestAsk = Math.min(...askPrices);
            currentPrice = (bestBid + bestAsk) / 2;
            
            if (openPrice === 0) openPrice = currentPrice;
            sessionHigh = Math.max(sessionHigh, bestAsk);
            if (sessionLow === Infinity) sessionLow = bestBid;
            sessionLow = Math.min(sessionLow, bestBid);
          }
        }
      } catch (e) { /* ignore */ }
    });
    
    ws.addEventListener('close', () => {
      console.log('[WS] Depth disconnected, reconnecting...');
      binanceConnected = false;
      setTimeout(connectDepthStream, 3000);
    });
    
    ws.addEventListener('error', (err) => {
      console.log('[WS] Depth error');
    });
  } catch (e) {
    console.log('[WS] Depth connection failed:', e.message);
    setTimeout(connectDepthStream, 5000);
  }
}

function connectTradeStream() {
  const symbol = activeBinanceSymbol;
  const url = `wss://stream.binance.com:9443/ws/${symbol}@aggTrade`;
  
  console.log(`[WS] Connecting trades: ${symbol}...`);
  
  try {
    const ws = new WebSocket(url);
    activeTradeSocket = ws;
    
    ws.addEventListener('open', () => {
      console.log(`[WS] Trades connected (${symbol})`);
    });
    
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        const price = parseFloat(msg.p);
        const qty = parseFloat(msg.q);
        const isBuy = !msg.m;
        const timestamp = msg.T || Date.now();
        
        tradeId++;
        totalVolume += qty;
        cvd += isBuy ? qty : -qty;
        currentPrice = price;
        
        if (openPrice === 0) openPrice = price;
        sessionHigh = Math.max(sessionHigh, price);
        if (sessionLow === Infinity) sessionLow = price;
        sessionLow = Math.min(sessionLow, price);
        
        pendingTrades.push({
          type: 'trade',
          id: tradeId,
          price: price,
          size: qty,
          side: isBuy ? 'buy' : 'sell',
          timestamp: timestamp
        });
      } catch (e) { /* ignore */ }
    });
    
    ws.addEventListener('close', () => {
      console.log('[WS] Trades disconnected, reconnecting...');
      setTimeout(connectTradeStream, 3000);
    });
    
    ws.addEventListener('error', (err) => {
      console.log('[WS] Trades error');
    });
  } catch (e) {
    console.log('[WS] Trade connection failed:', e.message);
    setTimeout(connectTradeStream, 5000);
  }
}

// ============================================================
// Switch Instrument
// ============================================================
function switchInstrument(symbol) {
  if (!INSTRUMENTS[symbol]) return;
  if (symbol === activeSymbol) return;
  
  console.log(`[SWITCH] Changing to ${symbol} (${INSTRUMENTS[symbol].binance})`);
  
  // Close existing connections
  if (activeDepthSocket) { try { activeDepthSocket.close(); } catch(e){} }
  if (activeTradeSocket) { try { activeTradeSocket.close(); } catch(e){} }
  
  activeSymbol = symbol;
  activeBinanceSymbol = INSTRUMENTS[symbol].binance;
  
  // Reset state
  orderBook = { bids: {}, asks: {} };
  currentPrice = 0;
  totalVolume = 0;
  cvd = 0;
  sessionHigh = 0;
  sessionLow = Infinity;
  openPrice = 0;
  pendingTrades = [];
  binanceConnected = false;
  
  // Reconnect streams
  setTimeout(() => {
    connectDepthStream();
    connectTradeStream();
  }, 500);
  
  // Notify clients
  broadcast({
    type: 'instrument_changed',
    symbol: activeSymbol,
    name: INSTRUMENTS[symbol].name,
    tickSize: INSTRUMENTS[symbol].tickSize
  });
}

// ============================================================
// Broadcast to frontend clients at 30fps
// ============================================================
setInterval(() => {
  if (wsClients.size === 0) return;
  if (!currentPrice) return;
  
  const events = [...pendingTrades];
  pendingTrades = [];
  
  // Build book snapshot
  const bidEntries = Object.entries(orderBook.bids)
    .map(([p, q]) => [parseFloat(p), q])
    .sort((a, b) => b[0] - a[0])
    .slice(0, 30);
  
  const askEntries = Object.entries(orderBook.asks)
    .map(([p, q]) => [parseFloat(p), q])
    .sort((a, b) => a[0] - b[0])
    .slice(0, 30);
  
  const bestBid = bidEntries.length ? bidEntries[0][0] : currentPrice - 0.01;
  const bestAsk = askEntries.length ? askEntries[0][0] : currentPrice + 0.01;
  
  events.push({
    type: 'book',
    bids: bidEntries,
    asks: askEntries,
    bid: bestBid,
    ask: bestAsk,
    price: currentPrice,
    spread: parseFloat((bestAsk - bestBid).toFixed(2)),
    totalVolume: parseFloat(totalVolume.toFixed(4)),
    cvd: parseFloat(cvd.toFixed(4)),
    sessionHigh: sessionHigh,
    sessionLow: sessionLow === Infinity ? currentPrice : sessionLow,
    symbol: activeSymbol,
    timestamp: Date.now()
  });
  
  broadcast({ events });
}, 33);

// ============================================================
// Fallback: REST polling if WebSocket fails
// ============================================================
async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function restFallback() {
  if (binanceConnected) return;
  
  const symbol = activeBinanceSymbol.toUpperCase();
  
  try {
    // Fetch order book
    const depth = await fetchJSON(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`);
    if (depth.bids && depth.asks) {
      orderBook.bids = {};
      orderBook.asks = {};
      depth.bids.forEach(([p, q]) => {
        if (parseFloat(q) > 0) orderBook.bids[parseFloat(p).toFixed(2)] = parseFloat(q);
      });
      depth.asks.forEach(([p, q]) => {
        if (parseFloat(q) > 0) orderBook.asks[parseFloat(p).toFixed(2)] = parseFloat(q);
      });
    }
    
    // Fetch recent trades
    const trades = await fetchJSON(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=50`);
    if (Array.isArray(trades)) {
      trades.forEach(t => {
        const price = parseFloat(t.price);
        const qty = parseFloat(t.qty);
        const isBuy = !t.isBuyerMaker;
        
        tradeId++;
        totalVolume += qty;
        cvd += isBuy ? qty : -qty;
        currentPrice = price;
        
        if (openPrice === 0) openPrice = price;
        sessionHigh = Math.max(sessionHigh, price);
        if (sessionLow === Infinity) sessionLow = price;
        sessionLow = Math.min(sessionLow, price);
        
        pendingTrades.push({
          type: 'trade',
          id: tradeId,
          price,
          size: qty,
          side: isBuy ? 'buy' : 'sell',
          timestamp: t.time || Date.now()
        });
      });
    }
    
    console.log(`[REST] Fallback poll (${activeSymbol}): price=${currentPrice.toFixed(2)}`);
  } catch (e) {
    console.log(`[REST] Error: ${e.message}`);
  }
}

// Poll every 2s as fallback when WS is down
setInterval(restFallback, 2000);

// ============================================================
// Start
// ============================================================
server.listen(PORT, () => {
  console.log(`\n  BOOKMAP CLONE - LIVE MARKET DATA`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  URL: http://localhost:${PORT}`);
  console.log(`  Default: ${activeSymbol} (${INSTRUMENTS[activeSymbol].name})`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Available instruments:`);
  Object.entries(INSTRUMENTS).forEach(([sym, info]) => {
    console.log(`    ${sym.padEnd(8)} → ${info.name} (${info.binance.toUpperCase()})`);
  });
  console.log(`  ─────────────────────────────────`);
  console.log(`  Features:`);
  console.log(`  • Real-time order book heatmap`);
  console.log(`  • Volume dots (live trades)`);
  console.log(`  • DOM ladder`);
  console.log(`  • Volume Profile + CVD`);
  console.log(`  • Multi-instrument switching`);
  console.log(`  • Simulated order entry`);
  console.log(`  ─────────────────────────────────\n`);
  
  // Connect to Binance live streams
  connectDepthStream();
  connectTradeStream();
  
  // Initial REST load
  restFallback();
});
