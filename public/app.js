/**
 * FREE BOOKMAP - Volume Dots + Heatmap Style
 */

const S = {
  ws: null, connected: false, serverConnected: false,
  instruments: {}, currentInstrument: 'BTCUSD', currentTimeframe: '1m',
  timeframes: [], currentPrice: 0,
  orderBook: { bids: {}, asks: {} },
  candles: [], volumeDots: [], trades: [], events: [],
  zoom: 1, offsetX: 0, dragging: false, dragStartX: 0, dragStartOff: 0,
};

const TF_MS = { '1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000,'1D':86400000 };
const canvas = document.getElementById('chartCanvas');
const ctx = canvas.getContext('2d');
let W, H;
const AXIS_W = 70;

function resize() {
  const area = document.getElementById('chartArea');
  W = area.clientWidth; H = area.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize(); setTimeout(resize, 100);

// ═══════════ WEBSOCKET ═══════════
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  S.ws = new WebSocket(`${proto}//${location.host}`);
  S.ws.onopen = () => { S.connected = true; ui(); };
  S.ws.onclose = () => { S.connected = false; ui(); setTimeout(connect, 2000); };
  S.ws.onerror = () => { S.connected = false; };
  S.ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    switch(d.type) {
      case 'INIT':
        S.instruments = d.instruments || {};
        S.currentInstrument = d.config.currentInstrument;
        S.currentTimeframe = d.config.currentTimeframe;
        S.timeframes = d.timeframes || [];
        S.candles = d.candles || [];
        S.volumeDots = d.volumeDots || [];
        S.orderBook = d.orderBook || { bids:{}, asks:{} };
        S.events = d.events || [];
        S.currentPrice = d.currentPrice;
        S.serverConnected = d.connected;
        buildBtns();
        break;
      case 'UPDATE':
        S.orderBook = d.orderBook || S.orderBook;
        S.currentPrice = d.currentPrice || S.currentPrice;
        S.trades = d.trades || [];
        S.serverConnected = d.connected;
        if (d.currentCandle && S.candles.length > 0) {
          const last = S.candles[S.candles.length-1];
          if (last.openTime === d.currentCandle.openTime) S.candles[S.candles.length-1] = d.currentCandle;
          else S.candles.push(d.currentCandle);
        } else if (d.currentCandle) S.candles.push(d.currentCandle);
        if (d.volumeDots) {
          d.volumeDots.forEach(dot => {
            if (!S.volumeDots.find(x => x.time === dot.time && x.price === dot.price)) S.volumeDots.push(dot);
          });
          if (S.volumeDots.length > 5000) S.volumeDots = S.volumeDots.slice(-5000);
        }
        if (d.events) {
          d.events.forEach(ev => {
            if (!S.events.find(x => x.time === ev.time && x.type === ev.type)) S.events.push(ev);
          });
          if (S.events.length > 200) S.events = S.events.slice(-200);
        }
        break;
      case 'INSTRUMENT_CHANGED':
        S.currentInstrument = d.instrument;
        S.candles = d.candles || [];
        S.volumeDots = d.volumeDots || [];
        S.orderBook = d.orderBook || { bids:{}, asks:{} };
        S.currentPrice = d.currentPrice;
        S.events = []; S.offsetX = 0;
        setActive('.inst', d.instrument);
        break;
      case 'TIMEFRAME_CHANGED':
        S.currentTimeframe = d.timeframe;
        S.candles = d.candles || [];
        S.offsetX = 0;
        setActive('.tf', d.timeframe);
        document.getElementById('sTf').textContent = d.timeframe;
        break;
    }
  };
}

function send(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }

