// ============================================================
// BOOKMAP CLONE - Frontend Application
// Order Flow Visualization Engine
// ============================================================

'use strict';

// ===== STATE =====
const state = {
  connected: false,
  // Price/book data
  currentPrice: 0,
  bid: 0,
  ask: 0,
  spread: 0,
  symbol: 'ES',
  totalVolume: 0,
  cvd: 0,
  sessionHigh: 0,
  sessionLow: 0,
  openPrice: 5250.00,
  
  // Heatmap settings
  pixelsPerTick: 8,
  tickSize: 0.25,
  scrollSpeed: 2,
  maxHistory: 800,
  
  // Interaction
  mouseX: -1,
  mouseY: -1,
  isDragging: false,
  priceOffset: 0,
  
  // Data buffers
  heatmapColumns: [],    // Array of { timestamp, bids: Map, asks: Map }
  trades: [],            // Array of { price, size, side, timestamp, x }
  volumeProfile: {},     // price -> { buyVol, sellVol }
  cvdHistory: [],        // Array of cvd values
  bookSnapshot: null,    // Latest order book
  
  // DOM
  domBids: [],
  domAsks: [],
  
  // Animation
  frameCount: 0,
  lastFrameTime: 0
};

// ===== CANVAS REFERENCES =====
let heatmapCanvas, heatmapCtx;
let priceCanvas, priceCtx;
let vpCanvas, vpCtx;
let cvdCanvas, cvdCtx;

// ===== INITIALIZATION =====
function init() {
  setupCanvases();
  connectWebSocket();
  setupInteraction();
  requestAnimationFrame(renderLoop);
}

function setupCanvases() {
  heatmapCanvas = document.getElementById('heatmap-canvas');
  heatmapCtx = heatmapCanvas.getContext('2d');
  
  priceCanvas = document.getElementById('price-canvas');
  priceCtx = priceCanvas.getContext('2d');
  
  vpCanvas = document.getElementById('vp-canvas');
  vpCtx = vpCanvas.getContext('2d');
  
  cvdCanvas = document.getElementById('cvd-canvas');
  cvdCtx = cvdCanvas.getContext('2d');
  
  resizeCanvases();
  window.addEventListener('resize', resizeCanvases);
}

function resizeCanvases() {
  const container = document.getElementById('heatmap-container');
  const bottomPanel = document.getElementById('bottom-panel');
  const heatH = container.clientHeight - bottomPanel.clientHeight;
  
  heatmapCanvas.width = container.clientWidth;
  heatmapCanvas.height = heatH;
  
  const priceAxisEl = document.getElementById('price-axis');
  priceCanvas.width = priceAxisEl.clientWidth;
  priceCanvas.height = heatH;
  
  const vpEl = document.getElementById('volume-profile');
  vpCanvas.width = vpEl.clientWidth;
  vpCanvas.height = vpEl.clientHeight;
  
  cvdCanvas.width = bottomPanel.clientWidth;
  cvdCanvas.height = bottomPanel.clientHeight;
}



// ===== WEBSOCKET CONNECTION =====
let ws = null;

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  
  ws.onopen = () => {
    state.connected = true;
    document.getElementById('connection-status').className = 'connected';
    document.getElementById('connection-status').textContent = 'Connected';
    document.getElementById('tb-status').textContent = 'Live';
  };
  
  ws.onclose = () => {
    state.connected = false;
    document.getElementById('connection-status').className = 'disconnected';
    document.getElementById('connection-status').textContent = 'Disconnected';
    document.getElementById('tb-status').textContent = 'Offline';
    setTimeout(connectWebSocket, 2000);
  };
  
  ws.onerror = () => {
    ws.close();
  };
  
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      processMarketData(data);
    } catch (e) { /* ignore parse errors */ }
  };
}

