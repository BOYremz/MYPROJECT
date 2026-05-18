/**
 * ═══════════════════════════════════════════════════════════════════
 *  FREE BOOKMAP HEATMAP - Frontend Application
 *  Canvas-based heatmap with real-time order book visualization
 * ═══════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
const state = {
  ws: null,
  connected: false,
  currentInstrument: 'XAUUSD',
  instruments: {},
  currentPrice: 0,
  orderBook: { bids: {}, asks: {} },
  trades: [],
  events: [],
  domHistory: [], // Array of {time, price, bids:{}, asks:{}}
  
  // Heatmap settings
  priceRange: 0,
  priceCenter: 0,
  zoomLevel: 1,
  maxQty: 1,
  
  // Performance
  updateCount: 0,
  lastCountReset: Date.now(),
  updatesPerSecond: 0,
};

// ═══════════════════════════════════════════════════════════════════
// CANVAS SETUP
// ═══════════════════════════════════════════════════════════════════
const canvas = document.getElementById('heatmapCanvas');
const ctx = canvas.getContext('2d');
let canvasWidth, canvasHeight;

function resizeCanvas() {
  const container = document.getElementById('heatmapContainer');
  canvasWidth = container.clientWidth;
  canvasHeight = container.clientHeight;
  canvas.width = canvasWidth * window.devicePixelRatio;
  canvas.height = canvasHeight * window.devicePixelRatio;
  canvas.style.width = canvasWidth + 'px';
  canvas.style.height = canvasHeight + 'px';
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ═══════════════════════════════════════════════════════════════════
// WEBSOCKET CONNECTION
// ═══════════════════════════════════════════════════════════════════
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${protocol}//${location.host}`);
  
  state.ws.onopen = () => {
    state.connected = true;
    updateConnectionStatus(true);
    console.log('[WS] Connected');
  };
  
  state.ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleMessage(data);
  };
  
  state.ws.onclose = () => {
    state.connected = false;
    updateConnectionStatus(false);
    setTimeout(connect, 2000);
  };
  
  state.ws.onerror = () => {
    state.connected = false;
  };
}

function handleMessage(data) {
  state.updateCount++;
  
  switch (data.type) {
    case 'INIT':
      state.instruments = data.instruments || {};
      state.currentInstrument = data.config.currentInstrument;
      state.domHistory = data.domHistory || [];
      state.events = data.events || [];
      state.currentPrice = data.currentPrice;
      buildInstrumentButtons();
      break;
      
    case 'UPDATE':
      state.orderBook = data.orderBook;
      state.currentPrice = data.currentPrice;
      state.trades = data.trades || [];
      
      // Merge events
      if (data.events) {
        data.events.forEach(e => {
          if (!state.events.find(ex => ex.time === e.time && ex.type === e.type && ex.price === e.price)) {
            state.events.push(e);
          }
        });
        // Keep limited
        if (state.events.length > 200) state.events = state.events.slice(-200);
      }
      
      // Add to DOM history
      if (data.domSnapshot) {
        state.domHistory.push(data.domSnapshot);
        if (state.domHistory.length > 400) state.domHistory = state.domHistory.slice(-400);
      }
      
      // Auto-detect price range
      if (state.currentPrice > 0) {
        updatePriceRange();
      }
      break;
      
    case 'INSTRUMENT_CHANGED':
      state.currentInstrument = data.instrument;
      state.domHistory = [];
      state.events = [];
      state.trades = [];
      setActiveInstrument(data.instrument);
      break;
  }
}

function updatePriceRange() {
  const allPrices = [
    ...Object.keys(state.orderBook.bids).map(Number),
    ...Object.keys(state.orderBook.asks).map(Number),
  ];
  
  if (allPrices.length < 2) return;
  
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const range = maxPrice - minPrice;
  
  // Smooth transition
  const targetCenter = state.currentPrice;
  const targetRange = range * 1.2 / state.zoomLevel;
  
  state.priceCenter = state.priceCenter === 0 ? targetCenter : state.priceCenter * 0.95 + targetCenter * 0.05;
  state.priceRange = state.priceRange === 0 ? targetRange : state.priceRange * 0.98 + targetRange * 0.02;
}

// ═══════════════════════════════════════════════════════════════════
// HEATMAP RENDERING
// ═══════════════════════════════════════════════════════════════════
function renderHeatmap() {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  
  if (state.domHistory.length < 2 || state.priceRange === 0) {
    renderWaitingScreen();
    return;
  }
  
  const rightMargin = 80; // Price axis
  const drawWidth = canvasWidth - rightMargin;
  const drawHeight = canvasHeight;
  
  const priceTop = state.priceCenter + state.priceRange / 2;
  const priceBottom = state.priceCenter - state.priceRange / 2;
  
  // Calculate max quantity for color scaling
  let maxQ = 0;
  state.domHistory.forEach(snap => {
    Object.values(snap.bids).forEach(q => { if (q > maxQ) maxQ = q; });
    Object.values(snap.asks).forEach(q => { if (q > maxQ) maxQ = q; });
  });
  state.maxQty = maxQ || 1;
  
  // Draw heatmap columns (each DOM snapshot = 1 column)
  const histLen = state.domHistory.length;
  const colWidth = drawWidth / Math.min(histLen, 400);
  
  for (let i = 0; i < histLen; i++) {
    const snap = state.domHistory[i];
    const x = (i / histLen) * drawWidth;
    
    // Draw bids (green)
    for (const [price, qty] of Object.entries(snap.bids)) {
      const p = parseFloat(price);
      if (p < priceBottom || p > priceTop) continue;
      
      const y = ((priceTop - p) / state.priceRange) * drawHeight;
      const intensity = Math.min(qty / state.maxQty, 1);
      
      ctx.fillStyle = getBidColor(intensity);
      ctx.fillRect(x, y - 1, colWidth + 1, 3);
    }
    
    // Draw asks (red)
    for (const [price, qty] of Object.entries(snap.asks)) {
      const p = parseFloat(price);
      if (p < priceBottom || p > priceTop) continue;
      
      const y = ((priceTop - p) / state.priceRange) * drawHeight;
      const intensity = Math.min(qty / state.maxQty, 1);
      
      ctx.fillStyle = getAskColor(intensity);
      ctx.fillRect(x, y - 1, colWidth + 1, 3);
    }
    
    // Draw price line for this snapshot
    if (snap.price > priceBottom && snap.price < priceTop) {
      const priceY = ((priceTop - snap.price) / state.priceRange) * drawHeight;
      ctx.fillStyle = 'rgba(255, 170, 0, 0.6)';
      ctx.fillRect(x, priceY, colWidth + 1, 1);
    }
  }
  
  // Draw trade markers
  renderTrades(drawWidth, drawHeight, priceTop, priceBottom, histLen);
  
  // Draw event markers
  renderEventMarkers(drawWidth, drawHeight, priceTop, priceBottom, histLen);
  
  // Draw price axis
  renderPriceAxis(drawWidth, drawHeight, priceTop, priceBottom);
  
  // Draw time axis hint
  renderTimeAxis(drawWidth, drawHeight);
  
  // Update current price indicator position
  updatePriceIndicator(drawHeight, priceTop, priceBottom);
}

function getBidColor(intensity) {
  if (intensity < 0.1) return `rgba(0, 100, 40, ${0.1 + intensity * 2})`;
  if (intensity < 0.3) return `rgba(0, 150, 60, ${0.3 + intensity})`;
  if (intensity < 0.6) return `rgba(0, 200, 80, ${0.5 + intensity * 0.5})`;
  return `rgba(0, 255, 100, ${0.7 + intensity * 0.3})`;
}

function getAskColor(intensity) {
  if (intensity < 0.1) return `rgba(100, 20, 30, ${0.1 + intensity * 2})`;
  if (intensity < 0.3) return `rgba(180, 30, 50, ${0.3 + intensity})`;
  if (intensity < 0.6) return `rgba(220, 40, 60, ${0.5 + intensity * 0.5})`;
  return `rgba(255, 50, 70, ${0.7 + intensity * 0.3})`;
}

function renderTrades(drawWidth, drawHeight, priceTop, priceBottom, histLen) {
  if (state.trades.length === 0) return;
  
  const now = Date.now();
  const timeWindow = state.domHistory.length > 1 
    ? state.domHistory[state.domHistory.length - 1].time - state.domHistory[0].time 
    : 60000;
  const startTime = state.domHistory.length > 0 ? state.domHistory[0].time : now - timeWindow;
  
  state.trades.forEach(trade => {
    if (trade.price < priceBottom || trade.price > priceTop) return;
    
    const x = ((trade.time - startTime) / timeWindow) * drawWidth;
    if (x < 0 || x > drawWidth) return;
    
    const y = ((priceTop - trade.price) / state.priceRange) * drawHeight;
    const size = Math.max(2, Math.min(8, trade.qty / (state.maxQty * 0.1) * 4));
    
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = trade.isBuy 
      ? `rgba(0, 230, 118, 0.7)` 
      : `rgba(255, 23, 68, 0.7)`;
    ctx.fill();
  });
}

function renderEventMarkers(drawWidth, drawHeight, priceTop, priceBottom, histLen) {
  const now = Date.now();
  const timeWindow = state.domHistory.length > 1 
    ? state.domHistory[state.domHistory.length - 1].time - state.domHistory[0].time 
    : 60000;
  const startTime = state.domHistory.length > 0 ? state.domHistory[0].time : now - timeWindow;
  
  state.events.forEach(event => {
    if (!event.price || event.price < priceBottom || event.price > priceTop) return;
    
    const x = ((event.time - startTime) / timeWindow) * drawWidth;
    if (x < 0 || x > drawWidth) return;
    
    const y = ((priceTop - event.price) / state.priceRange) * drawHeight;
    
    switch (event.type) {
      case 'AGGRESSIVE_BUY':
        drawMarker(x, y, '▲', '#00e676', 12);
        break;
      case 'AGGRESSIVE_SELL':
        drawMarker(x, y, '▼', '#ff1744', 12);
        break;
      case 'ORDER_PULL':
        drawDiamond(x, y, '#ffab00', 5);
        break;
      case 'ORDER_STACK':
        drawSquare(x, y, '#7c4dff', 5);
        break;
      case 'ICEBERG':
        drawIcebergMarker(x, y);
        break;
    }
  });
}

function drawMarker(x, y, char, color, size) {
  ctx.font = `${size}px monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(char, x, y + size / 3);
}

function drawDiamond(x, y, color, size) {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

function drawSquare(x, y, color, size) {
  ctx.fillStyle = color;
  ctx.fillRect(x - size, y - size, size * 2, size * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x - size, y - size, size * 2, size * 2);
}

function drawIcebergMarker(x, y) {
  ctx.beginPath();
  ctx.moveTo(x - 5, y - 3);
  ctx.lineTo(x + 5, y - 3);
  ctx.lineTo(x + 3, y + 4);
  ctx.lineTo(x - 3, y + 4);
  ctx.closePath();
  ctx.fillStyle = '#00e5ff';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

function renderPriceAxis(drawWidth, drawHeight, priceTop, priceBottom) {
  const axisX = drawWidth;
  
  // Background
  ctx.fillStyle = 'rgba(10, 10, 18, 0.9)';
  ctx.fillRect(axisX, 0, 80, drawHeight);
  
  // Border
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(axisX, 0);
  ctx.lineTo(axisX, drawHeight);
  ctx.stroke();
  
  // Price labels
  const numLabels = Math.floor(drawHeight / 40);
  ctx.font = '10px Courier New';
  ctx.fillStyle = '#888';
  ctx.textAlign = 'left';
  
  for (let i = 0; i <= numLabels; i++) {
    const y = (i / numLabels) * drawHeight;
    const price = priceTop - (i / numLabels) * state.priceRange;
    
    // Grid line
    ctx.strokeStyle = 'rgba(50, 50, 70, 0.3)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(axisX, y);
    ctx.stroke();
    
    // Price text
    ctx.fillStyle = '#888';
    ctx.fillText(formatPrice(price), axisX + 4, y + 3);
  }
}

function renderTimeAxis(drawWidth, drawHeight) {
  if (state.domHistory.length < 2) return;
  
  const startTime = state.domHistory[0].time;
  const endTime = state.domHistory[state.domHistory.length - 1].time;
  const duration = endTime - startTime;
  
  ctx.font = '9px Courier New';
  ctx.fillStyle = '#444';
  ctx.textAlign = 'center';
  
  const numLabels = 6;
  for (let i = 0; i <= numLabels; i++) {
    const x = (i / numLabels) * drawWidth;
    const time = new Date(startTime + (i / numLabels) * duration);
    const label = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    ctx.fillText(label, x, drawHeight - 4);
  }
}

function renderWaitingScreen() {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  
  ctx.font = '16px Courier New';
  ctx.fillStyle = '#00e5ff';
  ctx.textAlign = 'center';
  ctx.fillText('Connecting to live market data...', canvasWidth / 2, canvasHeight / 2 - 20);
  
  ctx.font = '12px Courier New';
  ctx.fillStyle = '#555';
  ctx.fillText('Building heatmap history - please wait 5-10 seconds', canvasWidth / 2, canvasHeight / 2 + 10);
}

function updatePriceIndicator(drawHeight, priceTop, priceBottom) {
  if (state.currentPrice === 0 || state.priceRange === 0) return;
  
  const y = ((priceTop - state.currentPrice) / state.priceRange) * drawHeight;
  const priceLine = document.getElementById('currentPriceLine');
  const priceTag = document.getElementById('currentPriceTag');
  
  priceLine.style.top = y + 48 + 'px'; // offset for top bar
  priceTag.style.top = y + 48 + 'px';
  priceTag.textContent = formatPrice(state.currentPrice);
}

// ═══════════════════════════════════════════════════════════════════
// DOM LADDER RENDERING
// ═══════════════════════════════════════════════════════════════════
function renderDOMLadder() {
  const container = document.getElementById('domLadder');
  if (!state.currentPrice || Object.keys(state.orderBook.bids).length === 0) return;
  
  const bids = Object.entries(state.orderBook.bids)
    .map(([p, q]) => ({ price: parseFloat(p), qty: q }))
    .sort((a, b) => b.price - a.price)
    .slice(0, 12);
    
  const asks = Object.entries(state.orderBook.asks)
    .map(([p, q]) => ({ price: parseFloat(p), qty: q }))
    .sort((a, b) => a.price - b.price)
    .slice(0, 12);
  
  const maxQty = Math.max(
    ...bids.map(b => b.qty),
    ...asks.map(a => a.qty),
    1
  );
  
  let html = '';
  
  // Asks (top, reversed so highest is on top)
  asks.reverse().forEach(level => {
    const pct = (level.qty / maxQty) * 100;
    html += `<div class="dom-row">
      <div class="qty-bid"></div>
      <div class="price-cell" style="color:#ff5555">${formatPrice(level.price)}</div>
      <div class="qty-ask">${level.qty.toFixed(4)}</div>
      <div class="ask-bar" style="width:${pct * 0.5}%"></div>
    </div>`;
  });
  
  // Spread row
  if (bids.length > 0 && asks.length > 0) {
    const spread = asks[asks.length - 1].price - bids[0].price;
    html += `<div class="dom-row" style="background:#1a1a2e; height:24px;">
      <div></div>
      <div class="price-cell" style="color:#ffaa00; font-size:9px;">SPREAD: ${formatPrice(spread)}</div>
      <div></div>
    </div>`;
  }
  
  // Bids (bottom)
  bids.forEach(level => {
    const pct = (level.qty / maxQty) * 100;
    html += `<div class="dom-row">
      <div class="qty-bid">${level.qty.toFixed(4)}</div>
      <div class="price-cell" style="color:#55ff55">${formatPrice(level.price)}</div>
      <div class="qty-ask"></div>
      <div class="bid-bar" style="width:${pct * 0.5}%"></div>
    </div>`;
  });
  
  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════
// EVENTS LOG
// ═══════════════════════════════════════════════════════════════════
function renderEvents() {
  const container = document.getElementById('eventsLog');
  const significantEvents = state.events
    .filter(e => e.type !== 'MARKET_ORDER' && e.type !== 'RESTING_LIQUIDITY')
    .slice(-30)
    .reverse();
  
  let html = '';
  significantEvents.forEach(event => {
    let className = '';
    let text = '';
    const time = new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    switch (event.type) {
      case 'AGGRESSIVE_BUY':
        className = 'aggressive-buy';
        text = `${time} 🟢 AGG BUY ${event.size.toFixed(4)} @ ${formatPrice(event.price)}`;
        break;
      case 'AGGRESSIVE_SELL':
        className = 'aggressive-sell';
        text = `${time} 🔴 AGG SELL ${event.size.toFixed(4)} @ ${formatPrice(event.price)}`;
        break;
      case 'ORDER_PULL':
        className = 'order-pull';
        text = `${time} ⚠️ ${event.side} PULLED @ ${formatPrice(event.price)}`;
        break;
      case 'ORDER_STACK':
        className = 'order-stack';
        text = `${time} 🧱 ${event.side} STACKED @ ${formatPrice(event.price)}`;
        break;
      case 'ICEBERG':
        className = 'iceberg';
        text = `${time} 🧊 ICEBERG ${event.side} @ ${formatPrice(event.price)} (${event.refillCount}x)`;
        break;
      default:
        className = 'resting';
        text = `${time} ${event.description || event.type}`;
    }
    
    html += `<div class="event-item ${className}">${text}</div>`;
  });
  
  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════
// STATS PANEL
// ═══════════════════════════════════════════════════════════════════
function renderStats() {
  const bidVol = Object.values(state.orderBook.bids).reduce((a, b) => a + b, 0);
  const askVol = Object.values(state.orderBook.asks).reduce((a, b) => a + b, 0);
  
  const recentBuys = state.trades.filter(t => t.isBuy && Date.now() - t.time < 10000);
  const recentSells = state.trades.filter(t => !t.isBuy && Date.now() - t.time < 10000);
  const buyPower = recentBuys.reduce((a, t) => a + t.qty, 0);
  const sellPower = recentSells.reduce((a, t) => a + t.qty, 0);
  
  const bidPrices = Object.keys(state.orderBook.bids).map(Number);
  const askPrices = Object.keys(state.orderBook.asks).map(Number);
  const spread = bidPrices.length > 0 && askPrices.length > 0 
    ? Math.min(...askPrices) - Math.max(...bidPrices) : 0;
  
  const totalVol = bidVol + askVol;
  const imbalance = totalVol > 0 ? ((bidVol - askVol) / totalVol * 100).toFixed(1) : 0;
  
  document.getElementById('statBidVol').textContent = bidVol.toFixed(2);
  document.getElementById('statAskVol').textContent = askVol.toFixed(2);
  document.getElementById('statBuyPwr').textContent = buyPower.toFixed(3);
  document.getElementById('statSellPwr').textContent = sellPower.toFixed(3);
  document.getElementById('statSpread').textContent = formatPrice(spread);
  
  const imbalEl = document.getElementById('statImbalance');
  imbalEl.textContent = imbalance + '%';
  imbalEl.style.color = imbalance > 0 ? '#00c853' : imbalance < 0 ? '#ff3547' : '#fff';
  
  // Price display
  document.getElementById('priceValue').textContent = formatPrice(state.currentPrice);
  
  // Updates per second
  const now = Date.now();
  if (now - state.lastCountReset > 1000) {
    state.updatesPerSecond = state.updateCount;
    state.updateCount = 0;
    state.lastCountReset = now;
  }
  
  document.getElementById('statusUpdates').textContent = `${state.updatesPerSecond} updates/s`;
  document.getElementById('statusEvents').textContent = `${state.events.filter(e => e.type !== 'MARKET_ORDER').length} events`;
}

// ═══════════════════════════════════════════════════════════════════
// INSTRUMENT BUTTONS
// ═══════════════════════════════════════════════════════════════════
function buildInstrumentButtons() {
  const container = document.getElementById('instrumentButtons');
  container.innerHTML = '';
  
  Object.entries(state.instruments).forEach(([key, info]) => {
    const btn = document.createElement('button');
    btn.className = 'instrument-btn' + (key === state.currentInstrument ? ' active' : '');
    btn.textContent = key;
    btn.title = info.name;
    btn.onclick = () => switchInstrument(key);
    container.appendChild(btn);
  });
  
  document.getElementById('statusInstrument').textContent = 
    state.instruments[state.currentInstrument]?.name || state.currentInstrument;
}

function switchInstrument(instrument) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'CHANGE_INSTRUMENT', instrument }));
    state.currentInstrument = instrument;
    state.domHistory = [];
    state.events = [];
    state.priceRange = 0;
    state.priceCenter = 0;
    setActiveInstrument(instrument);
    document.getElementById('statusInstrument').textContent = 
      state.instruments[instrument]?.name || instrument;
  }
}

function setActiveInstrument(instrument) {
  document.querySelectorAll('.instrument-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === instrument);
  });
}

// ═══════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════
function formatPrice(price) {
  if (price === 0 || price === undefined) return '--';
  if (price > 1000) return price.toFixed(2);
  if (price > 1) return price.toFixed(4);
  return price.toFixed(6);
}

function updateConnectionStatus(connected) {
  const dot = document.getElementById('connectionDot');
  const text = document.getElementById('connectionStatus');
  
  if (connected) {
    dot.classList.add('connected');
    text.textContent = 'Live';
  } else {
    dot.classList.remove('connected');
    text.textContent = 'Reconnecting...';
  }
}

// ═══════════════════════════════════════════════════════════════════
// ZOOM CONTROLS (mouse wheel)
// ═══════════════════════════════════════════════════════════════════
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.deltaY < 0) {
    state.zoomLevel = Math.min(state.zoomLevel * 1.1, 10);
  } else {
    state.zoomLevel = Math.max(state.zoomLevel / 1.1, 0.3);
  }
});

// ═══════════════════════════════════════════════════════════════════
// MAIN RENDER LOOP
// ═══════════════════════════════════════════════════════════════════
function mainLoop() {
  renderHeatmap();
  renderDOMLadder();
  renderEvents();
  renderStats();
  requestAnimationFrame(mainLoop);
}

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════
connect();
mainLoop();

console.log('%c FREE BOOKMAP HEATMAP ', 'background: #00e5ff; color: #000; font-size: 14px; font-weight: bold;');
console.log('%c Connected to live market data - No subscription needed! ', 'color: #00e676;');
