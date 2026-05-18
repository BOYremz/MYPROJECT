/**
 * REAL BOOKMAP CLONE
 * - Heatmap: horizontal bands of liquidity colored by intensity
 * - Price line: yellow line moving through time
 * - Volume bubbles: green/red dots for trades
 * - DOM ladder, timeframes, zoom
 */

const S = {
  ws: null, connected: false, serverConnected: false,
  instruments: {}, currentInstrument: 'BTCUSD', currentTimeframe: '1m',
  timeframes: [], currentPrice: 0,
  orderBook: { bids: {}, asks: {} },
  candles: [], trades: [], events: [], domHistory: [],
  zoom: 1, offset: 0,
  dragging: false, dragStartX: 0, dragStartOff: 0,
  mouse: null,
};

const TF_MS = { '1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000,'1D':86400000 };
const canvas = document.getElementById('chartCanvas');
const ctx = canvas.getContext('2d');
let W, H;
const AXIS = 70;

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
  S.ws.onopen = () => { S.connected = true; updateConnUI(); };
  S.ws.onclose = () => { S.connected = false; updateConnUI(); setTimeout(connect, 2000); };
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
      S.orderBook = d.orderBook || { bids:{}, asks:{} };
      S.trades = d.trades || [];
      S.events = d.events || [];
      S.currentPrice = d.currentPrice;
      S.serverConnected = d.connected;
      buildBtns();
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
          if (!S.events.find(x => x.time === ev.time && x.type === ev.type)) S.events.push(ev);
        });
        if (S.events.length > 200) S.events = S.events.slice(-200);
      }
    } else if (d.type === 'INSTRUMENT_CHANGED') {
      S.currentInstrument = d.instrument;
      S.candles = d.candles || [];
      S.domHistory = d.domHistory || [];
      S.orderBook = d.orderBook || { bids:{}, asks:{} };
      S.currentPrice = d.currentPrice;
      S.events = []; S.offset = 0;
      setActive('.inst', d.instrument);
    } else if (d.type === 'TIMEFRAME_CHANGED') {
      S.currentTimeframe = d.timeframe;
      S.candles = d.candles || [];
      S.offset = 0;
      setActive('.tf', d.timeframe);
      document.getElementById('sTf').textContent = d.timeframe;
    }
  };
}

function send(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }

// ═══════════ MAIN RENDER ═══════════
function render() {
  ctx.clearRect(0, 0, W, H);
  
  if (S.candles.length < 1 || S.domHistory.length < 1) {
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.font = '14px Consolas'; ctx.fillStyle = '#00d4ff'; ctx.textAlign = 'center';
    ctx.fillText('Loading market data...', W/2, H/2);
    requestAnimationFrame(render);
    return;
  }
  
  const drawW = W - AXIS;
  
  // Determine visible candles
  const numVis = Math.max(20, Math.floor(80 / S.zoom));
  const start = Math.max(0, S.candles.length - numVis - S.offset);
  const end = Math.min(S.candles.length, start + numVis);
  const visible = S.candles.slice(start, end);
  if (visible.length === 0) { requestAnimationFrame(render); return; }
  
  // Price range from candles
  let hi = -Infinity, lo = Infinity;
  visible.forEach(c => { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); });
  
  // Also include current orderbook
  Object.keys(S.orderBook.bids).map(Number).forEach(p => { 
    if (p > S.currentPrice * 0.99 && p < S.currentPrice * 1.01) lo = Math.min(lo, p); 
  });
  Object.keys(S.orderBook.asks).map(Number).forEach(p => { 
    if (p > S.currentPrice * 0.99 && p < S.currentPrice * 1.01) hi = Math.max(hi, p); 
  });
  
  const pad = (hi - lo) * 0.15 || hi * 0.001;
  hi += pad; lo -= pad;
  const range = hi - lo || 1;
  
  // Time range from candles
  const tStart = visible[0].openTime;
  const tEnd = visible[visible.length-1].closeTime;
  const tRange = tEnd - tStart || 1;
  
  // ─── Background ───
  ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, drawW, H);
  
  // ─── Grid ───
  ctx.strokeStyle = 'rgba(48, 54, 61, 0.5)'; ctx.lineWidth = 0.5;
  ctx.setLineDash([2, 4]);
  for (let i = 0; i <= 8; i++) {
    const y = (i/8) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(drawW, y); ctx.stroke();
  }
  for (let i = 0; i <= 6; i++) {
    const x = (i/6) * drawW;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  ctx.setLineDash([]);
  
  // ─── HEATMAP - The structured bands like real Bookmap ───
  // Each DOM snapshot becomes a vertical column of colored pixels
  
  // Find max quantity across all snapshots for color scaling
  let maxQ = 0;
  S.domHistory.forEach(snap => {
    Object.values(snap.bids).forEach(q => { if (q > maxQ) maxQ = q; });
    Object.values(snap.asks).forEach(q => { if (q > maxQ) maxQ = q; });
  });
  if (maxQ === 0) maxQ = 1;
  
  // Build pixel-grid heatmap (price × time)
  const gridH = Math.min(200, H); // resolution
  const gridW = Math.min(200, drawW);
  const cellH = H / gridH;
  const cellW = drawW / gridW;
  
  // Map each DOM snapshot to a column
  const timeSpan = tRange;
  const pxStart = tStart;
  
  // Filter dom snapshots that fall in our time range
  const visSnaps = S.domHistory.filter(s => s.time >= pxStart - timeSpan*0.3 && s.time <= tEnd + timeSpan*0.3);
  
  // Draw heatmap
  visSnaps.forEach((snap, idx) => {
    const x = ((snap.time - tStart) / timeSpan) * drawW;
    if (x < -10 || x > drawW + 10) return;
    
    // Width per snapshot
    let nextSnap = visSnaps[idx + 1];
    const colW = nextSnap ? Math.max(2, ((nextSnap.time - snap.time) / timeSpan) * drawW) : 4;
    
    // Draw bid liquidity (below price)
    Object.entries(snap.bids).forEach(([p, q]) => {
      const price = parseFloat(p);
      if (price < lo || price > hi) return;
      const y = ((hi - price) / range) * H;
      const intensity = Math.min(q / maxQ, 1);
      const color = bookmapColor(intensity);
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 1, colW + 1, 3);
    });
    
    // Draw ask liquidity (above price)
    Object.entries(snap.asks).forEach(([p, q]) => {
      const price = parseFloat(p);
      if (price < lo || price > hi) return;
      const y = ((hi - price) / range) * H;
      const intensity = Math.min(q / maxQ, 1);
      const color = bookmapColor(intensity);
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 1, colW + 1, 3);
    });
  });
  
  // ─── PRICE LINE (yellow zigzag through candles) ───
  ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  visible.forEach((c, i) => {
    const x = ((c.openTime + (c.closeTime - c.openTime)/2 - tStart) / tRange) * drawW;
    const y = ((hi - c.close) / range) * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // Glow effect on price line
  ctx.strokeStyle = 'rgba(255, 215, 0, 0.3)'; ctx.lineWidth = 4;
  ctx.beginPath();
  visible.forEach((c, i) => {
    const x = ((c.openTime + (c.closeTime - c.openTime)/2 - tStart) / tRange) * drawW;
    const y = ((hi - c.close) / range) * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // Re-draw sharp line on top
  ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  visible.forEach((c, i) => {
    const x = ((c.openTime + (c.closeTime - c.openTime)/2 - tStart) / tRange) * drawW;
    const y = ((hi - c.close) / range) * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // ─── VOLUME BUBBLES (trades as circles on price line) ───
  if (S.trades.length > 0) {
    const avgQty = S.trades.reduce((a,t) => a+t.qty, 0) / S.trades.length;
    
    S.trades.forEach(t => {
      if (t.time < tStart || t.time > tEnd) return;
      if (t.price < lo || t.price > hi) return;
      const x = ((t.time - tStart) / tRange) * drawW;
      const y = ((hi - t.price) / range) * H;
      const rel = Math.min(t.qty / avgQty, 6);
      const r = Math.max(2, Math.min(10, rel * 2.5));
      
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      if (t.isBuy) {
        grad.addColorStop(0, 'rgba(63, 185, 80, 0.9)');
        grad.addColorStop(1, 'rgba(63, 185, 80, 0.1)');
      } else {
        grad.addColorStop(0, 'rgba(248, 81, 73, 0.9)');
        grad.addColorStop(1, 'rgba(248, 81, 73, 0.1)');
      }
      ctx.fillStyle = grad;
      ctx.fill();
      
      // Outline for big trades
      if (rel > 3) {
        ctx.strokeStyle = t.isBuy ? '#3fb950' : '#f85149';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });
  }
  
  // ─── Event markers ───
  S.events.forEach(ev => {
    if (ev.time < tStart || ev.time > tEnd) return;
    if (!ev.price || ev.price < lo || ev.price > hi) return;
    const x = ((ev.time - tStart) / tRange) * drawW;
    const y = ((hi - ev.price) / range) * H;
    
    if (ev.type === 'AGGRESSIVE_BUY') {
      ctx.fillStyle = '#3fb950'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('▲', x, y - 8);
    } else if (ev.type === 'AGGRESSIVE_SELL') {
      ctx.fillStyle = '#f85149'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('▼', x, y + 14);
    } else if (ev.type === 'ORDER_PULL') {
      ctx.fillStyle = '#d29922'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2); ctx.fill();
    } else if (ev.type === 'ORDER_STACK') {
      ctx.fillStyle = '#a371f7'; ctx.fillRect(x-3, y-3, 6, 6);
    }
  });
  
  // ─── Current price horizontal line ───
  if (S.currentPrice > lo && S.currentPrice < hi) {
    const py = ((hi - S.currentPrice) / range) * H;
    ctx.setLineDash([5,3]); ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(drawW, py); ctx.stroke();
    ctx.setLineDash([]);
    // Tag on right
    ctx.fillStyle = '#ffd700'; ctx.fillRect(drawW, py - 9, AXIS, 18);
    ctx.fillStyle = '#000'; ctx.font = 'bold 11px Consolas'; ctx.textAlign = 'left';
    ctx.fillText(fmt(S.currentPrice), drawW + 5, py + 4);
  }
  
  // ─── Price axis ───
  ctx.fillStyle = '#0d1117'; ctx.fillRect(drawW, 0, AXIS, H);
  ctx.strokeStyle = '#30363d'; ctx.beginPath(); ctx.moveTo(drawW, 0); ctx.lineTo(drawW, H); ctx.stroke();
  ctx.font = '10px Consolas'; ctx.fillStyle = '#6e7681'; ctx.textAlign = 'left';
  for (let i = 0; i <= 10; i++) {
    const y = (i/10) * H;
    const p = hi - (i/10) * range;
    ctx.fillText(fmt(p), drawW + 4, y + 3);
  }
  
  // ─── Time axis (bottom) ───
  ctx.font = '9px Consolas'; ctx.fillStyle = '#6e7681'; ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const x = (i/5) * drawW;
    const t = new Date(tStart + (i/5) * tRange);
    const lbl = S.currentTimeframe === '1D' 
      ? t.toLocaleDateString([], {month:'short', day:'numeric'})
      : t.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    ctx.fillText(lbl, x, H - 4);
  }
  
  // ─── Crosshair ───
  if (S.mouse && S.mouse.x < drawW) {
    ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(201, 209, 217, 0.3)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(S.mouse.x, 0); ctx.lineTo(S.mouse.x, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, S.mouse.y); ctx.lineTo(drawW, S.mouse.y); ctx.stroke();
    ctx.setLineDash([]);
    
    const cursorPrice = hi - (S.mouse.y / H) * range;
    ctx.fillStyle = '#21262d'; ctx.fillRect(drawW, S.mouse.y - 9, AXIS, 18);
    ctx.fillStyle = '#fff'; ctx.font = '10px Consolas'; ctx.textAlign = 'left';
    ctx.fillText(fmt(cursorPrice), drawW + 5, S.mouse.y + 4);
  }
  
  requestAnimationFrame(render);
}

// Bookmap-style color: blue→green→yellow→orange→red as intensity increases
function bookmapColor(intensity) {
  const i = Math.max(0, Math.min(1, intensity));
  let r, g, b, a;
  
  if (i < 0.15) {
    // Very low - faint blue
    r = 30; g = 80; b = 160; a = 0.15 + i * 1.5;
  } else if (i < 0.35) {
    // Low - cyan/teal
    const t = (i - 0.15) / 0.2;
    r = 30 + t * 70; g = 80 + t * 130; b = 160 + t * 30; a = 0.4;
  } else if (i < 0.55) {
    // Medium - green/yellow
    const t = (i - 0.35) / 0.2;
    r = 100 + t * 155; g = 210; b = 190 - t * 190; a = 0.55;
  } else if (i < 0.75) {
    // High - yellow/orange
    const t = (i - 0.55) / 0.2;
    r = 255; g = 210 - t * 80; b = 0; a = 0.7;
  } else {
    // Very high - red/hot
    const t = (i - 0.75) / 0.25;
    r = 255; g = 130 - t * 130; b = 0; a = 0.85;
  }
  
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

// ═══════════ SIDE PANELS ═══════════
function renderSide() {
  const bids = Object.entries(S.orderBook.bids).map(([p,q]) => ({price:+p, qty:q})).sort((a,b)=>b.price-a.price).slice(0,10);
  const asks = Object.entries(S.orderBook.asks).map(([p,q]) => ({price:+p, qty:q})).sort((a,b)=>a.price-b.price).slice(0,10);
  const mq = Math.max(...bids.map(b=>b.qty), ...asks.map(a=>a.qty), 1);
  
  let html = '';
  [...asks].reverse().forEach(l => {
    html += `<div class="dom-row"><div></div><div class="dom-price" style="color:#f85149">${fmt(l.price)}</div><div class="dom-ask">${l.qty.toFixed(3)}</div><div class="dom-bar-ask" style="width:${(l.qty/mq)*45}%"></div></div>`;
  });
  if (bids.length && asks.length) {
    const sp = asks[0].price - bids[0].price;
    html += `<div class="dom-row spread-row"><div></div><div class="dom-price" style="color:#d29922;font-size:9px">⟷ ${fmt(sp)}</div><div></div></div>`;
  }
  bids.forEach(l => {
    html += `<div class="dom-row"><div class="dom-bid">${l.qty.toFixed(3)}</div><div class="dom-price" style="color:#3fb950">${fmt(l.price)}</div><div></div><div class="dom-bar-bid" style="width:${(l.qty/mq)*45}%"></div></div>`;
  });
  document.getElementById('dom').innerHTML = html;
  
  // Events
  const evs = S.events.slice(-30).reverse();
  let evH = '';
  evs.forEach(ev => {
    const t = new Date(ev.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    let cls='', txt='';
    if (ev.type === 'AGGRESSIVE_BUY') { cls='buy'; txt=`${t} ▲ BUY ${ev.size?.toFixed(3)||''} @${fmt(ev.price)}`; }
    else if (ev.type === 'AGGRESSIVE_SELL') { cls='sell'; txt=`${t} ▼ SELL ${ev.size?.toFixed(3)||''} @${fmt(ev.price)}`; }
    else if (ev.type === 'ORDER_PULL') { cls='pull'; txt=`${t} ⚠ ${ev.side} PULL @${fmt(ev.price)}`; }
    else if (ev.type === 'ORDER_STACK') { cls='stack'; txt=`${t} ■ ${ev.side} STACK @${fmt(ev.price)}`; }
    else txt=`${t} ${ev.type}`;
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
  document.getElementById('sBuy').textContent = buys.toFixed(2);
  document.getElementById('sSell').textContent = sells.toFixed(2);
  document.getElementById('sSpread').textContent = fmt(sp);
  const ie = document.getElementById('sImbal');
  ie.textContent = im+'%';
  ie.style.color = im>0?'#3fb950':im<0?'#f85149':'#888';
  
  // Price
  const pe = document.getElementById('priceVal');
  pe.textContent = fmt(S.currentPrice);
  if (S.candles.length>0) {
    pe.style.color = S.currentPrice >= S.candles[S.candles.length-1].open ? '#3fb950' : '#f85149';
  }
  
  // Countdown
  const tfMs = TF_MS[S.currentTimeframe] || 60000;
  const now = Date.now();
  const rem = (Math.floor(now/tfMs)*tfMs + tfMs) - now;
  const m = Math.floor(rem/60000);
  const s = Math.floor((rem%60000)/1000);
  document.getElementById('countdown').textContent = `${m}:${s.toString().padStart(2,'0')}`;
  
  // Status
  document.getElementById('connDot').className = 'conn-dot' + (S.connected?' on':'');
  document.getElementById('connText').textContent = S.connected ? (S.serverConnected?'Live WS':'REST') : 'Offline';
  document.getElementById('sInst').textContent = S.instruments[S.currentInstrument]?.name || S.currentInstrument;
  document.getElementById('sInfo').textContent = `${S.candles.length}c | ${S.domHistory.length}snap | ${S.trades.length}t`;
}

setInterval(renderSide, 250);

// ═══════════ BUTTONS ═══════════
function buildBtns() {
  const ie = document.getElementById('instBtns');
  ie.innerHTML = '';
  Object.keys(S.instruments).forEach(k => {
    const b = document.createElement('button');
    b.className = 'btn inst' + (k===S.currentInstrument?' active':'');
    b.textContent = k; b.dataset.val = k;
    b.onclick = () => { send({type:'CHANGE_INSTRUMENT',instrument:k}); setActive('.inst',k); S.candles=[]; S.domHistory=[]; };
    ie.appendChild(b);
  });
  const te = document.getElementById('tfBtns');
  te.innerHTML = '';
  S.timeframes.forEach(tf => {
    const b = document.createElement('button');
    b.className = 'btn tf' + (tf===S.currentTimeframe?' active':'');
    b.textContent = tf; b.dataset.val = tf;
    b.onclick = () => { send({type:'CHANGE_TIMEFRAME',timeframe:tf}); setActive('.tf',tf); S.offset=0; document.getElementById('sTf').textContent=tf; };
    te.appendChild(b);
  });
}

function setActive(sel, val) {
  document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b.dataset.val===val));
}

function updateConnUI() {
  document.getElementById('connDot').className = 'conn-dot' + (S.connected?' on':'');
  document.getElementById('connText').textContent = S.connected ? 'Connected' : 'Reconnecting';
}

// ═══════════ CONTROLS ═══════════
document.getElementById('zoomIn').onclick = () => { S.zoom = Math.min(S.zoom*1.3, 8); };
document.getElementById('zoomOut').onclick = () => { S.zoom = Math.max(S.zoom/1.3, 0.3); };
document.getElementById('zoomReset').onclick = () => { S.zoom = 1; S.offset = 0; };

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  S.zoom = e.deltaY < 0 ? Math.min(S.zoom*1.1, 8) : Math.max(S.zoom/1.1, 0.3);
});

canvas.addEventListener('mousedown', (e) => {
  S.dragging = true; S.dragStartX = e.clientX; S.dragStartOff = S.offset;
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  S.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (S.dragging) {
    const dx = e.clientX - S.dragStartX;
    const cw = (W - AXIS) / Math.max(20, Math.floor(80/S.zoom));
    S.offset = Math.max(0, Math.min(S.candles.length - 10, S.dragStartOff + Math.round(dx/cw)));
  }
});

canvas.addEventListener('mouseleave', () => { S.mouse = null; });
window.addEventListener('mouseup', () => { S.dragging = false; canvas.style.cursor = 'crosshair'; });

// ═══════════ HELPERS ═══════════
function fmt(p) {
  if (!p || p === 0) return '--';
  if (p > 1000) return p.toFixed(2);
  if (p > 1) return p.toFixed(4);
  return p.toFixed(6);
}

connect();
render();