// ===== MARKET DATA PROCESSING =====
function processMarketData(data) {
  if (!data.events) return;
  
  let bookUpdate = null;
  const newTrades = [];
  
  for (const evt of data.events) {
    if (evt.type === 'trade') {
      newTrades.push(evt);
      
      // Update volume profile
      const priceKey = evt.price.toFixed(2);
      if (!state.volumeProfile[priceKey]) {
        state.volumeProfile[priceKey] = { buyVol: 0, sellVol: 0 };
      }
      if (evt.side === 'buy') {
        state.volumeProfile[priceKey].buyVol += evt.size;
      } else {
        state.volumeProfile[priceKey].sellVol += evt.size;
      }
    } else if (evt.type === 'book') {
      bookUpdate = evt;
    }
  }
  
  // Process book update
  if (bookUpdate) {
    state.currentPrice = bookUpdate.price;
    state.bid = bookUpdate.bid;
    state.ask = bookUpdate.ask;
    state.spread = bookUpdate.spread;
    state.totalVolume = bookUpdate.totalVolume;
    state.cvd = bookUpdate.cvd;
    state.sessionHigh = bookUpdate.sessionHigh;
    state.sessionLow = bookUpdate.sessionLow;
    state.symbol = bookUpdate.symbol;
    state.bookSnapshot = bookUpdate;
    
    // Set open price on first update
    if (state.openPrice === 5250.00 && bookUpdate.price) {
      state.openPrice = bookUpdate.price;
    }
    
    // Store heatmap column
    const column = {
      timestamp: bookUpdate.timestamp,
      bids: new Map(),
      asks: new Map()
    };
    
    for (const [price, qty] of bookUpdate.bids) {
      column.bids.set(price.toFixed(2), qty);
    }
    for (const [price, qty] of bookUpdate.asks) {
      column.asks.set(price.toFixed(2), qty);
    }
    
    state.heatmapColumns.push(column);
    if (state.heatmapColumns.length > state.maxHistory) {
      state.heatmapColumns.shift();
    }
    
    // Store CVD history
    state.cvdHistory.push(bookUpdate.cvd);
    if (state.cvdHistory.length > state.maxHistory) {
      state.cvdHistory.shift();
    }
    
    // DOM data
    state.domBids = bookUpdate.bids;
    state.domAsks = bookUpdate.asks;
  }
  
  // Process trades
  for (const trade of newTrades) {
    state.trades.push({
      ...trade,
      column: state.heatmapColumns.length - 1
    });
  }
  
  // Limit trades buffer
  if (state.trades.length > 2000) {
    state.trades = state.trades.slice(-1500);
  }
  
  // Update toolbar
  updateToolbar();
}

function updateToolbar() {
  document.getElementById('tb-symbol').textContent = state.symbol;
  document.getElementById('tb-last').textContent = state.currentPrice.toFixed(2);
  document.getElementById('tb-bid').textContent = state.bid.toFixed(2);
  document.getElementById('tb-ask').textContent = state.ask.toFixed(2);
  document.getElementById('tb-spread').textContent = state.spread.toFixed(2);
  document.getElementById('tb-volume').textContent = formatNumber(state.totalVolume);
  document.getElementById('tb-high').textContent = state.sessionHigh.toFixed(2);
  document.getElementById('tb-low').textContent = state.sessionLow.toFixed(2);
  
  const change = state.currentPrice - state.openPrice;
  const changeEl = document.getElementById('tb-change');
  const container = document.getElementById('tb-change-container');
  changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2);
  container.className = 'toolbar-item ' + (change >= 0 ? 'positive' : 'negative');
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}



// ===== RENDER LOOP =====
function renderLoop(timestamp) {
  const dt = timestamp - state.lastFrameTime;
  state.lastFrameTime = timestamp;
  state.frameCount++;
  
  renderHeatmap();
  renderPriceAxis();
  renderVolumeProfile();
  renderCVD();
  
  // Update DOM ladder at lower frequency
  if (state.frameCount % 3 === 0) {
    renderDOM();
  }
  
  requestAnimationFrame(renderLoop);
}

