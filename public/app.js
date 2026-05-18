/**
 * BOOKMAP PRO - TradingView-style candles + Heatmap liquidity bands
 * Smooth zoom/scroll like TradingView
 * Volume bubbles + Best Bid/Offer tracking
 */

const S = {
  ws: null, connected: false, serverConnected: false,
  instruments: {}, currentInstrument: 'BTCUSD', currentTimeframe: '1m',
  timeframes: [], currentPrice: 0,
  orderBook: { bids: {}, asks: {} },
  candles: [], trades: [], events: [], domHistory: [],
  // Smooth zoom & scroll (TradingView style)
  zoom: 1, targetZoom: 1,
  scrollX: 0, targetScrollX: 0,
  dragging: false, dragStartX: 0, dragStartScroll: 0,
  mouse: null,
  // Animation
  animSpeed: 0.15,
};

const TF_MS = { '1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000,'1D':86400000 };
const canvas = document.getElementById('chartCanvas');
const ctx = canvas.getContext('2d');
let W, H;
const AXIS_W = 72;

function resize() {
  const a = document.getElementById('chartArea');
  W = a.clientWidth; H = a.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ═══════════ WEBSOCKET ═══════════
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  S.ws = new WebSocket(`${proto}//${location.host}`);
  S.ws.onopen = () => { S.connected = true; updateUI(); };
  S.ws.onclose = () => { S.connected = false; updateUI(); setTimeout(connect, 2000); };
  S.ws.onerror = () => { S.connected = false; };
  S.ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'INIT') {
      S.instruments = d.instruments || {};
      S.currentInstrument = d.config.currentInstrument;
      S.currentTimeframe = d.config.currentTimeframe;
      S.timeframes = d.timeframes || [];
      S.candles = d.candles || [];
      S.domHistory = d.domHistory || [];
      S.orderBook = d.orderBook || {bids:{},asks:{}};
      S.trades = d.trades || [];
      S.events = d.events || [];
      S.currentPrice = d.currentPrice;
      S.serverConnected = d.connected;
      buildButtons();
    } else if (d.type === 'UPDATE') {
      S.orderBook = d.orderBook || S.orderBook;
      S.currentPrice = d.currentPrice || S.currentPrice;
      S.trades = d.trades || S.trades;
      S.serverConnected = d.connected;
      if (d.currentCandle && S.candles.length > 0) {
        const last = S.candles[S.candles.length-1];
        if (last.openTime === d.currentCandle.openTime) S.candles[S.candles.length-1] = d.currentCandle;
        else S.candles.push(d.currentCandle);
      }
      if (d.domHistory) {
        d.domHistory.forEach(snap => {
          if (!S.domHistory.find(x => x.time === snap.time)) S.domHistory.push(snap);
        });
        if (S.domHistory.length > 600) S.domHistory = S.domHistory.slice(-600);
      }
      if (d.events) {
        d.events.forEach(ev => {
          if (!S.events.find(x => x.time===ev.time && x.type===ev.type)) S.events.push(ev);
        });
        if (S.events.length > 200) S.events = S.events.slice(-200);
      }
    } else if (d.type === 'INSTRUMENT_CHANGED') {
      S.currentInstrument = d.instrument;
      S.candles = d.candles || [];
      S.domHistory = d.domHistory || [];
      S.orderBook = d.orderBook || {bids:{},asks:{}};
      S.currentPrice = d.currentPrice;
      S.events = []; S.scrollX = 0; S.targetScrollX = 0;
      setActive('.inst', d.instrument);
    } else if (d.type === 'TIMEFRAME_CHANGED') {
      S.currentTimeframe = d.timeframe;
      S.candles = d.candles || [];
      S.scrollX = 0; S.targetScrollX = 0;
      setActive('.tf', d.timeframe);
      document.getElementById('sTf').textContent = d.timeframe;
    }
  };
}
function send(o) { if (S.ws && S.ws.readyState===1) S.ws.send(JSON.stringify(o)); }