// ═══════════ BOOKMAP CHART RENDERING ═══════════
function render() {
  ctx.clearRect(0, 0, W, H);
  
  if (S.candles.length < 1 && S.currentPrice === 0) {
    ctx.fillStyle = '#0a0a12'; ctx.fillRect(0, 0, W, H);
    ctx.font = '14px Courier New'; ctx.fillStyle = '#00e5ff'; ctx.textAlign = 'center';
    ctx.fillText('Loading market data...', W/2, H/2 - 10);
    ctx.font = '11px Courier New'; ctx.fillStyle = '#555';
    ctx.fillText('Fetching from Binance REST API', W/2, H/2 + 15);
    requestAnimationFrame(render); return;
  }

  const drawW = W - AXIS_W;
  
  // Get visible candles
  const numVisible = Math.floor(80 / S.zoom);
  const start = Math.max(0, S.candles.length - numVisible - S.offsetX);
  const end = Math.min(S.candles.length, start + numVisible);
  const visible = S.candles.slice(start, end);
  
  if (visible.length === 0) { requestAnimationFrame(render); return; }
  
  // Price range
  let hi = -Infinity, lo = Infinity;
  visible.forEach(c => { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); });
  const pad = (hi - lo) * 0.1 || hi * 0.001;
  hi += pad; lo -= pad;
  const range = hi - lo || 1;
  
  const candleW = drawW / numVisible;
  const timeStart = visible[0].openTime;
  const timeEnd = visible[visible.length-1].closeTime;
  const timeRange = timeEnd - timeStart || 1;
  
  // ─── Grid ───
  ctx.strokeStyle = 'rgba(40,40,60,0.3)'; ctx.lineWidth = 0.5;
  ctx.setLineDash([2,4]);
  for (let i = 0; i <= 8; i++) {
    const y = (i/8)*H;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(drawW,y); ctx.stroke();
  }
  ctx.setLineDash([]);
  
  // ─── Heatmap (order book depth bands) ───
  const maxQ = Math.max(...Object.values(S.orderBook.bids), ...Object.values(S.orderBook.asks), 1);
  Object.entries(S.orderBook.bids).forEach(([p, q]) => {
    const price = +p;
    if (price < lo || price > hi) return;
    const y = ((hi - price) / range) * H;
    const intensity = Math.min(q / maxQ, 1);
    ctx.fillStyle = `rgba(0,200,83,${0.03 + intensity * 0.25})`;
    ctx.fillRect(drawW * 0.6, y - 2, drawW * 0.4, 4);
  });
  Object.entries(S.orderBook.asks).forEach(([p, q]) => {
    const price = +p;
    if (price < lo || price > hi) return;
    const y = ((hi - price) / range) * H;
    const intensity = Math.min(q / maxQ, 1);
    ctx.fillStyle = `rgba(255,53,71,${0.03 + intensity * 0.25})`;
    ctx.fillRect(drawW * 0.6, y - 2, drawW * 0.4, 4);
  });
  
  // ─── Price line (yellow) through candle closes ───
  ctx.strokeStyle = '#ffaa00'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  visible.forEach((c, i) => {
    const x = i * candleW + candleW / 2;
    const y = ((hi - c.close) / range) * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // ─── Volume Dots (BOOKMAP STYLE!) ───
  S.volumeDots.forEach(dot => {
    if (dot.time < timeStart || dot.time > timeEnd) return;
    if (dot.price < lo || dot.price > hi) return;
    
    const x = ((dot.time - timeStart) / timeRange) * drawW;
    const y = ((hi - dot.price) / range) * H;
    
    // Size based on quantity (bigger trade = bigger dot)
    const avgSize = S.trades.length > 0 ? S.trades.reduce((a,t) => a + t.qty, 0) / S.trades.length : dot.qty;
    const relSize = Math.min(dot.qty / (avgSize || 1), 5);
    const radius = Math.max(2, Math.min(8, relSize * 3));
    
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    
    if (dot.isBuy) {
      ctx.fillStyle = `rgba(38, 166, 154, ${0.4 + relSize * 0.12})`;
    } else {
      ctx.fillStyle = `rgba(239, 83, 80, ${0.4 + relSize * 0.12})`;
    }
    ctx.fill();
    
    // Outline for large trades
    if (relSize > 2) {
      ctx.strokeStyle = dot.isBuy ? '#26a69a' : '#ef5350';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });
  
  // ─── Event markers ───
  S.events.forEach(ev => {
    if (ev.time < timeStart || ev.time > timeEnd) return;
    if (!ev.price || ev.price < lo || ev.price > hi) return;
    const x = ((ev.time - timeStart) / timeRange) * drawW;
    const y = ((hi - ev.price) / range) * H;
    
    switch(ev.type) {
      case 'AGGRESSIVE_BUY':
        ctx.font = '12px sans-serif'; ctx.fillStyle = '#00e676'; ctx.textAlign = 'center';
        ctx.fillText('▲', x, y - 8); break;
      case 'AGGRESSIVE_SELL':
        ctx.font = '12px sans-serif'; ctx.fillStyle = '#ff1744'; ctx.textAlign = 'center';
        ctx.fillText('▼', x, y + 12); break;
      case 'ORDER_PULL':
        ctx.fillStyle = '#ffab00'; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI*2); ctx.fill(); break;
      case 'ORDER_STACK':
        ctx.fillStyle = '#7c4dff'; ctx.fillRect(x-4, y-4, 8, 8); break;
    }
  });
  
  // ─── Current price line ───
  if (S.currentPrice > lo && S.currentPrice < hi) {
    const py = ((hi - S.currentPrice) / range) * H;
    ctx.setLineDash([5,3]); ctx.strokeStyle = '#ffaa00'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(drawW, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffaa00'; ctx.fillRect(drawW, py-8, AXIS_W, 16);
    ctx.fillStyle = '#000'; ctx.font = '10px Courier New'; ctx.textAlign = 'left';
    ctx.fillText(fmtP(S.currentPrice), drawW+4, py+3);
  }
  
  // ─── Price axis ───
  ctx.fillStyle = 'rgba(13,13,21,0.95)'; ctx.fillRect(drawW, 0, AXIS_W, H);
  ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(drawW, 0); ctx.lineTo(drawW, H); ctx.stroke();
  ctx.font = '9px Courier New'; ctx.fillStyle = '#666'; ctx.textAlign = 'left';
  for (let i = 0; i <= 10; i++) {
    const y = (i/10)*H;
    const p = hi - (i/10)*range;
    ctx.fillText(fmtP(p), drawW+4, y+3);
  }
  
  // ─── Time axis ───
  ctx.font = '8px Courier New'; ctx.fillStyle = '#444'; ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const x = (i/5) * drawW;
    const t = new Date(timeStart + (i/5)*timeRange);
    ctx.fillText(t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), x, H-4);
  }
  
  requestAnimationFrame(render);
}