// ===== HEATMAP RENDERING =====
function renderHeatmap() {
  const ctx = heatmapCtx;
  const W = heatmapCanvas.width;
  const H = heatmapCanvas.height;
  
  if (W === 0 || H === 0) return;
  
  // Clear
  ctx.fillStyle = '#0d0d1a';
  ctx.fillRect(0, 0, W, H);
  
  if (state.heatmapColumns.length === 0) {
    ctx.fillStyle = '#404060';
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for market data...', W / 2, H / 2);
    return;
  }
  
  const ppt = state.pixelsPerTick;
  const tickSize = state.tickSize;
  const centerPrice = state.currentPrice + state.priceOffset;
  const centerY = H / 2;
  
  // Calculate visible price range
  const priceRange = (H / ppt) * tickSize;
  const topPrice = centerPrice + priceRange / 2;
  const bottomPrice = centerPrice - priceRange / 2;
  
  // Column width
  const colWidth = Math.max(2, Math.floor(W / Math.min(state.heatmapColumns.length, state.maxHistory)));
  const visibleColumns = Math.min(state.heatmapColumns.length, Math.floor(W / colWidth));
  const startCol = Math.max(0, state.heatmapColumns.length - visibleColumns);
  
  // Find max quantity for color scaling
  let maxQty = 100;
  for (let i = startCol; i < state.heatmapColumns.length; i++) {
    const col = state.heatmapColumns[i];
    for (const qty of col.bids.values()) maxQty = Math.max(maxQty, qty);
    for (const qty of col.asks.values()) maxQty = Math.max(maxQty, qty);
  }
  
  // Draw heatmap columns
  for (let i = startCol; i < state.heatmapColumns.length; i++) {
    const col = state.heatmapColumns[i];
    const x = (i - startCol) * colWidth;
    
    // Draw bids (below/at bid)
    for (const [priceStr, qty] of col.bids) {
      const price = parseFloat(priceStr);
      if (price < bottomPrice || price > topPrice) continue;
      
      const y = centerY - ((price - centerPrice) / tickSize) * ppt;
      const intensity = Math.min(qty / maxQty, 1);
      const color = getHeatColor(intensity, 'bid');
      
      ctx.fillStyle = color;
      ctx.fillRect(x, y - ppt / 2, colWidth - 1, ppt);
    }
    
    // Draw asks (above/at ask)
    for (const [priceStr, qty] of col.asks) {
      const price = parseFloat(priceStr);
      if (price < bottomPrice || price > topPrice) continue;
      
      const y = centerY - ((price - centerPrice) / tickSize) * ppt;
      const intensity = Math.min(qty / maxQty, 1);
      const color = getHeatColor(intensity, 'ask');
      
      ctx.fillStyle = color;
      ctx.fillRect(x, y - ppt / 2, colWidth - 1, ppt);
    }
  }
  
  // Draw price line (current price)
  const priceY = centerY - ((state.currentPrice - centerPrice) / tickSize) * ppt;
  ctx.strokeStyle = 'rgba(79, 195, 247, 0.6)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, priceY);
  ctx.lineTo(W, priceY);
  ctx.stroke();
  ctx.setLineDash([]);
  
  // Draw bid/ask lines
  const bidY = centerY - ((state.bid - centerPrice) / tickSize) * ppt;
  const askY = centerY - ((state.ask - centerPrice) / tickSize) * ppt;
  
  ctx.strokeStyle = 'rgba(76, 175, 80, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, bidY);
  ctx.lineTo(W, bidY);
  ctx.stroke();
  
  ctx.strokeStyle = 'rgba(244, 67, 54, 0.5)';
  ctx.beginPath();
  ctx.moveTo(0, askY);
  ctx.lineTo(W, askY);
  ctx.stroke();
  
  // Draw volume dots (trades)
  renderVolumeDots(ctx, startCol, colWidth, centerPrice, centerY, ppt, tickSize);
  
  // Draw crosshair
  renderCrosshair(ctx, W, H, centerPrice, centerY, ppt, tickSize);
  
  // Draw grid lines
  renderGrid(ctx, W, H, centerPrice, centerY, ppt, tickSize);
}