// ═══════════ SMOOTH ANIMATION ═══════════
function lerp(a, b, t) { return a + (b - a) * t; }

// ═══════════ MAIN RENDER LOOP ═══════════
function render() {
  // Smooth zoom & scroll interpolation (TradingView feel)
  S.zoom = lerp(S.zoom, S.targetZoom, S.animSpeed);
  S.scrollX = lerp(S.scrollX, S.targetScrollX, S.animSpeed);
  
  ctx.clearRect(0, 0, W, H);
  
  if (S.candles.length < 2) {
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.font = '15px Consolas'; ctx.fillStyle = '#58a6ff'; ctx.textAlign = 'center';
    ctx.fillText('Loading market data...', W/2, H/2 - 10);
    ctx.font = '11px Consolas'; ctx.fillStyle = '#484f58';
    ctx.fillText('Waiting for candles & order book', W/2, H/2 + 14);
    requestAnimationFrame(render); return;
  }
  
  const drawW = W - AXIS_W;
  const volH = 60; // volume section height at bottom
  const chartH = H - volH;
  
  // Visible candle count based on zoom
  // Leave 15% empty space on right so latest candle is clearly visible
  const rightPad = drawW * 0.12;
  const chartDrawW = drawW - rightPad;
  
  const baseCandles = 80;
  const numVis = Math.max(10, Math.round(baseCandles / S.zoom));
  const scrollOffset = Math.round(S.scrollX);
  const endIdx = Math.max(numVis, S.candles.length - scrollOffset);
  const startIdx = Math.max(0, endIdx - numVis);
  const visible = S.candles.slice(startIdx, endIdx);
  
  if (visible.length < 2) { requestAnimationFrame(render); return; }
  
  // Price range
  let hi = -Infinity, lo = Infinity;
  visible.forEach(c => { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); });
  const pad = (hi - lo) * 0.12 || hi * 0.002;
  hi += pad; lo -= pad;
  const range = hi - lo || 1;
  
  // Time range
  const tStart = visible[0].openTime;
  const tEnd = visible[visible.length-1].closeTime;
  const tRange = tEnd - tStart || 1;
  
  const candleW = chartDrawW / visible.length;
  const bodyW = Math.max(1, candleW * 0.65);
  
  // ─── Background ───
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);
  
  // ─── Grid ───
  ctx.strokeStyle = '#161b22'; ctx.lineWidth = 1;
  for (let i = 1; i <= 6; i++) {
    const y = (i/7) * chartH;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(drawW, y); ctx.stroke();
  }
  for (let i = 1; i <= 5; i++) {
    const x = (i/6) * drawW;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, chartH); ctx.stroke();
  }
  
  // ─── 1. LIQUIDITY HEATMAP (dense bands like real Bookmap) ───
  // Real Bookmap = thick solid bands at each price level filling full width
  let maxQ = 0;
  S.domHistory.forEach(snap => {
    Object.values(snap.bids).forEach(q => { if (q > maxQ) maxQ = q; });
    Object.values(snap.asks).forEach(q => { if (q > maxQ) maxQ = q; });
  });
  // Also check current order book
  Object.values(S.orderBook.bids).forEach(q => { if (q > maxQ) maxQ = q; });
  Object.values(S.orderBook.asks).forEach(q => { if (q > maxQ) maxQ = q; });
  if (maxQ === 0) maxQ = 1;
  
  // Calculate band height: divide visible price range by number of price levels
  // This makes bands thick enough to create the solid "wall" look
  const allPrices = [
    ...Object.keys(S.orderBook.bids).map(Number),
    ...Object.keys(S.orderBook.asks).map(Number)
  ].sort((a, b) => a - b);
  
  // Minimum gap between price levels determines band thickness
  let minGap = range * 0.01; // default
  for (let i = 1; i < allPrices.length; i++) {
    const gap = allPrices[i] - allPrices[i-1];
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  // Band height in pixels — make it thick enough to create solid coverage
  const bandPx = Math.max(4, (minGap / range) * chartH * 0.9);
  
  // Get visible DOM snapshots
  const visibleSnaps = S.domHistory.filter(s => s.time >= tStart - tRange*0.1 && s.time <= tEnd + tRange*0.1);
  
  if (visibleSnaps.length > 0) {
    const snapSpacing = chartDrawW / Math.max(1, visibleSnaps.length);
    
    visibleSnaps.forEach((snap, idx) => {
      let x;
      if (visibleSnaps.length < 10) {
        x = idx * snapSpacing;
      } else {
        x = ((snap.time - tStart) / tRange) * chartDrawW;
      }
      if (x < -20 || x > chartDrawW + 20) return;
      
      const colW = Math.max(3, snapSpacing + 1);
      
      // Bids — thick solid bands
      Object.entries(snap.bids).forEach(([p, q]) => {
        const price = +p;
        if (price < lo || price > hi) return;
        const y = ((hi - price) / range) * chartH;
        const intensity = Math.min(q / maxQ, 1);
        if (intensity < 0.02) return; // skip tiny orders
        ctx.fillStyle = heatColor(intensity);
        ctx.fillRect(x, y - bandPx/2, colW, bandPx);
      });
      
      // Asks — thick solid bands
      Object.entries(snap.asks).forEach(([p, q]) => {
        const price = +p;
        if (price < lo || price > hi) return;
        const y = ((hi - price) / range) * chartH;
        const intensity = Math.min(q / maxQ, 1);
        if (intensity < 0.02) return;
        ctx.fillStyle = heatColor(intensity);
        ctx.fillRect(x, y - bandPx/2, colW, bandPx);
      });
    });
  }
  
  // Current order book — paint as solid bands on right portion (live liquidity wall)
  const liveStartX = Math.max(0, chartDrawW - chartDrawW * 0.4);
  const liveW = chartDrawW * 0.4 + rightPad;
  
  Object.entries(S.orderBook.bids).forEach(([p, q]) => {
    const price = +p;
    if (price < lo || price > hi) return;
    const y = ((hi - price) / range) * chartH;
    const intensity = Math.min(q / maxQ, 1);
    if (intensity < 0.02) return;
    ctx.fillStyle = heatColor(intensity);
    ctx.fillRect(liveStartX, y - bandPx/2, liveW, bandPx);
  });
  Object.entries(S.orderBook.asks).forEach(([p, q]) => {
    const price = +p;
    if (price < lo || price > hi) return;
    const y = ((hi - price) / range) * chartH;
    const intensity = Math.min(q / maxQ, 1);
    if (intensity < 0.02) return;
    ctx.fillStyle = heatColor(intensity);
    ctx.fillRect(liveStartX, y - bandPx/2, liveW, bandPx);
  });
  
  // ─── 2. CANDLESTICKS (on top of heatmap) ───
  visible.forEach((c, i) => {
    const x = i * candleW + candleW / 2;
    const isGreen = c.close >= c.open;
    
    const oY = ((hi - c.open) / range) * chartH;
    const cY = ((hi - c.close) / range) * chartH;
    const hY = ((hi - c.high) / range) * chartH;
    const lY = ((hi - c.low) / range) * chartH;
    
    // Wick
    ctx.strokeStyle = isGreen ? '#3fb950' : '#f85149';
    ctx.lineWidth = Math.max(1, candleW * 0.12);
    ctx.beginPath(); ctx.moveTo(x, hY); ctx.lineTo(x, lY); ctx.stroke();
    
    // Body
    const top = Math.min(oY, cY);
    const height = Math.max(1, Math.abs(cY - oY));
    ctx.fillStyle = isGreen ? '#3fb950' : '#f85149';
    ctx.fillRect(x - bodyW/2, top, bodyW, height);
    
    // Outline for visibility against heatmap
    ctx.strokeStyle = isGreen ? 'rgba(63,185,80,0.4)' : 'rgba(248,81,73,0.4)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x - bodyW/2, top, bodyW, height);
  });
  
  // ─── 3. VOLUME BUBBLES (trades as sized circles) ───
  if (S.trades.length > 0) {
    const avgQ = S.trades.reduce((a,t) => a + t.qty, 0) / S.trades.length;
    
    S.trades.forEach(t => {
      if (t.time < tStart || t.time > tEnd) return;
      if (t.price < lo || t.price > hi) return;
      
      const x = ((t.time - tStart) / tRange) * chartDrawW;
      const y = ((hi - t.price) / range) * chartH;
      const rel = Math.min(t.qty / (avgQ || 1), 8);
      const r = Math.max(2, Math.min(12, rel * 2));
      
      // Glow
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 1.5);
      if (t.isBuy) {
        grad.addColorStop(0, 'rgba(63, 185, 80, 0.8)');
        grad.addColorStop(0.5, 'rgba(63, 185, 80, 0.3)');
        grad.addColorStop(1, 'rgba(63, 185, 80, 0)');
      } else {
        grad.addColorStop(0, 'rgba(248, 81, 73, 0.8)');
        grad.addColorStop(0.5, 'rgba(248, 81, 73, 0.3)');
        grad.addColorStop(1, 'rgba(248, 81, 73, 0)');
      }
      ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, Math.PI*2);
      ctx.fillStyle = grad; ctx.fill();
      
      // Core dot
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
      ctx.fillStyle = t.isBuy ? '#3fb950' : '#f85149';
      ctx.fill();
    });
  }
  
  // ─── 4. BEST BID & OFFER lines ───
  const bidPrices = Object.keys(S.orderBook.bids).map(Number);
  const askPrices = Object.keys(S.orderBook.asks).map(Number);
  if (bidPrices.length && askPrices.length) {
    const bestBid = Math.max(...bidPrices);
    const bestAsk = Math.min(...askPrices);
    
    if (bestBid > lo && bestBid < hi) {
      const y = ((hi - bestBid) / range) * chartH;
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = 'rgba(63, 185, 80, 0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(drawW, y); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (bestAsk > lo && bestAsk < hi) {
      const y = ((hi - bestAsk) / range) * chartH;
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = 'rgba(248, 81, 73, 0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(drawW, y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  
  // ─── Current price line ───
  if (S.currentPrice > lo && S.currentPrice < hi) {
    const py = ((hi - S.currentPrice) / range) * chartH;
    ctx.setLineDash([6, 3]);
    ctx.strokeStyle = '#d29922'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(drawW, py); ctx.stroke();
    ctx.setLineDash([]);
    // Price tag
    ctx.fillStyle = '#d29922';
    ctx.fillRect(drawW, py - 10, AXIS_W, 20);
    ctx.fillStyle = '#000'; ctx.font = 'bold 10px Consolas'; ctx.textAlign = 'left';
    ctx.fillText(fmt(S.currentPrice), drawW + 4, py + 4);
  }
  
  // ─── 5. VOLUME BARS (bottom section) ───
  let maxVol = 0;
  visible.forEach(c => { if (c.volume > maxVol) maxVol = c.volume; });
  
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, chartH, drawW, volH);
  ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, chartH); ctx.lineTo(drawW, chartH); ctx.stroke();
  
  if (maxVol > 0) {
    visible.forEach((c, i) => {
      const x = i * candleW + candleW / 2;
      const barH = (c.volume / maxVol) * (volH - 6);
      const isGreen = c.close >= c.open;
      
      // Split buy/sell
      const buyRatio = c.buyVolume ? c.buyVolume / c.volume : 0.5;
      const buyH = barH * buyRatio;
      const sellH = barH - buyH;
      
      // Sell (top)
      ctx.fillStyle = 'rgba(248, 81, 73, 0.5)';
      ctx.fillRect(x - bodyW/2, chartH + volH - barH, bodyW, sellH);
      // Buy (bottom)
      ctx.fillStyle = 'rgba(63, 185, 80, 0.5)';
      ctx.fillRect(x - bodyW/2, chartH + volH - buyH, bodyW, buyH);
    });
  }
  
  // ─── Price Axis ───
  ctx.fillStyle = '#0d1117'; ctx.fillRect(drawW, 0, AXIS_W, H);
  ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(drawW, 0); ctx.lineTo(drawW, H); ctx.stroke();
  
  ctx.font = '10px Consolas'; ctx.fillStyle = '#6e7681'; ctx.textAlign = 'left';
  const numLabels = Math.floor(chartH / 50);
  for (let i = 0; i <= numLabels; i++) {
    const y = (i / numLabels) * chartH;
    const price = hi - (i / numLabels) * range;
    ctx.fillText(fmt(price), drawW + 5, y + 4);
  }
  
  // ─── Time Axis ───
  ctx.font = '9px Consolas'; ctx.fillStyle = '#484f58'; ctx.textAlign = 'center';
  const numTimeLabels = Math.min(6, visible.length);
  for (let i = 0; i <= numTimeLabels; i++) {
    const x = (i / numTimeLabels) * drawW;
    const t = new Date(tStart + (i / numTimeLabels) * tRange);
    const lbl = S.currentTimeframe === '1D'
      ? t.toLocaleDateString([], {month:'short',day:'numeric'})
      : t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    ctx.fillText(lbl, x, H - 3);
  }
  
  // ─── Crosshair ───
  if (S.mouse && S.mouse.x < drawW && S.mouse.y < chartH) {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(139, 148, 158, 0.4)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(S.mouse.x, 0); ctx.lineTo(S.mouse.x, chartH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, S.mouse.y); ctx.lineTo(drawW, S.mouse.y); ctx.stroke();
    ctx.setLineDash([]);
    
    // Price at cursor
    const curPrice = hi - (S.mouse.y / chartH) * range;
    ctx.fillStyle = '#30363d'; ctx.fillRect(drawW, S.mouse.y - 9, AXIS_W, 18);
    ctx.fillStyle = '#e6edf3'; ctx.font = '10px Consolas'; ctx.textAlign = 'left';
    ctx.fillText(fmt(curPrice), drawW + 5, S.mouse.y + 4);
    
    // OHLC info at top
    const candleIdx = Math.floor(S.mouse.x / candleW);
    if (candleIdx >= 0 && candleIdx < visible.length) {
      const c = visible[candleIdx];
      const info = `O:${fmt(c.open)}  H:${fmt(c.high)}  L:${fmt(c.low)}  C:${fmt(c.close)}  V:${c.volume.toFixed(3)}`;
      ctx.fillStyle = 'rgba(13,17,23,0.9)'; ctx.fillRect(5, 5, ctx.measureText(info).width + 16, 20);
      ctx.fillStyle = '#e6edf3'; ctx.font = '10px Consolas'; ctx.textAlign = 'left';
      ctx.fillText(info, 13, 18);
    }
  }
  
  requestAnimationFrame(render);
}