// ═══════════ DOM / EVENTS / STATS ═══════════
function renderSide() {
  // DOM
  const el = document.getElementById('domLadder');
  const bids = Object.entries(S.orderBook.bids).map(([p,q])=>({price:+p,qty:q})).sort((a,b)=>b.price-a.price).slice(0,10);
  const asks = Object.entries(S.orderBook.asks).map(([p,q])=>({price:+p,qty:q})).sort((a,b)=>a.price-b.price).slice(0,10);
  const mq = Math.max(...bids.map(b=>b.qty), ...asks.map(a=>a.qty), 1);
  
  let html = '';
  [...asks].reverse().forEach(l => {
    html += `<div class="dom-row"><div class="dom-bid"></div><div class="dom-price" style="color:#ef5350">${fmtP(l.price)}</div><div class="dom-ask">${l.qty.toFixed(3)}</div><div class="dom-bar-ask" style="width:${(l.qty/mq)*45}%"></div></div>`;
  });
  if (bids.length && asks.length) {
    const sp = asks[0].price - bids[0].price;
    html += `<div class="dom-row"><div></div><div class="dom-price" style="color:#ffaa00;font-size:8px">~ ${fmtP(sp)}</div><div></div></div>`;
  }
  bids.forEach(l => {
    html += `<div class="dom-row"><div class="dom-bid">${l.qty.toFixed(3)}</div><div class="dom-price" style="color:#26a69a">${fmtP(l.price)}</div><div class="dom-ask"></div><div class="dom-bar-bid" style="width:${(l.qty/mq)*45}%"></div></div>`;
  });
  el.innerHTML = html;
  
  // Events
  const evEl = document.getElementById('eventsLog');
  const evs = S.events.filter(e=>e.type!=='MARKET_ORDER').slice(-30).reverse();
  let evHtml = '';
  evs.forEach(ev => {
    const t = new Date(ev.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    let cls='', txt='';
    switch(ev.type) {
      case 'AGGRESSIVE_BUY': cls='buy'; txt=`${t} ▲ BUY ${ev.size?.toFixed(4)||''} @ ${fmtP(ev.price)}`; break;
      case 'AGGRESSIVE_SELL': cls='sell'; txt=`${t} ▼ SELL ${ev.size?.toFixed(4)||''} @ ${fmtP(ev.price)}`; break;
      case 'ORDER_PULL': cls='pull'; txt=`${t} ⚠ ${ev.side} PULL @ ${fmtP(ev.price)}`; break;
      case 'ORDER_STACK': cls='stack'; txt=`${t} ■ ${ev.side} STACK @ ${fmtP(ev.price)}`; break;
      default: txt=`${t} ${ev.type}`; break;
    }
    evHtml += `<div class="ev ${cls}">${txt}</div>`;
  });
  evEl.innerHTML = evHtml;
  
  // Stats
  const bidV = Object.values(S.orderBook.bids).reduce((a,b)=>a+b,0);
  const askV = Object.values(S.orderBook.asks).reduce((a,b)=>a+b,0);
  const buys = S.trades.filter(t=>t.isBuy);
  const sells = S.trades.filter(t=>!t.isBuy);
  const bP = Object.keys(S.orderBook.bids).map(Number);
  const aP = Object.keys(S.orderBook.asks).map(Number);
  const spread = bP.length&&aP.length ? Math.min(...aP)-Math.max(...bP) : 0;
  const tot = bidV+askV;
  const imb = tot>0 ? ((bidV-askV)/tot*100).toFixed(1) : '0';
  
  document.getElementById('sBid').textContent = bidV.toFixed(2);
  document.getElementById('sAsk').textContent = askV.toFixed(2);
  document.getElementById('sBuy').textContent = buys.reduce((a,t)=>a+t.qty,0).toFixed(3);
  document.getElementById('sSell').textContent = sells.reduce((a,t)=>a+t.qty,0).toFixed(3);
  document.getElementById('sSpread').textContent = fmtP(spread);
  const imbEl = document.getElementById('sImbal');
  imbEl.textContent = imb+'%';
  imbEl.style.color = imb>0?'#26a69a':imb<0?'#ef5350':'#888';
  
  // Price
  const pEl = document.getElementById('priceVal');
  pEl.textContent = fmtP(S.currentPrice);
  pEl.style.color = S.candles.length>0 && S.currentPrice >= S.candles[S.candles.length-1].open ? '#26a69a' : '#ef5350';
  
  // Countdown
  const tfMs = TF_MS[S.currentTimeframe]||60000;
  const now = Date.now();
  const rem = (Math.floor(now/tfMs)*tfMs + tfMs) - now;
  const m = Math.floor(rem/60000);
  const s = Math.floor((rem%60000)/1000);
  document.getElementById('countdown').textContent = `${m}:${s.toString().padStart(2,'0')}`;
  
  // Status
  document.getElementById('sDot').className = 'status-dot' + (S.connected?' on':'');
  document.getElementById('sConn').textContent = S.connected ? (S.serverConnected?'Live':'REST') : 'Offline';
  document.getElementById('sInst').textContent = S.instruments[S.currentInstrument]?.name || S.currentInstrument;
  document.getElementById('sInfo').textContent = `${S.candles.length} candles | ${S.volumeDots.length} dots`;
}

setInterval(renderSide, 300);

// ═══════════ BUTTONS ═══════════
function buildBtns() {
  const iEl = document.getElementById('instBtns');
  iEl.innerHTML = '';
  Object.keys(S.instruments).forEach(k => {
    const b = document.createElement('button');
    b.className = 'btn inst' + (k===S.currentInstrument?' active':'');
    b.textContent = k; b.dataset.val = k;
    b.onclick = () => { send({type:'CHANGE_INSTRUMENT',instrument:k}); S.volumeDots=[]; S.candles=[]; setActive('.inst',k); };
    iEl.appendChild(b);
  });
  
  const tEl = document.getElementById('tfBtns');
  tEl.innerHTML = '';
  S.timeframes.forEach(tf => {
    const b = document.createElement('button');
    b.className = 'btn tf' + (tf===S.currentTimeframe?' active':'');
    b.textContent = tf; b.dataset.val = tf;
    b.onclick = () => { send({type:'CHANGE_TIMEFRAME',timeframe:tf}); S.offsetX=0; setActive('.tf',tf); document.getElementById('sTf').textContent=tf; };
    tEl.appendChild(b);
  });
}

function setActive(sel, val) {
  document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b.dataset.val===val));
}