// ===== HEATMAP COLOR FUNCTION =====
function getHeatColor(intensity, side) {
  // Creates a gradient from dark to bright
  // Bid: dark blue -> cyan -> white
  // Ask: dark red -> orange -> yellow -> white
  
  if (side === 'bid') {
    if (intensity < 0.2) {
      const t = intensity / 0.2;
      return `rgba(0, ${Math.floor(30 + t * 50)}, ${Math.floor(60 + t * 80)}, ${0.3 + t * 0.3})`;
    } else if (intensity < 0.5) {
      const t = (intensity - 0.2) / 0.3;
      return `rgba(0, ${Math.floor(80 + t * 100)}, ${Math.floor(140 + t * 60)}, ${0.6 + t * 0.2})`;
    } else if (intensity < 0.8) {
      const t = (intensity - 0.5) / 0.3;
      return `rgba(${Math.floor(t * 100)}, ${Math.floor(180 + t * 50)}, ${Math.floor(200 + t * 55)}, ${0.8 + t * 0.1})`;
    } else {
      const t = (intensity - 0.8) / 0.2;
      return `rgba(${Math.floor(100 + t * 155)}, ${Math.floor(230 + t * 25)}, 255, ${0.9 + t * 0.1})`;
    }
  } else {
    if (intensity < 0.2) {
      const t = intensity / 0.2;
      return `rgba(${Math.floor(60 + t * 80)}, ${Math.floor(10 + t * 20)}, 0, ${0.3 + t * 0.3})`;
    } else if (intensity < 0.5) {
      const t = (intensity - 0.2) / 0.3;
      return `rgba(${Math.floor(140 + t * 60)}, ${Math.floor(30 + t * 50)}, 0, ${0.6 + t * 0.2})`;
    } else if (intensity < 0.8) {
      const t = (intensity - 0.5) / 0.3;
      return `rgba(${Math.floor(200 + t * 55)}, ${Math.floor(80 + t * 100)}, ${Math.floor(t * 50)}, ${0.8 + t * 0.1})`;
    } else {
      const t = (intensity - 0.8) / 0.2;
      return `rgba(255, ${Math.floor(180 + t * 75)}, ${Math.floor(50 + t * 150)}, ${0.9 + t * 0.1})`;
    }
  }
}

