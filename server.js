const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// BOOKMAP CLONE - Server with WebSocket & Market Data Simulator
// ============================================================

const PORT = 3000;

// MIME types for static file serving
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Create HTTP server for static files
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
// WebSocket Server (RFC 6455 implementation)
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

  socket.on('data', (buffer) => {
    const message = decodeWSFrame(buffer);
    if (message === null) return;
    if (message.opcode === 0x8) {
      wsClients.delete(client);
      socket.end();
      return;
    }
    if (message.opcode === 0x9) { // ping
      sendWSFrame(socket, '', 0xA); // pong
      return;
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
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  let mask = null;
  if (masked) {
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

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
// Market Data Simulator
// ============================================================
class MarketSimulator {
  constructor() {
    this.symbol = 'ES';
    this.basePrice = 5250.00;
    this.tickSize = 0.25;
    this.price = this.basePrice;
    this.bid = this.basePrice - this.tickSize;
    this.ask = this.basePrice;
    this.orderBook = { bids: {}, asks: {} };
    this.tradeId = 0;
    this.volatility = 0.0003;
    this.trend = 0;
    this.trendDuration = 0;
    this.totalVolume = 0;
    this.cvd = 0;
    this.sessionHigh = this.basePrice;
    this.sessionLow = this.basePrice;
    
    this.initOrderBook();
  }

  initOrderBook() {
    // Create realistic order book with 40 levels on each side
    for (let i = 1; i <= 40; i++) {
      const bidPrice = this.roundToTick(this.bid - (i - 1) * this.tickSize);
      const askPrice = this.roundToTick(this.ask + (i - 1) * this.tickSize);
      
      // Liquidity distribution: thicker in the middle, some large walls
      let bidQty = Math.floor(Math.random() * 200 + 50);
      let askQty = Math.floor(Math.random() * 200 + 50);
      
      // Add occasional large orders (liquidity walls)
      if (Math.random() < 0.08) bidQty = Math.floor(Math.random() * 1000 + 500);
      if (Math.random() < 0.08) askQty = Math.floor(Math.random() * 1000 + 500);
      
      this.orderBook.bids[bidPrice.toFixed(2)] = bidQty;
      this.orderBook.asks[askPrice.toFixed(2)] = askQty;
    }
  }

  roundToTick(price) {
    return Math.round(price / this.tickSize) * this.tickSize;
  }

  tick() {
    const events = [];
    
    // Update trend periodically
    this.trendDuration--;
    if (this.trendDuration <= 0) {
      this.trend = (Math.random() - 0.5) * 0.001;
      this.trendDuration = Math.floor(Math.random() * 100 + 20);
    }

    // Generate trades
    const numTrades = Math.random() < 0.3 ? Math.floor(Math.random() * 3 + 1) : 1;
    
    for (let t = 0; t < numTrades; t++) {
      const direction = Math.random() + this.trend;
      const isBuy = direction > 0.5;
      
      // Trade size with fat-tail distribution
      let size;
      const r = Math.random();
      if (r < 0.6) size = Math.floor(Math.random() * 5 + 1);
      else if (r < 0.9) size = Math.floor(Math.random() * 20 + 5);
      else if (r < 0.98) size = Math.floor(Math.random() * 50 + 20);
      else size = Math.floor(Math.random() * 200 + 50);

      const tradePrice = isBuy ? this.ask : this.bid;
      
      this.tradeId++;
      this.totalVolume += size;
      this.cvd += isBuy ? size : -size;
      
      events.push({
        type: 'trade',
        id: this.tradeId,
        price: tradePrice,
        size: size,
        side: isBuy ? 'buy' : 'sell',
        timestamp: Date.now()
      });

      // Consume liquidity from the book
      const bookSide = isBuy ? 'asks' : 'bids';
      const priceKey = tradePrice.toFixed(2);
      if (this.orderBook[bookSide][priceKey]) {
        this.orderBook[bookSide][priceKey] -= size;
        if (this.orderBook[bookSide][priceKey] <= 0) {
          delete this.orderBook[bookSide][priceKey];
          // Move price
          if (isBuy) {
            this.ask = this.roundToTick(this.ask + this.tickSize);
            this.bid = this.roundToTick(this.ask - this.tickSize);
          } else {
            this.bid = this.roundToTick(this.bid - this.tickSize);
            this.ask = this.roundToTick(this.bid + this.tickSize);
          }
        }
      }
    }

    // Update price tracking
    this.price = this.roundToTick((this.bid + this.ask) / 2);
    this.sessionHigh = Math.max(this.sessionHigh, this.ask);
    this.sessionLow = Math.min(this.sessionLow, this.bid);

    // Order book mutations (add/remove/modify orders)
    this.mutateOrderBook(events);

    // Ensure book has enough levels
    this.replenishBook();

    // Send order book snapshot periodically embedded in the update
    events.push({
      type: 'book',
      bids: this.getBookLevels('bids', 30),
      asks: this.getBookLevels('asks', 30),
      bid: this.bid,
      ask: this.ask,
      price: this.price,
      spread: this.roundToTick(this.ask - this.bid),
      totalVolume: this.totalVolume,
      cvd: this.cvd,
      sessionHigh: this.sessionHigh,
      sessionLow: this.sessionLow,
      symbol: this.symbol,
      timestamp: Date.now()
    });

    return events;
  }

  mutateOrderBook(events) {
    // Randomly add/modify/cancel orders in the book
    const mutations = Math.floor(Math.random() * 8 + 2);
    
    for (let i = 0; i < mutations; i++) {
      const side = Math.random() > 0.5 ? 'bids' : 'asks';
      const basePrice = side === 'bids' ? this.bid : this.ask;
      const offset = Math.floor(Math.random() * 30 + 1) * this.tickSize;
      const price = side === 'bids' 
        ? this.roundToTick(basePrice - offset)
        : this.roundToTick(basePrice + offset);
      const priceKey = price.toFixed(2);

      const action = Math.random();
      if (action < 0.4) {
        // Add/increase order
        const qty = Math.floor(Math.random() * 150 + 10);
        this.orderBook[side][priceKey] = (this.orderBook[side][priceKey] || 0) + qty;
      } else if (action < 0.7) {
        // Reduce order
        if (this.orderBook[side][priceKey]) {
          const reduction = Math.floor(Math.random() * 50 + 1);
          this.orderBook[side][priceKey] -= reduction;
          if (this.orderBook[side][priceKey] <= 0) {
            delete this.orderBook[side][priceKey];
          }
        }
      } else if (action < 0.85) {
        // Cancel order (spoofing simulation)
        delete this.orderBook[side][priceKey];
      } else {
        // Large order appears (iceberg/wall)
        const qty = Math.floor(Math.random() * 800 + 200);
        this.orderBook[side][priceKey] = qty;
      }
    }
  }

  replenishBook() {
    // Ensure there are always 30+ levels on each side
    const bidPrices = Object.keys(this.orderBook.bids).map(Number).sort((a, b) => b - a);
    const askPrices = Object.keys(this.orderBook.asks).map(Number).sort((a, b) => a - b);

    while (bidPrices.length < 30) {
      const lowestBid = bidPrices.length > 0 ? bidPrices[bidPrices.length - 1] : this.bid;
      const newPrice = this.roundToTick(lowestBid - this.tickSize);
      const qty = Math.floor(Math.random() * 200 + 30);
      this.orderBook.bids[newPrice.toFixed(2)] = qty;
      bidPrices.push(newPrice);
    }

    while (askPrices.length < 30) {
      const highestAsk = askPrices.length > 0 ? askPrices[askPrices.length - 1] : this.ask;
      const newPrice = this.roundToTick(highestAsk + this.tickSize);
      const qty = Math.floor(Math.random() * 200 + 30);
      this.orderBook.asks[newPrice.toFixed(2)] = qty;
      askPrices.push(newPrice);
    }
  }

  getBookLevels(side, depth) {
    const entries = Object.entries(this.orderBook[side])
      .map(([price, qty]) => [parseFloat(price), qty]);
    
    if (side === 'bids') {
      entries.sort((a, b) => b[0] - a[0]);
    } else {
      entries.sort((a, b) => a[0] - b[0]);
    }
    
    return entries.slice(0, depth);
  }
}

// ============================================================
// Start everything
// ============================================================
const simulator = new MarketSimulator();

// Broadcast market data at ~30fps (33ms intervals)
setInterval(() => {
  if (wsClients.size > 0) {
    const events = simulator.tick();
    broadcast({ events });
  }
}, 33);

server.listen(PORT, () => {
  console.log(`\n  🗺️  Bookmap Clone running at http://localhost:${PORT}\n`);
  console.log(`  Features:`);
  console.log(`  - Real-time order book heatmap visualization`);
  console.log(`  - Volume dots (trade bubbles)`);
  console.log(`  - DOM (Depth of Market) ladder`);
  console.log(`  - Volume Profile`);
  console.log(`  - CVD (Cumulative Volume Delta)`);
  console.log(`  - Interactive zoom/scroll/crosshair\n`);
});