function ui() {
  document.getElementById('sDot').className = 'status-dot' + (S.connected?' on':'');
  document.getElementById('sConn').textContent = S.connected?'Connected':'Reconnecting';
}

// ═══════════ CONTROLS ═══════════
document.getElementById('zoomIn').onclick = () => { S.zoom = Math.min(S.zoom*1.3, 8); };
document.getElementById('zoomOut').onclick = () => { S.zoom = Math.max(S.zoom/1.3, 0.3); };
document.getElementById('zoomReset').onclick = () => { S.zoom = 1; S.offsetX = 0; };

canvas.addEventListener('wheel', (e) => { e.preventDefault(); S.zoom = e.deltaY<0 ? Math.min(S.zoom*1.1,8) : Math.max(S.zoom/1.1,0.3); });
canvas.addEventListener('mousedown', (e) => { S.dragging=true; S.dragStartX=e.clientX; S.dragStartOff=S.offsetX; canvas.style.cursor='grabbing'; });
window.addEventListener('mousemove', (e) => { if (!S.dragging) return; const dx=e.clientX-S.dragStartX; const cw=(W-AXIS_W)/Math.floor(80/S.zoom); S.offsetX=Math.max(0,S.dragStartOff+Math.round(dx/cw)); S.offsetX=Math.min(S.offsetX,Math.max(0,S.candles.length-10)); });
window.addEventListener('mouseup', () => { S.dragging=false; canvas.style.cursor='crosshair'; });
canvas.style.cursor = 'crosshair';

// ═══════════ HELPERS ═══════════
function fmtP(p) { if (!p) return '--'; return p > 1000 ? p.toFixed(2) : p > 1 ? p.toFixed(4) : p.toFixed(6); }

// ═══════════ START ═══════════
connect();
render();
