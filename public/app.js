/**
 * ═══════════════════════════════════════════════════════════════════
 *  FREE BOOKMAP + CANDLESTICK CHART - Frontend
 *  Canvas-based: Candles + Volume + Heatmap + Order Flow
 * ═══════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
const S = {
  ws: null,
  connected: false,
  instruments: {},
  currentInstrument: 'XAUUSD',
  currentTimeframe: '1m',
  timeframes: ['1m','5m','15m','30m','1h','4h','1D'],
  currentPrice: 0,
  orderBook: { bids: {}, asks: {} },
  candles: [],
  trades: [],
  events: [],
  domHistory: [],
  avgTradeSize: 0,
  
  // Chart state
  zoom: 1,
  offset: 0, // scroll offset (candles from right)
  visibleCandles: 80,
  crosshair: null,
  dragging: false,
  dragStartX: 0,
  dragStartOffset: 0,
  
  // Performance
  updateCount: 0,
  lastCountReset: Date.now(),
  ups: 0,
};

// Timeframe durations in ms
const TF_MS = {
  '1m': 60000, '5m': 300000, '15m': 900000,
  '30m': 1800000, '1h': 3600000, '4h': 14400000, '1D': 86400000,
};

// ═══════════════════════════════════════════════════════════════════
// CANVAS SETUP
// ═══════════════════════════════════════════════════════════════════
const chartCanvas = document.getElementById('chartCanvas');
const chartCtx = chartCanvas.getContext('2d');
const volCanvas = document.getElementById('volumeCanvas');
const volCtx = volCanvas.getContext('2d');

let chartW, chartH, volW, volH;
const PRICE_AXIS_W = 70;

function resizeCanvases() {
  const chartArea = document.getElementById('chartArea');
  const volEl = document.getElementById('volumeCanvas');
  
  chartW = chartArea.clientWidth;
  chartH = chartArea.clientHeight - 80; // subtract volume height
  volW = chartArea.clientWidth;
  volH = 80;
  
  const dpr = window.devicePixelRatio || 1;
  
  chartCanvas.width = chartW * dpr;
  chartCanvas.height = chartH * dpr;
  chartCanvas.style.width = chartW + 'px';
  chartCanvas.style.height = chartH + 'px';
  chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  
  volCanvas.width = volW * dpr;
  volCanvas.height = volH * dpr;
  volCanvas.style.width = volW + 'px';
  volCanvas.style.height = volH + 'px';
  volCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', resizeCanvases);
setTimeout(resizeCanvases, 50);
resizeCanvases();



// ═══════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════════
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  S.ws = new WebSocket(`${proto}//${location.host}`);
  
  S.ws.onopen = () => {
    S.connected = true;
    setConnectionUI(true);
  };
  
  S.ws.onmessage = (e) => {
    S.updateCount++;
    const d = JSON.parse(e.data);
    handleMsg(d);
  };
  
  S.ws.onclose = () => {
    S.connected = false;
    setConnectionUI(false);
    setTimeout(connect, 2000);
  };
  
  S.ws.onerror = () => { S.connected = false; };
}

function send(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(obj));
  }
}

function handleMsg(d) {
  switch (d.type) {
    case 'INIT':
      S.instruments = d.instruments || {};
      S.currentInstrument = d.config.currentInstrument;
      S.currentTimeframe = d.config.currentTimeframe;
      S.timeframes = d.timeframes || S.timeframes;
      S.candles = d.candles || [];
      S.domHistory = d.domHistory || [];
      S.events = d.events || [];
      S.currentPrice = d.currentPrice;
      buildButtons();
      break;
      
    case 'UPDATE':
      S.orderBook = d.orderBook;
      S.currentPrice = d.currentPrice;
      S.trades = d.trades || [];
      S.avgTradeSize = d.avgTradeSize || 0;
      
      // Update current candle
      if (d.currentCandle && S.candles.length > 0) {
        const last = S.candles[S.candles.length - 1];
        if (last.openTime === d.currentCandle.openTime) {
          S.candles[S.candles.length - 1] = d.currentCandle;
        } else {
          S.candles.push(d.currentCandle);
        }
      } else if (d.currentCandle && S.candles.length === 0) {
        S.candles.push(d.currentCandle);
      }
      
      // Events
      if (d.events) {
        d.events.forEach(ev => {
          if (!S.events.find(x => x.time === ev.time && x.type === ev.type && x.price === ev.price)) {
            S.events.push(ev);
          }
        });
        if (S.events.length > 200) S.events = S.events.slice(-200);
      }
      
      // DOM
      if (d.domSnapshot) {
        S.domHistory.push(d.domSnapshot);
        if (S.domHistory.length > 400) S.domHistory = S.domHistory.slice(-400);
      }
      break;
      
    case 'INSTRUMENT_CHANGED':
      S.currentInstrument = d.instrument;
      S.candles = d.candles || [];
      S.domHistory = [];
      S.events = [];
      S.offset = 0;
      setActiveBtn('.inst-btn', d.instrument);
      break;
      
    case 'TIMEFRAME_CHANGED':
      S.currentTimeframe = d.timeframe;
      S.candles = d.candles || [];
      S.offset = 0;
      setActiveBtn('.tf-btn', d.timeframe);
      document.getElementById('sTimeframe').textContent = d.timeframe;
      break;
      
    case 'CANDLES_DATA':
      S.candles = d.candles || [];
      S.offset = 0;
      break;
  }
}



// ═══════════════════════════════════════════════════════════════════
// CANDLESTICK CHART RENDERING
// ═══════════════════════════════════════════════════════════════════
function renderChart() {
  chartCtx.clearRect(0, 0, chartW, chartH);
  
  if (S.candles.length < 1) {
    renderWaiting();
    return;
  }
  
  const drawW = chartW - PRICE_AXIS_W;
  const numCandles = Math.floor(S.visibleCandles / S.zoom);
  const startIdx = Math.max(0, S.candles.length - numCandles - S.offset);
  const endIdx = Math.min(S.candles.length, startIdx + numCandles);
  const visible = S.candles.slice(startIdx, endIdx);
  
  if (visible.length === 0) { renderWaiting(); return; }
  
  // Calculate price range
  let high = -Infinity, low = Infinity;
  visible.forEach(c => {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  });
  
  const padding = (high - low) * 0.08 || high * 0.001;
  high += padding;
  low -= padding;
  const priceRange = high - low || 1;
  
  const candleW = drawW / numCandles;
  const bodyW = Math.max(1, candleW * 0.7);
  const wickW = Math.max(1, candleW * 0.1);
  
  // ─── Draw grid ───
  renderGrid(drawW, high, low, priceRange);
  
  // ─── Draw heatmap behind candles ───
  renderHeatmapOverlay(drawW, high, low, priceRange, visible);
  
  // ─── Draw candles ───
  visible.forEach((candle, i) => {
    const x = i * candleW + candleW / 2;
    const isGreen = candle.close >= candle.open;
    
    const openY = ((high - candle.open) / priceRange) * chartH;
    const closeY = ((high - candle.close) / priceRange) * chartH;
    const highY = ((high - candle.high) / priceRange) * chartH;
    const lowY = ((high - candle.low) / priceRange) * chartH;
    
    // Wick
    chartCtx.strokeStyle = isGreen ? '#26a69a' : '#ef5350';
    chartCtx.lineWidth = Math.max(1, wickW);
    chartCtx.beginPath();
    chartCtx.moveTo(x, highY);
    chartCtx.lineTo(x, lowY);
    chartCtx.stroke();
    
    // Body
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1, Math.abs(closeY - openY));
    
    if (isGreen) {
      chartCtx.fillStyle = '#26a69a';
    } else {
      chartCtx.fillStyle = '#ef5350';
    }
    chartCtx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyHeight);
  });
  
  // ─── Draw event markers on chart ───
  renderChartEvents(drawW, high, low, priceRange, visible);
  
  // ─── Current price line ───
  if (S.currentPrice > low && S.currentPrice < high) {
    const priceY = ((high - S.currentPrice) / priceRange) * chartH;
    chartCtx.setLineDash([4, 3]);
    chartCtx.strokeStyle = '#ffaa00';
    chartCtx.lineWidth = 1;
    chartCtx.beginPath();
    chartCtx.moveTo(0, priceY);
    chartCtx.lineTo(drawW, priceY);
    chartCtx.stroke();
    chartCtx.setLineDash([]);
    
    // Price tag
    chartCtx.fillStyle = '#ffaa00';
    chartCtx.fillRect(drawW, priceY - 8, PRICE_AXIS_W, 16);
    chartCtx.fillStyle = '#000';
    chartCtx.font = '10px Courier New';
    chartCtx.textAlign = 'left';
    chartCtx.fillText(formatPrice(S.currentPrice), drawW + 4, priceY + 3);
  }
  
  // ─── Price axis ───
  renderPriceAxis(drawW, high, low, priceRange);
  
  // ─── Crosshair ───
  if (S.crosshair) {
    renderCrosshair(drawW, high, low, priceRange, visible, numCandles);
  }
}

function renderGrid(drawW, high, low, priceRange) {
  const numLines = 8;
  chartCtx.strokeStyle = 'rgba(40, 40, 60, 0.4)';
  chartCtx.lineWidth = 0.5;
  chartCtx.setLineDash([2, 4]);
  
  for (let i = 0; i <= numLines; i++) {
    const y = (i / numLines) * chartH;
    chartCtx.beginPath();
    chartCtx.moveTo(0, y);
    chartCtx.lineTo(drawW, y);
    chartCtx.stroke();
  }
  chartCtx.setLineDash([]);
}

function renderPriceAxis(drawW, high, low, priceRange) {
  // Background
  chartCtx.fillStyle = 'rgba(13, 13, 21, 0.95)';
  chartCtx.fillRect(drawW, 0, PRICE_AXIS_W, chartH);
  
  // Border
  chartCtx.strokeStyle = '#1a1a2e';
  chartCtx.lineWidth = 1;
  chartCtx.beginPath();
  chartCtx.moveTo(drawW, 0);
  chartCtx.lineTo(drawW, chartH);
  chartCtx.stroke();
  
  // Labels
  const numLabels = 10;
  chartCtx.font = '9px Courier New';
  chartCtx.fillStyle = '#666';
  chartCtx.textAlign = 'left';
  
  for (let i = 0; i <= numLabels; i++) {
    const y = (i / numLabels) * chartH;
    const price = high - (i / numLabels) * priceRange;
    chartCtx.fillText(formatPrice(price), drawW + 4, y + 3);
  }
}

function renderHeatmapOverlay(drawW, high, low, priceRange, visible) {
  // Show order book depth as colored bands behind candles
  if (Object.keys(S.orderBook.bids).length === 0) return;
  
  const maxQty = Math.max(
    ...Object.values(S.orderBook.bids),
    ...Object.values(S.orderBook.asks),
    1
  );
  
  // Draw bids
  Object.entries(S.orderBook.bids).forEach(([price, qty]) => {
    const p = parseFloat(price);
    if (p < low || p > high) return;
    const y = ((high - p) / priceRange) * chartH;
    const intensity = Math.min(qty / maxQty, 1);
    const alpha = 0.05 + intensity * 0.2;
    chartCtx.fillStyle = `rgba(0, 200, 83, ${alpha})`;
    chartCtx.fillRect(0, y - 1, drawW, 3);
  });
  
  // Draw asks
  Object.entries(S.orderBook.asks).forEach(([price, qty]) => {
    const p = parseFloat(price);
    if (p < low || p > high) return;
    const y = ((high - p) / priceRange) * chartH;
    const intensity = Math.min(qty / maxQty, 1);
    const alpha = 0.05 + intensity * 0.2;
    chartCtx.fillStyle = `rgba(255, 53, 71, ${alpha})`;
    chartCtx.fillRect(0, y - 1, drawW, 3);
  });
}

function renderChartEvents(drawW, high, low, priceRange, visible) {
  if (visible.length === 0 || S.events.length === 0) return;
  
  const firstTime = visible[0].openTime;
  const lastTime = visible[visible.length - 1].closeTime;
  const timeRange = lastTime - firstTime || 1;
  
  S.events.forEach(ev => {
    if (ev.time < firstTime || ev.time > lastTime) return;
    if (!ev.price || ev.price < low || ev.price > high) return;
    
    const x = ((ev.time - firstTime) / timeRange) * drawW;
    const y = ((high - ev.price) / priceRange) * chartH;
    
    switch (ev.type) {
      case 'AGGRESSIVE_BUY':
        chartCtx.font = '14px sans-serif';
        chartCtx.fillStyle = '#00e676';
        chartCtx.textAlign = 'center';
        chartCtx.fillText('▲', x, y);
        break;
      case 'AGGRESSIVE_SELL':
        chartCtx.font = '14px sans-serif';
        chartCtx.fillStyle = '#ff1744';
        chartCtx.textAlign = 'center';
        chartCtx.fillText('▼', x, y);
        break;
      case 'ORDER_PULL':
        chartCtx.fillStyle = '#ffab00';
        chartCtx.beginPath();
        chartCtx.arc(x, y, 4, 0, Math.PI * 2);
        chartCtx.fill();
        break;
      case 'ORDER_STACK':
        chartCtx.fillStyle = '#7c4dff';
        chartCtx.fillRect(x - 3, y - 3, 6, 6);
        break;
      case 'ICEBERG':
        chartCtx.fillStyle = '#00e5ff';
        chartCtx.beginPath();
        chartCtx.moveTo(x, y - 5);
        chartCtx.lineTo(x + 5, y + 3);
        chartCtx.lineTo(x - 5, y + 3);
        chartCtx.closePath();
        chartCtx.fill();
        break;
    }
  });
}

function renderCrosshair(drawW, high, low, priceRange, visible, numCandles) {
  const { x, y } = S.crosshair;
  if (x > drawW || x < 0 || y < 0 || y > chartH) return;
  
  // Lines
  chartCtx.setLineDash([3, 3]);
  chartCtx.strokeStyle = 'rgba(255,255,255,0.3)';
  chartCtx.lineWidth = 0.5;
  
  chartCtx.beginPath();
  chartCtx.moveTo(x, 0);
  chartCtx.lineTo(x, chartH);
  chartCtx.stroke();
  
  chartCtx.beginPath();
  chartCtx.moveTo(0, y);
  chartCtx.lineTo(drawW, y);
  chartCtx.stroke();
  chartCtx.setLineDash([]);
  
  // Price at cursor
  const price = high - (y / chartH) * priceRange;
  chartCtx.fillStyle = '#444';
  chartCtx.fillRect(drawW, y - 8, PRICE_AXIS_W, 16);
  chartCtx.fillStyle = '#fff';
  chartCtx.font = '9px Courier New';
  chartCtx.textAlign = 'left';
  chartCtx.fillText(formatPrice(price), drawW + 4, y + 3);
  
  // Candle info tooltip
  const candleW = drawW / numCandles;
  const candleIdx = Math.floor(x / candleW);
  if (candleIdx >= 0 && candleIdx < visible.length) {
    const c = visible[candleIdx];
    const tooltip = document.getElementById('crosshairInfo');
    tooltip.style.display = 'block';
    tooltip.style.left = (x + 80) + 'px';
    tooltip.style.top = (y + 60) + 'px';
    const time = new Date(c.openTime).toLocaleString();
    tooltip.innerHTML = `
      <div style="color:#aaa">${time}</div>
      <div>O: ${formatPrice(c.open)} H: ${formatPrice(c.high)}</div>
      <div>L: ${formatPrice(c.low)} C: ${formatPrice(c.close)}</div>
      <div style="color:#00c853">Vol: ${c.volume.toFixed(4)}</div>
    `;
  }
}

function renderWaiting() {
  chartCtx.fillStyle = '#0a0a12';
  chartCtx.fillRect(0, 0, chartW, chartH);
  chartCtx.font = '14px Courier New';
  chartCtx.fillStyle = '#00e5ff';
  chartCtx.textAlign = 'center';
  chartCtx.fillText('Connecting to live market data...', chartW / 2, chartH / 2 - 10);
  chartCtx.font = '11px Courier New';
  chartCtx.fillStyle = '#444';
  chartCtx.fillText('Building candles - please wait 5-10 seconds', chartW / 2, chartH / 2 + 15);
}



// ═══════════════════════════════════════════════════════════════════
// VOLUME CHART RENDERING
// ═══════════════════════════════════════════════════════════════════
function renderVolume() {
  volCtx.clearRect(0, 0, volW, volH);
  
  if (S.candles.length < 1) return;
  
  const drawW = volW - PRICE_AXIS_W;
  const numCandles = Math.floor(S.visibleCandles / S.zoom);
  const startIdx = Math.max(0, S.candles.length - numCandles - S.offset);
  const endIdx = Math.min(S.candles.length, startIdx + numCandles);
  const visible = S.candles.slice(startIdx, endIdx);
  
  if (visible.length === 0) return;
  
  // Find max volume
  let maxVol = 0;
  visible.forEach(c => { if (c.volume > maxVol) maxVol = c.volume; });
  if (maxVol === 0) return;
  
  const barW = drawW / numCandles;
  const barBodyW = Math.max(1, barW * 0.7);
  
  // Background grid
  volCtx.strokeStyle = 'rgba(40, 40, 60, 0.3)';
  volCtx.lineWidth = 0.5;
  for (let i = 1; i <= 3; i++) {
    const y = (i / 4) * volH;
    volCtx.beginPath();
    volCtx.moveTo(0, y);
    volCtx.lineTo(drawW, y);
    volCtx.stroke();
  }
  
  // Draw volume bars
  visible.forEach((candle, i) => {
    const x = i * barW + barW / 2;
    const totalH = (candle.volume / maxVol) * (volH - 4);
    const buyH = candle.buyVolume ? (candle.buyVolume / candle.volume) * totalH : 0;
    const sellH = totalH - buyH;
    
    // Sell portion (top of bar)
    if (sellH > 0) {
      volCtx.fillStyle = 'rgba(239, 83, 80, 0.7)';
      volCtx.fillRect(x - barBodyW / 2, volH - totalH, barBodyW, sellH);
    }
    
    // Buy portion (bottom of bar)
    if (buyH > 0) {
      volCtx.fillStyle = 'rgba(38, 166, 154, 0.7)';
      volCtx.fillRect(x - barBodyW / 2, volH - buyH, barBodyW, buyH);
    }
  });
  
  // Volume axis label
  volCtx.fillStyle = 'rgba(13, 13, 21, 0.95)';
  volCtx.fillRect(drawW, 0, PRICE_AXIS_W, volH);
  volCtx.strokeStyle = '#1a1a2e';
  volCtx.beginPath();
  volCtx.moveTo(drawW, 0);
  volCtx.lineTo(drawW, volH);
  volCtx.stroke();
  
  volCtx.font = '8px Courier New';
  volCtx.fillStyle = '#555';
  volCtx.textAlign = 'left';
  volCtx.fillText(maxVol.toFixed(2), drawW + 4, 12);
  volCtx.fillText('0', drawW + 4, volH - 4);
  volCtx.fillText('VOL', drawW + 4, volH / 2 + 3);
}

// ═══════════════════════════════════════════════════════════════════
// DOM LADDER
// ═══════════════════════════════════════════════════════════════════
function renderDOM() {
  const el = document.getElementById('domLadder');
  if (!S.currentPrice || Object.keys(S.orderBook.bids).length === 0) return;
  
  const bids = Object.entries(S.orderBook.bids)
    .map(([p, q]) => ({ price: +p, qty: q }))
    .sort((a, b) => b.price - a.price).slice(0, 10);
    
  const asks = Object.entries(S.orderBook.asks)
    .map(([p, q]) => ({ price: +p, qty: q }))
    .sort((a, b) => a.price - b.price).slice(0, 10);
  
  const maxQ = Math.max(...bids.map(b => b.qty), ...asks.map(a => a.qty), 1);
  
  let html = '';
  
  // Asks reversed
  [...asks].reverse().forEach(l => {
    const pct = (l.qty / maxQ) * 50;
    html += `<div class="dom-row"><div class="qty-bid"></div><div class="price-cell" style="color:#ef5350">${formatPrice(l.price)}</div><div class="qty-ask">${l.qty.toFixed(4)}</div><div class="ask-bar" style="width:${pct}%"></div></div>`;
  });
  
  // Spread
  if (bids.length && asks.length) {
    const spread = asks[0].price - bids[0].price;
    html += `<div class="dom-row spread-row"><div></div><div class="price-cell" style="color:#ffaa00;font-size:8px">⟷ ${formatPrice(spread)}</div><div></div></div>`;
  }
  
  // Bids
  bids.forEach(l => {
    const pct = (l.qty / maxQ) * 50;
    html += `<div class="dom-row"><div class="qty-bid">${l.qty.toFixed(4)}</div><div class="price-cell" style="color:#26a69a">${formatPrice(l.price)}</div><div class="qty-ask"></div><div class="bid-bar" style="width:${pct}%"></div></div>`;
  });
  
  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════
// EVENTS LOG
// ═══════════════════════════════════════════════════════════════════
function renderEvents() {
  const el = document.getElementById('eventsLog');
  const evs = S.events.filter(e => e.type !== 'MARKET_ORDER').slice(-40).reverse();
  
  let html = '';
  evs.forEach(ev => {
    const t = new Date(ev.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    let cls = '', txt = '';
    
    switch (ev.type) {
      case 'AGGRESSIVE_BUY':
        cls = 'agg-buy'; txt = `${t} ▲ AGG BUY ${ev.size.toFixed(4)} @ ${formatPrice(ev.price)}`; break;
      case 'AGGRESSIVE_SELL':
        cls = 'agg-sell'; txt = `${t} ▼ AGG SELL ${ev.size.toFixed(4)} @ ${formatPrice(ev.price)}`; break;
      case 'ORDER_PULL':
        cls = 'pull'; txt = `${t} ⚠ ${ev.side} PULL @ ${formatPrice(ev.price)}`; break;
      case 'ORDER_STACK':
        cls = 'stack'; txt = `${t} ■ ${ev.side} STACK @ ${formatPrice(ev.price)}`; break;
      case 'ICEBERG':
        cls = 'iceberg'; txt = `${t} ◆ ICE ${ev.side} @ ${formatPrice(ev.price)} (${ev.refillCount}x)`; break;
      default:
        txt = `${t} ${ev.type}`; break;
    }
    
    html += `<div class="event-item ${cls}">${txt}</div>`;
  });
  
  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════
// STATS & COUNTDOWN
// ═══════════════════════════════════════════════════════════════════
function renderStats() {
  const bidVol = Object.values(S.orderBook.bids).reduce((a, b) => a + b, 0);
  const askVol = Object.values(S.orderBook.asks).reduce((a, b) => a + b, 0);
  
  const recentBuys = S.trades.filter(t => t.isBuy && Date.now() - t.time < 10000);
  const recentSells = S.trades.filter(t => !t.isBuy && Date.now() - t.time < 10000);
  const buyPwr = recentBuys.reduce((a, t) => a + t.qty, 0);
  const sellPwr = recentSells.reduce((a, t) => a + t.qty, 0);
  
  const bidPs = Object.keys(S.orderBook.bids).map(Number);
  const askPs = Object.keys(S.orderBook.asks).map(Number);
  const spread = bidPs.length && askPs.length ? Math.min(...askPs) - Math.max(...bidPs) : 0;
  
  const total = bidVol + askVol;
  const imbal = total > 0 ? ((bidVol - askVol) / total * 100).toFixed(1) : '0';
  
  document.getElementById('sBidVol').textContent = bidVol.toFixed(2);
  document.getElementById('sAskVol').textContent = askVol.toFixed(2);
  document.getElementById('sBuyPwr').textContent = buyPwr.toFixed(3);
  document.getElementById('sSellPwr').textContent = sellPwr.toFixed(3);
  document.getElementById('sSpread').textContent = formatPrice(spread);
  
  const imbalEl = document.getElementById('sImbal');
  imbalEl.textContent = imbal + '%';
  imbalEl.style.color = imbal > 0 ? '#00c853' : imbal < 0 ? '#ff3547' : '#888';
  
  // Price
  document.getElementById('priceValue').textContent = formatPrice(S.currentPrice);
  document.getElementById('priceValue').style.color = 
    S.candles.length > 1 && S.currentPrice >= S.candles[S.candles.length - 1].open ? '#26a69a' : '#ef5350';
  
  // Countdown
  updateCountdown();
  
  // Status bar
  const now = Date.now();
  if (now - S.lastCountReset > 1000) {
    S.ups = S.updateCount;
    S.updateCount = 0;
    S.lastCountReset = now;
  }
  document.getElementById('sUpdates').textContent = S.ups + '/s';
  document.getElementById('sCandles').textContent = S.candles.length + ' candles';
  document.getElementById('sInstrument').textContent = 
    S.instruments[S.currentInstrument]?.name || S.currentInstrument;
}

function updateCountdown() {
  const tfMs = TF_MS[S.currentTimeframe] || 60000;
  const now = Date.now();
  const currentOpen = Math.floor(now / tfMs) * tfMs;
  const nextClose = currentOpen + tfMs;
  const remaining = nextClose - now;
  
  const hrs = Math.floor(remaining / 3600000);
  const mins = Math.floor((remaining % 3600000) / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  
  let text = '';
  if (hrs > 0) text = `${hrs}h ${mins}m ${secs}s`;
  else if (mins > 0) text = `${mins}m ${secs}s`;
  else text = `${secs}s`;
  
  document.getElementById('countdown').textContent = `Close: ${text}`;
}



// ═══════════════════════════════════════════════════════════════════
// UI CONTROLS & INTERACTIONS
// ═══════════════════════════════════════════════════════════════════
function buildButtons() {
  // Instruments
  const instEl = document.getElementById('instrumentBtns');
  instEl.innerHTML = '';
  Object.entries(S.instruments).forEach(([key, info]) => {
    const btn = document.createElement('button');
    btn.className = 'inst-btn' + (key === S.currentInstrument ? ' active' : '');
    btn.textContent = key;
    btn.title = info.name;
    btn.dataset.val = key;
    btn.onclick = () => {
      send({ type: 'CHANGE_INSTRUMENT', instrument: key });
      S.currentInstrument = key;
      S.candles = [];
      S.offset = 0;
      setActiveBtn('.inst-btn', key);
    };
    instEl.appendChild(btn);
  });
  
  // Timeframes
  const tfEl = document.getElementById('timeframeBtns');
  tfEl.innerHTML = '';
  S.timeframes.forEach(tf => {
    const btn = document.createElement('button');
    btn.className = 'tf-btn' + (tf === S.currentTimeframe ? ' active' : '');
    btn.textContent = tf;
    btn.dataset.val = tf;
    btn.onclick = () => {
      send({ type: 'CHANGE_TIMEFRAME', timeframe: tf });
      S.currentTimeframe = tf;
      S.offset = 0;
      setActiveBtn('.tf-btn', tf);
      document.getElementById('sTimeframe').textContent = tf;
    };
    tfEl.appendChild(btn);
  });
}

function setActiveBtn(selector, value) {
  document.querySelectorAll(selector).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === value);
  });
}

// Zoom controls
document.getElementById('zoomIn').onclick = () => {
  S.zoom = Math.min(S.zoom * 1.3, 8);
};
document.getElementById('zoomOut').onclick = () => {
  S.zoom = Math.max(S.zoom / 1.3, 0.3);
};
document.getElementById('zoomReset').onclick = () => {
  S.zoom = 1;
  S.offset = 0;
};

// Mouse wheel zoom on chart
chartCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.deltaY < 0) {
    S.zoom = Math.min(S.zoom * 1.1, 8);
  } else {
    S.zoom = Math.max(S.zoom / 1.1, 0.3);
  }
});

// Drag to scroll
chartCanvas.addEventListener('mousedown', (e) => {
  S.dragging = true;
  S.dragStartX = e.clientX;
  S.dragStartOffset = S.offset;
  chartCanvas.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', (e) => {
  if (S.dragging) {
    const dx = e.clientX - S.dragStartX;
    const candleW = (chartW - PRICE_AXIS_W) / Math.floor(S.visibleCandles / S.zoom);
    const candleShift = Math.round(dx / candleW);
    S.offset = Math.max(0, S.dragStartOffset + candleShift);
    S.offset = Math.min(S.offset, Math.max(0, S.candles.length - 10));
  }
  
  // Crosshair
  const rect = chartCanvas.getBoundingClientRect();
  if (e.clientX >= rect.left && e.clientX <= rect.right && 
      e.clientY >= rect.top && e.clientY <= rect.bottom) {
    S.crosshair = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  } else {
    S.crosshair = null;
    document.getElementById('crosshairInfo').style.display = 'none';
  }
});

window.addEventListener('mouseup', () => {
  S.dragging = false;
  chartCanvas.style.cursor = 'crosshair';
});

chartCanvas.style.cursor = 'crosshair';

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
function formatPrice(p) {
  if (!p || p === 0) return '--';
  if (p > 1000) return p.toFixed(2);
  if (p > 1) return p.toFixed(4);
  return p.toFixed(6);
}

function setConnectionUI(on) {
  document.getElementById('connDot').classList.toggle('on', on);
  document.getElementById('connText').textContent = on ? 'Live' : 'Reconnecting...';
}

// ═══════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════
function loop() {
  renderChart();
  renderVolume();
  renderDOM();
  renderEvents();
  renderStats();
  requestAnimationFrame(loop);
}

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════
connect();
loop();

console.log('%c BOOKMAP PRO ', 'background:#00e5ff;color:#000;font-size:14px;font-weight:bold');
console.log('%c Free Candlestick + Heatmap + Order Flow ', 'color:#00e676');