// Bookmap heatmap color: dark blue → bright blue → cyan → yellow → orange → red
function heatColor(intensity) {
  const i = Math.max(0, Math.min(1, intensity));
  if (i < 0.1) return `rgba(20, 50, 120, 0.5)`;
  if (i < 0.25) return `rgba(30, 80, 180, 0.6)`;
  if (i < 0.4) return `rgba(0, 140, 200, 0.65)`;
  if (i < 0.55) return `rgba(50, 200, 180, 0.7)`;
  if (i < 0.7) return `rgba(200, 200, 0, 0.75)`;
  if (i < 0.85) return `rgba(255, 140, 0, 0.8)`;
  return `rgba(255, 40, 0, 0.85)`;
}



// ═══════════ SIDE PANEL UPDATES ═══════════
function renderSide() {
  // DOM ladder
  const bids = Object.entries(S.orderBook.bids).map(([p,q])=>({price:+p,qty:q})).sort((a,b)=>b.price-a.price).slice(0,10);
  const asks = Object.entries(S.orderBook.asks).map(([p,q])=>({price:+p,qty:q})).sort((a,b)=>a.price-b.price).slice(0,10);
  const mq = Math.max(...bids.map(b=>b.qty), ...asks.map(a=>a.qty), 1);
  
  let html = '';
  [...asks].reverse().forEach(l => {
    html += `<div class="dom-row"><div></div><div class="dom-price" style="color:#f85149">${fmt(l.price)}</div><div class="dom-ask">${l.qty.toFixed(3)}</div><div class="dom-bar-ask" style="width:${(l.qty/mq)*45}%"></div></div>`;
  });
  if (bids.length && asks.length) {
    const sp = asks[0].price - bids[0].price;
    html += `<div class="dom-row spread-row"><div></div><div class="dom-price" style="color:#d29922;font-size:9px">spread ${fmt(sp)}</div><div></div></div>`;
  }
  bids.forEach(l => {
    html += `<div class="dom-row"><div class="dom-bid">${l.qty.toFixed(3)}</div><div class="dom-price" style="color:#3fb950">${fmt(l.price)}</div><div></div><div class="dom-bar-bid" style="width:${(l.qty/mq)*45}%"></div></div>`;
  });
  document.getElementById('dom').innerHTML = html;
  
  // Events
  const evs = S.events.slice(-25).reverse();
  let evH = '';
  evs.forEach(ev => {
    const t = new Date(ev.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    let cls='', txt='';
    if (ev.type==='AGGRESSIVE_BUY') { cls='buy'; txt=`${t} BUY ${ev.size?.toFixed(3)||''} @${fmt(ev.price)}`; }
    else if (ev.type==='AGGRESSIVE_SELL') { cls='sell'; txt=`${t} SELL ${ev.size?.toFixed(3)||''} @${fmt(ev.price)}`; }
    else if (ev.type==='ORDER_PULL') { cls='pull'; txt=`${t} ${ev.side} PULL @${fmt(ev.price)}`; }
    else if (ev.type==='ORDER_STACK') { cls='stack'; txt=`${t} ${ev.side} STACK @${fmt(ev.price)}`; }
    else txt = `${t} ${ev.type}`;
    evH += `<div class="ev ${cls}">${txt}</div>`;
  });
  document.getElementById('events').innerHTML = evH;
  
  // Stats
  const bv = Object.values(S.orderBook.bids).reduce((a,b)=>a+b,0);
  const av = Object.values(S.orderBook.asks).reduce((a,b)=>a+b,0);
  const buys = S.trades.filter(t=>t.isBuy).reduce((a,t)=>a+t.qty,0);
  const sells = S.trades.filter(t=>!t.isBuy).reduce((a,t)=>a+t.qty,0);
  const bP = Object.keys(S.orderBook.bids).map(Number);
  const aP = Object.keys(S.orderBook.asks).map(Number);
  const sp = bP.length&&aP.length ? Math.min(...aP)-Math.max(...bP) : 0;
  const tot = bv+av;
  const im = tot>0 ? ((bv-av)/tot*100).toFixed(1) : '0';
  
  document.getElementById('sBid').textContent = bv.toFixed(2);
  document.getElementById('sAsk').textContent = av.toFixed(2);
  document.getElementById('sBuy').textContent = buys.toFixed(3);
  document.getElementById('sSell').textContent = sells.toFixed(3);
  document.getElementById('sSpread').textContent = fmt(sp);
  const ie = document.getElementById('sImbal');
  ie.textContent = im+'%'; ie.style.color = im>0?'#3fb950':im<0?'#f85149':'#8b949e';
  
  // Price
  const pe = document.getElementById('priceVal');
  pe.textContent = fmt(S.currentPrice);
  pe.style.color = S.candles.length>0 && S.currentPrice>=S.candles[S.candles.length-1].open ? '#3fb950' : '#f85149';
  
  // Countdown
  const tfMs = TF_MS[S.currentTimeframe] || 60000;
  const now = Date.now();
  const rem = (Math.floor(now/tfMs)*tfMs + tfMs) - now;
  const m = Math.floor(rem/60000);
  const s = Math.floor((rem%60000)/1000);
  document.getElementById('countdown').textContent = `${m}:${String(s).padStart(2,'0')}`;
  
  // Status
  document.getElementById('connDot').className = 'conn-dot' + (S.connected?' on':'');
  document.getElementById('connText').textContent = S.connected ? (S.serverConnected?'Live':'REST') : 'Offline';
  document.getElementById('sInst').textContent = S.instruments[S.currentInstrument]?.name || '';
  document.getElementById('sInfo').textContent = `${S.candles.length}c ${S.domHistory.length}snaps`;
}
setInterval(renderSide, 300);

// ═══════════ BUTTONS ═══════════
function buildButtons() {
  const ie = document.getElementById('instBtns');
  ie.innerHTML = '';
  Object.keys(S.instruments).forEach(k => {
    const b = document.createElement('button');
    b.className = 'btn inst' + (k===S.currentInstrument?' active':'');
    b.textContent = k; b.dataset.val = k;
    b.onclick = () => { send({type:'CHANGE_INSTRUMENT',instrument:k}); setActive('.inst',k); };
    ie.appendChild(b);
  });
  const te = document.getElementById('tfBtns');
  te.innerHTML = '';
  S.timeframes.forEach(tf => {
    const b = document.createElement('button');
    b.className = 'btn tf' + (tf===S.currentTimeframe?' active':'');
    b.textContent = tf; b.dataset.val = tf;
    b.onclick = () => { send({type:'CHANGE_TIMEFRAME',timeframe:tf}); setActive('.tf',tf); document.getElementById('sTf').textContent=tf; };
    te.appendChild(b);
  });
}
function setActive(sel, val) { document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b.dataset.val===val)); }
function updateUI() {
  document.getElementById('connDot').className = 'conn-dot' + (S.connected?' on':'');
  document.getElementById('connText').textContent = S.connected ? 'Connected' : 'Reconnecting';
}