// ===== VOLUME DOTS =====
function renderVolumeDots(ctx, startCol, colWidth, centerPrice, centerY, ppt, tickSize) {
  for (const trade of state.trades) {
    const colIdx = trade.column;
    if (colIdx < startCol) continue;
    
    const x = (colIdx - startCol) * colWidth + colWidth / 2;
    const y = centerY - ((trade.price - centerPrice) / tickSize) * ppt;
    
    // Skip if off screen
    if (x < 0 || x > heatmapCanvas.width) continue;
    if (y < -20 || y > heatmapCanvas.height + 20) continue;
    
    // Size proportional to trade volume (log scale)
    const radius = Math.min(Math.max(2, Math.log2(trade.size + 1) * 2.5), 25);
    
    // Color based on buy/sell
    const isBuy = trade.side === 'buy';
    const alpha = Math.min(0.4 + (trade.size / 100) * 0.4, 0.85);
    
    // Glow effect for large trades
    if (trade.size > 30) {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.5);
      if (isBuy) {
        gradient.addColorStop(0, `rgba(76, 175, 80, ${alpha})`);
        gradient.addColorStop(0.6, `rgba(76, 175, 80, ${alpha * 0.5})`);
        gradient.addColorStop(1, 'rgba(76, 175, 80, 0)');
      } else {
        gradient.addColorStop(0, `rgba(244, 67, 54, ${alpha})`);
        gradient.addColorStop(0.6, `rgba(244, 67, 54, ${alpha * 0.5})`);
        gradient.addColorStop(1, 'rgba(244, 67, 54, 0)');
      }
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Main dot
    ctx.fillStyle = isBuy 
      ? `rgba(76, 175, 80, ${alpha})` 
      : `rgba(244, 67, 54, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    
    // Border
    ctx.strokeStyle = isBuy
      ? `rgba(129, 199, 132, ${alpha})`
      : `rgba(239, 154, 154, ${alpha})`;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
}



// ===== GRID RENDERING =====
function renderGrid(ctx, W, H, centerPrice, centerY, ppt, tickSize) {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.lineWidth = 0.5;
  
  // Horizontal grid (price levels)
  const gridTicks = Math.max(4, Math.floor(20 / ppt) * 4); // Every N ticks
  const topPrice = centerPrice + (centerY / ppt) * tickSize;
  const startPrice = Math.floor(topPrice / (tickSize * gridTicks)) * tickSize * gridTicks;
  
  for (let price = startPrice; ; price -= tickSize * gridTicks) {
    const y = centerY - ((price - centerPrice) / tickSize) * ppt;
    if (y > H) break;
    if (y < 0) continue;
    
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  
  // Vertical grid (time)
  const colWidth = Math.max(2, Math.floor(W / Math.min(state.heatmapColumns.length, state.maxHistory)));
  const timeGrid = Math.floor(100 / colWidth);
  for (let i = 0; i < W; i += timeGrid * colWidth) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, H);
    ctx.stroke();
  }
}

// ===== CROSSHAIR =====
function renderCrosshair(ctx, W, H, centerPrice, centerY, ppt, tickSize) {
  if (state.mouseX < 0 || state.mouseY < 0) return;
  
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.setLineDash([2, 2]);
  
  // Horizontal line
  ctx.beginPath();
  ctx.moveTo(0, state.mouseY);
  ctx.lineTo(W, state.mouseY);
  ctx.stroke();
  
  // Vertical line
  ctx.beginPath();
  ctx.moveTo(state.mouseX, 0);
  ctx.lineTo(state.mouseX, H);
  ctx.stroke();
  
  ctx.setLineDash([]);
  
  // Price label
  const hoverPrice = centerPrice + ((centerY - state.mouseY) / ppt) * tickSize;
  const priceLabel = document.getElementById('price-label');
  priceLabel.style.display = 'block';
  priceLabel.style.top = state.mouseY + 'px';
  priceLabel.textContent = hoverPrice.toFixed(2);
  
  // Time label
  const timeLabel = document.getElementById('time-label');
  timeLabel.style.display = 'block';
  timeLabel.style.left = state.mouseX + 'px';
  const now = new Date();
  timeLabel.textContent = now.toLocaleTimeString();
}

// ===== PRICE AXIS =====
function renderPriceAxis() {
  const ctx = priceCtx;
  const W = priceCanvas.width;
  const H = priceCanvas.height;
  
  if (W === 0 || H === 0) return;
  
  ctx.fillStyle = '#161630';
  ctx.fillRect(0, 0, W, H);
  
  if (!state.currentPrice) return;
  
  const ppt = state.pixelsPerTick;
  const tickSize = state.tickSize;
  const centerPrice = state.currentPrice + state.priceOffset;
  const centerY = H / 2;
  
  // Draw price labels
  const gridTicks = Math.max(4, Math.floor(20 / ppt) * 4);
  const topPrice = centerPrice + (centerY / ppt) * tickSize;
  const startPrice = Math.floor(topPrice / (tickSize * gridTicks)) * tickSize * gridTicks;
  
  ctx.fillStyle = '#a0a0b0';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  
  for (let price = startPrice; ; price -= tickSize * gridTicks) {
    const y = centerY - ((price - centerPrice) / tickSize) * ppt;
    if (y > H) break;
    if (y < 0) continue;
    
    ctx.fillStyle = '#606080';
    ctx.fillRect(0, y, 4, 1);
    ctx.fillStyle = '#a0a0b0';
    ctx.fillText(price.toFixed(2), 6, y + 3);
  }
  
  // Current price marker
  const priceY = centerY - ((state.currentPrice - centerPrice) / tickSize) * ppt;
  ctx.fillStyle = '#4fc3f7';
  ctx.fillRect(0, priceY - 8, W, 16);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 10px monospace';
  ctx.fillText(state.currentPrice.toFixed(2), 4, priceY + 4);
  
  // Bid marker
  const bidY = centerY - ((state.bid - centerPrice) / tickSize) * ppt;
  ctx.fillStyle = 'rgba(76, 175, 80, 0.7)';
  ctx.fillRect(0, bidY - 1, W, 2);
  
  // Ask marker
  const askY = centerY - ((state.ask - centerPrice) / tickSize) * ppt;
  ctx.fillStyle = 'rgba(244, 67, 54, 0.7)';
  ctx.fillRect(0, askY - 1, W, 2);
}

// ===== VOLUME PROFILE =====
function renderVolumeProfile() {
  const ctx = vpCtx;
  const W = vpCanvas.width;
  const H = vpCanvas.height;
  
  if (W === 0 || H === 0) return;
  
  ctx.fillStyle = '#12122a';
  ctx.fillRect(0, 0, W, H);
  
  if (!state.currentPrice) return;
  
  const ppt = state.pixelsPerTick;
  const tickSize = state.tickSize;
  const centerPrice = state.currentPrice + state.priceOffset;
  const centerY = H / 2;
  
  // Find max volume for scaling
  let maxVol = 1;
  for (const key of Object.keys(state.volumeProfile)) {
    const vp = state.volumeProfile[key];
    maxVol = Math.max(maxVol, vp.buyVol + vp.sellVol);
  }
  
  // Draw volume bars
  for (const [priceStr, vp] of Object.entries(state.volumeProfile)) {
    const price = parseFloat(priceStr);
    const y = centerY - ((price - centerPrice) / tickSize) * ppt;
    
    if (y < -ppt || y > H + ppt) continue;
    
    const totalVol = vp.buyVol + vp.sellVol;
    const barWidth = (totalVol / maxVol) * (W - 4);
    const buyWidth = (vp.buyVol / totalVol) * barWidth;
    const sellWidth = barWidth - buyWidth;
    
    // Buy portion (green)
    ctx.fillStyle = 'rgba(76, 175, 80, 0.6)';
    ctx.fillRect(W - barWidth, y - ppt / 2 + 1, buyWidth, ppt - 2);
    
    // Sell portion (red)
    ctx.fillStyle = 'rgba(244, 67, 54, 0.6)';
    ctx.fillRect(W - sellWidth, y - ppt / 2 + 1, sellWidth, ppt - 2);
  }
  
  // POC (Point of Control) line
  let pocPrice = state.currentPrice;
  let pocVol = 0;
  for (const [priceStr, vp] of Object.entries(state.volumeProfile)) {
    const total = vp.buyVol + vp.sellVol;
    if (total > pocVol) {
      pocVol = total;
      pocPrice = parseFloat(priceStr);
    }
  }
  
  const pocY = centerY - ((pocPrice - centerPrice) / tickSize) * ppt;
  ctx.strokeStyle = 'rgba(255, 213, 79, 0.7)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, pocY);
  ctx.lineTo(W, pocY);
  ctx.stroke();
  ctx.setLineDash([]);
  
  // Label
  ctx.fillStyle = '#606080';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('VOL PROFILE', W / 2, 12);
}



// ===== CVD (Cumulative Volume Delta) =====
function renderCVD() {
  const ctx = cvdCtx;
  const W = cvdCanvas.width;
  const H = cvdCanvas.height;
  
  if (W === 0 || H === 0) return;
  
  ctx.fillStyle = '#0d0d1a';
  ctx.fillRect(0, 0, W, H);
  
  if (state.cvdHistory.length < 2) return;
  
  // Find min/max for scaling
  let minCvd = Infinity, maxCvd = -Infinity;
  for (const v of state.cvdHistory) {
    minCvd = Math.min(minCvd, v);
    maxCvd = Math.max(maxCvd, v);
  }
  
  const range = maxCvd - minCvd || 1;
  const padding = 8;
  const drawH = H - padding * 2;
  const drawW = W - 4;
  
  // Zero line
  const zeroY = padding + drawH - ((0 - minCvd) / range) * drawH;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  ctx.lineTo(W, zeroY);
  ctx.stroke();
  
  // Draw CVD line
  ctx.beginPath();
  const step = drawW / (state.cvdHistory.length - 1);
  
  for (let i = 0; i < state.cvdHistory.length; i++) {
    const x = 2 + i * step;
    const y = padding + drawH - ((state.cvdHistory[i] - minCvd) / range) * drawH;
    
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  
  // Gradient stroke
  const lastCvd = state.cvdHistory[state.cvdHistory.length - 1];
  const cvdColor = lastCvd >= 0 ? 'rgba(76, 175, 80, 0.9)' : 'rgba(244, 67, 54, 0.9)';
  ctx.strokeStyle = cvdColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  
  // Fill area
  const lastX = 2 + (state.cvdHistory.length - 1) * step;
  ctx.lineTo(lastX, zeroY);
  ctx.lineTo(2, zeroY);
  ctx.closePath();
  
  const fillColor = lastCvd >= 0 ? 'rgba(76, 175, 80, 0.1)' : 'rgba(244, 67, 54, 0.1)';
  ctx.fillStyle = fillColor;
  ctx.fill();
  
  // Labels
  ctx.fillStyle = '#606080';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('CVD', 4, 10);
  
  ctx.textAlign = 'right';
  ctx.fillStyle = cvdColor;
  ctx.fillText(formatNumber(lastCvd), W - 4, 10);
}

// ===== DOM LADDER =====
function renderDOM() {
  const container = document.getElementById('dom-ladder');
  
  if (!state.domBids.length || !state.domAsks.length) {
    container.innerHTML = '<div style="text-align:center;padding:20px;color:#606080;">Waiting for data...</div>';
    return;
  }
  
  // Find max qty for bar scaling
  let maxQty = 1;
  for (const [, qty] of state.domAsks) maxQty = Math.max(maxQty, qty);
  for (const [, qty] of state.domBids) maxQty = Math.max(maxQty, qty);
  
  let html = '<table>';
  
  // Show asks (reversed, highest first at top)
  const visibleAsks = state.domAsks.slice(0, 15).reverse();
  for (const [price, qty] of visibleAsks) {
    const barWidth = (qty / maxQty) * 100;
    const vol = state.volumeProfile[price.toFixed(2)];
    const tradedVol = vol ? vol.buyVol + vol.sellVol : 0;
    
    html += `<tr class="ask-row">
      <td class="qty-cell ask-qty">${qty}</td>
      <td class="price-cell">${price.toFixed(2)}</td>
      <td class="qty-cell" style="position:relative;">
        <div class="bar-bg ask-bar" style="width:${barWidth}%"></div>
      </td>
      <td class="vol-cell">${tradedVol > 0 ? formatNumber(tradedVol) : ''}</td>
    </tr>`;
  }
  
  // Spread row
  html += `<tr class="spread-row">
    <td colspan="4">▲ Spread: ${state.spread.toFixed(2)} ▼</td>
  </tr>`;
  
  // Show bids
  const visibleBids = state.domBids.slice(0, 15);
  for (const [price, qty] of visibleBids) {
    const barWidth = (qty / maxQty) * 100;
    const vol = state.volumeProfile[price.toFixed(2)];
    const tradedVol = vol ? vol.buyVol + vol.sellVol : 0;
    
    html += `<tr class="bid-row">
      <td class="qty-cell bid-qty">${qty}</td>
      <td class="price-cell">${price.toFixed(2)}</td>
      <td class="qty-cell" style="position:relative;">
        <div class="bar-bg bid-bar" style="width:${barWidth}%"></div>
      </td>
      <td class="vol-cell">${tradedVol > 0 ? formatNumber(tradedVol) : ''}</td>
    </tr>`;
  }
  
  html += '</table>';
  container.innerHTML = html;
}

// ===== INTERACTION =====
function setupInteraction() {
  const container = document.getElementById('heatmap-container');
  
  // Mouse move (crosshair)
  container.addEventListener('mousemove', (e) => {
    const rect = heatmapCanvas.getBoundingClientRect();
    state.mouseX = e.clientX - rect.left;
    state.mouseY = e.clientY - rect.top;
    
    if (state.isDragging) {
      const dy = e.movementY;
      state.priceOffset += (dy / state.pixelsPerTick) * state.tickSize;
    }
  });
  
  container.addEventListener('mouseleave', () => {
    state.mouseX = -1;
    state.mouseY = -1;
    document.getElementById('price-label').style.display = 'none';
    document.getElementById('time-label').style.display = 'none';
  });
  
  // Mouse drag (pan price)
  container.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      state.isDragging = true;
      container.style.cursor = 'grabbing';
    }
  });
  
  window.addEventListener('mouseup', () => {
    state.isDragging = false;
    document.getElementById('heatmap-container').style.cursor = 'crosshair';
  });
  
  // Scroll (zoom)
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -1 : 1;
    state.pixelsPerTick = Math.max(2, Math.min(30, state.pixelsPerTick + delta));
  }, { passive: false });
  
  // Zoom buttons
  document.getElementById('zoom-in').addEventListener('click', () => {
    state.pixelsPerTick = Math.min(30, state.pixelsPerTick + 2);
  });
  
  document.getElementById('zoom-out').addEventListener('click', () => {
    state.pixelsPerTick = Math.max(2, state.pixelsPerTick - 2);
  });
  
  document.getElementById('zoom-reset').addEventListener('click', () => {
    state.pixelsPerTick = 8;
    state.priceOffset = 0;
  });
  
  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    switch (e.key) {
      case '+':
      case '=':
        state.pixelsPerTick = Math.min(30, state.pixelsPerTick + 1);
        break;
      case '-':
        state.pixelsPerTick = Math.max(2, state.pixelsPerTick - 1);
        break;
      case 'Home':
        state.priceOffset = 0;
        break;
    }
  });
}

// ===== START =====
window.addEventListener('DOMContentLoaded', init);