// ═══════════ SMOOTH ZOOM & SCROLL (TradingView style) ═══════════
document.getElementById('zoomIn').onclick = () => { S.targetZoom = Math.min(S.targetZoom * 1.4, 10); };
document.getElementById('zoomOut').onclick = () => { S.targetZoom = Math.max(S.targetZoom / 1.4, 0.2); };
document.getElementById('zoomReset').onclick = () => { S.targetZoom = 1; S.targetScrollX = 0; };

// Mouse wheel = zoom (smooth)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.08 : 0.92;
  S.targetZoom = Math.max(0.2, Math.min(10, S.targetZoom * factor));
}, { passive: false });

// Drag = scroll (smooth)
canvas.addEventListener('mousedown', (e) => {
  S.dragging = true;
  S.dragStartX = e.clientX;
  S.dragStartScroll = S.targetScrollX;
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  S.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (S.dragging) {
    const dx = e.clientX - S.dragStartX;
    const pxPerCandle = (W - AXIS_W) * 0.88 / Math.round(80 / S.targetZoom);
    const candleShift = dx / pxPerCandle;
    S.targetScrollX = Math.max(0, Math.min(S.candles.length - 20, S.dragStartScroll + candleShift));
  }
});
canvas.addEventListener('mouseleave', () => { S.mouse = null; });
window.addEventListener('mouseup', () => { S.dragging = false; canvas.style.cursor = 'crosshair'; });
canvas.style.cursor = 'crosshair';

// ═══════════ HELPERS ═══════════
function fmt(p) {
  if (!p || p === 0) return '--';
  if (p > 10000) return p.toFixed(2);
  if (p > 100) return p.toFixed(2);
  if (p > 1) return p.toFixed(4);
  return p.toFixed(6);
}

// ═══════════ START ═══════════
connect();
render();
