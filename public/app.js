/**
 * CLEAN TRADINGVIEW + LIQUIDITY HEATMAP
 * - Professional candlestick chart (like TradingView)
 * - Liquidity heatmap behind candles showing where orders sit
 * - Smooth zoom/scroll
 * - Identify support/resistance, see large traders, spot breakouts
 */

const S = {
  ws: null, connected: false, serverConnected: false,
  instruments: {}, currentInstrument: 'BTCUSD', currentTimeframe: '1m',
  timeframes: [], currentPrice: 0,
  orderBook: { bids: {}, asks: {} },
  candles: [], trades: [], events: [], domHistory: [],
  zoom: 1, targetZoom: 1,
  scrollX: 0, targetScrollX: 0,
  dragging: false, dragStartX: 0, dragStartScroll: 0,
  mouse: null,
  animSpeed: 0.12,
  showFootprint: true, // Volume Footprint toggle
};

const TF_MS = {'1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000,'1D':86400000};
const canvas = document.getElementById('chartCanvas');
const ctx = canvas.getContext('2d');
let W, H;
const AXIS_W = 75;

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

// ═══════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  S.ws = new WebSocket(`${proto}//${location.host}`);
  S.ws.onopen = () => { S.connected = true; updateUI(); };
  S.ws.onclose = () => { S.connected = false; updateUI(); setTimeout(connect, 2000); };
  S.ws.onerror = () => { S.connected = false; };
  S.ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'INIT') {
      Object.assign(S, {
        instruments: d.instruments || {},
        currentInstrument: d.config.currentInstrument,
        currentTimeframe: d.config.currentTimeframe,
        timeframes: d.timeframes || [],
        candles: d.candles || [],
        domHistory: d.domHistory || [],
        orderBook: d.orderBook || {bids:{},asks:{}},
        trades: d.trades || [],
        events: d.events || [],
        currentPrice: d.currentPrice,
        serverConnected: d.connected,
      });
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
function lerp(a, b, t) { return a + (b - a) * t; }

// ═══════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════
function render() {
  S.zoom = lerp(S.zoom, S.targetZoom, S.animSpeed);
  S.scrollX = lerp(S.scrollX, S.targetScrollX, S.animSpeed);
  ctx.clearRect(0, 0, W, H);

  if (S.candles.length < 2) {
    ctx.fillStyle = '#131722'; ctx.fillRect(0, 0, W, H);
    ctx.font = '14px -apple-system, sans-serif'; ctx.fillStyle = '#5d6d7e'; ctx.textAlign = 'center';
    ctx.fillText('Connecting to market...', W/2, H/2);
    requestAnimationFrame(render); return;
  }

  const drawW = W - AXIS_W;
  const volH = 50;
  const chartH = H - volH;
  const rightPad = drawW * 0.10; // space after last candle
  const candleArea = drawW - rightPad;

  // Visible candles
  const numVis = Math.max(15, Math.round(60 / S.zoom));
  const scroll = Math.round(S.scrollX);
  const endIdx = Math.max(numVis, S.candles.length - scroll);
  const startIdx = Math.max(0, endIdx - numVis);
  const vis = S.candles.slice(startIdx, endIdx);
  if (vis.length < 2) { requestAnimationFrame(render); return; }

  // Price range
  let hi = -Infinity, lo = Infinity;
  vis.forEach(c => { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); });
  const pricePad = (hi - lo) * 0.1 || hi * 0.001;
  hi += pricePad; lo -= pricePad;
  const priceRange = hi - lo || 1;

  // Time
  const tStart = vis[0].openTime;
  const tEnd = vis[vis.length-1].closeTime;
  const tRange = tEnd - tStart || 1;

  const cW = candleArea / vis.length;
  const bW = Math.max(1, cW * 0.6);

  // ── Background ──
  ctx.fillStyle = '#131722';
  ctx.fillRect(0, 0, W, H);

  // ── Grid ──
  ctx.strokeStyle = '#1e222d'; ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const y = (i/6)*chartH;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(drawW,y); ctx.stroke();
  }

  // ══════════════════════════════════════════════════════════════
  // LIQUIDITY HEATMAP (behind candles - FULL WIDTH)
  // Shows where passive buyers/sellers are sitting
  // Painted across the ENTIRE chart so it's always visible
  // ══════════════════════════════════════════════════════════════
  
  // Find max order size for color scaling
  let maxQ = 1;
  Object.values(S.orderBook.bids).forEach(q => { if (q > maxQ) maxQ = q; });
  Object.values(S.orderBook.asks).forEach(q => { if (q > maxQ) maxQ = q; });

  // Calculate how thick each band should be (based on price level spacing)
  const prices = [...Object.keys(S.orderBook.bids), ...Object.keys(S.orderBook.asks)].map(Number).sort((a,b)=>a-b);
  let tickSize = priceRange * 0.005;
  for (let i = 1; i < prices.length; i++) {
    const gap = prices[i] - prices[i-1];
    if (gap > 0 && gap < tickSize) tickSize = gap;
  }
  const bandH = Math.max(4, Math.min(14, (tickSize / priceRange) * chartH));

  // Paint current order book as FULL-WIDTH horizontal bands
  // This is the key: liquidity bands span the ENTIRE chart width
  // so they're always visible regardless of zoom or scroll
  
  // BIDS = passive buyers below price (GREEN support zones)
  Object.entries(S.orderBook.bids).forEach(([p, q]) => {
    const price = +p;
    if (price < lo || price > hi) return;
    const y = ((hi - price) / priceRange) * chartH;
    const strength = q / maxQ;
    if (strength < 0.03) return;
    ctx.fillStyle = liquidityColor(strength);
    // Full width band from left edge to right edge
    ctx.fillRect(0, y - bandH/2, drawW, bandH);
  });
  
  // ASKS = passive sellers above price (RED resistance zones)
  Object.entries(S.orderBook.asks).forEach(([p, q]) => {
    const price = +p;
    if (price < lo || price > hi) return;
    const y = ((hi - price) / priceRange) * chartH;
    const strength = q / maxQ;
    if (strength < 0.03) return;
    ctx.fillStyle = liquidityColor(strength);
    // Full width band from left edge to right edge
    ctx.fillRect(0, y - bandH/2, drawW, bandH);
  });

  // ══════════════════════════════════════════════════════════════
  // CANDLESTICKS (TradingView style)
  // ══════════════════════════════════════════════════════════════
  vis.forEach((c, i) => {
    const x = i * cW + cW / 2;
    const green = c.close >= c.open;
    const oY = ((hi - c.open) / priceRange) * chartH;
    const cY = ((hi - c.close) / priceRange) * chartH;
    const hY = ((hi - c.high) / priceRange) * chartH;
    const lY = ((hi - c.low) / priceRange) * chartH;

    // Wick
    ctx.strokeStyle = green ? '#26a69a' : '#ef5350';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, hY); ctx.lineTo(x, lY); ctx.stroke();

    // Body
    const top = Math.min(oY, cY);
    const h = Math.max(1, Math.abs(cY - oY));
    ctx.fillStyle = green ? '#26a69a' : '#ef5350';
    ctx.fillRect(x - bW/2, top, bW, h);
  });

  // ══════════════════════════════════════════════════════════════
  // VOLUME FOOTPRINT (Buy vs Sell pressure at each price level)
  // Shows the bid/ask volume breakdown INSIDE each candle bar
  // Green bars = aggressive buyers (lifting the ask)
  // Red bars = aggressive sellers (hitting the bid)
  // ══════════════════════════════════════════════════════════════
  if (S.showFootprint) {
    // Find max volume across all visible footprints for normalization
    let maxFpVol = 0;
    vis.forEach(c => {
      if (!c.footprint) return;
      Object.values(c.footprint).forEach(fp => {
        const total = fp.buy + fp.sell;
        if (total > maxFpVol) maxFpVol = total;
      });
    });

    vis.forEach((c, i) => {
      if (!c.footprint) return;
      const x = i * cW + cW / 2;
      const fpEntries = Object.entries(c.footprint).sort((a,b) => +b[0] - +a[0]); // high to low
      if (fpEntries.length === 0) return;

      // Calculate row height based on candle's price range and number of levels
      const candleHighY = ((hi - c.high) / priceRange) * chartH;
      const candleLowY = ((hi - c.low) / priceRange) * chartH;
      const candlePixelH = candleLowY - candleHighY;
      const rowH = Math.max(2, Math.min(12, candlePixelH / fpEntries.length));
      
      // Max bar width = half candle width (each side)
      const maxBarW = cW * 0.42;

      fpEntries.forEach(([priceStr, vol]) => {
        const price = +priceStr;
        if (price < lo || price > hi) return;
        const y = ((hi - price) / priceRange) * chartH;
        const total = vol.buy + vol.sell;
        if (total === 0 || maxFpVol === 0) return;

        const buyW = (vol.buy / maxFpVol) * maxBarW;
        const sellW = (vol.sell / maxFpVol) * maxBarW;
        const delta = vol.buy - vol.sell;

        // Buy bar (left side of center, extends LEFT in green)
        if (buyW > 0.5) {
          const alpha = Math.min(0.9, 0.3 + (vol.buy / maxFpVol) * 0.6);
          ctx.fillStyle = `rgba(38, 166, 154, ${alpha})`;
          ctx.fillRect(x - buyW, y - rowH/2, buyW, rowH);
        }

        // Sell bar (right side of center, extends RIGHT in red)
        if (sellW > 0.5) {
          const alpha = Math.min(0.9, 0.3 + (vol.sell / maxFpVol) * 0.6);
          ctx.fillStyle = `rgba(239, 83, 80, ${alpha})`;
          ctx.fillRect(x, y - rowH/2, sellW, rowH);
        }

        // Delta indicator - small bright dot showing imbalance
        if (total > maxFpVol * 0.15) {
          const imbalance = Math.abs(delta) / total;
          if (imbalance > 0.3) {
            ctx.fillStyle = delta > 0 ? '#00ff88' : '#ff4466';
            const dotSize = Math.min(3, rowH * 0.4);
            ctx.beginPath();
            ctx.arc(x, y, dotSize, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      });

      // Delta summary text at bottom of candle (total buy - sell for the bar)
      if (cW > 25) { // Only show text when zoomed in enough
        const totalBuy = Object.values(c.footprint).reduce((a, v) => a + v.buy, 0);
        const totalSell = Object.values(c.footprint).reduce((a, v) => a + v.sell, 0);
        const barDelta = totalBuy - totalSell;
        const deltaText = barDelta >= 0 ? `+${fmtVol(barDelta)}` : fmtVol(barDelta);
        ctx.font = `bold ${Math.min(9, cW * 0.22)}px Consolas`;
        ctx.textAlign = 'center';
        ctx.fillStyle = barDelta >= 0 ? '#3fb950' : '#f85149';
        ctx.fillText(deltaText, x, candleLowY + 11);
      }
    });
  }

  // ── Current price line ──
  if (S.currentPrice > lo && S.currentPrice < hi) {
    const py = ((hi - S.currentPrice) / priceRange) * chartH;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#f7a600'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(drawW, py); ctx.stroke();
    ctx.setLineDash([]);
    // Tag
    ctx.fillStyle = '#f7a600';
    ctx.fillRect(drawW, py - 9, AXIS_W, 18);
    ctx.fillStyle = '#000'; ctx.font = 'bold 10px Consolas'; ctx.textAlign = 'left';
    ctx.fillText(fmt(S.currentPrice), drawW + 4, py + 4);
  }

  // ── Volume bars ──
  let maxVol = 1;
  vis.forEach(c => { if (c.volume > maxVol) maxVol = c.volume; });
  ctx.fillStyle = '#1a1e2e';
  ctx.fillRect(0, chartH, drawW, volH);
  
  vis.forEach((c, i) => {
    const x = i * cW + cW / 2;
    const h = (c.volume / maxVol) * (volH - 4);
    const green = c.close >= c.open;
    ctx.fillStyle = green ? 'rgba(38,166,154,0.4)' : 'rgba(239,83,80,0.4)';
    ctx.fillRect(x - bW/2, chartH + volH - h, bW, h);
  });

  // ── Price axis ──
  ctx.fillStyle = '#131722'; ctx.fillRect(drawW, 0, AXIS_W, H);
  ctx.strokeStyle = '#2a2e39'; ctx.beginPath(); ctx.moveTo(drawW,0); ctx.lineTo(drawW,H); ctx.stroke();
  ctx.font = '10px Consolas'; ctx.fillStyle = '#787b86'; ctx.textAlign = 'left';
  const nLabels = Math.floor(chartH / 45);
  for (let i = 0; i <= nLabels; i++) {
    const y = (i/nLabels) * chartH;
    ctx.fillText(fmt(hi - (i/nLabels)*priceRange), drawW+5, y+4);
  }

  // ── Time axis ──
  ctx.font = '10px Consolas'; ctx.fillStyle = '#787b86'; ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const x = (i/4) * candleArea;
    const t = new Date(tStart + (i/4)*tRange);
    ctx.fillText(t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), x, H-4);
  }

  // ── Crosshair + OHLC ──
  if (S.mouse && S.mouse.x < drawW && S.mouse.y < chartH) {
    ctx.setLineDash([2,2]); ctx.strokeStyle='rgba(120,123,134,0.4)'; ctx.lineWidth=0.5;
    ctx.beginPath(); ctx.moveTo(S.mouse.x,0); ctx.lineTo(S.mouse.x,chartH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,S.mouse.y); ctx.lineTo(drawW,S.mouse.y); ctx.stroke();
    ctx.setLineDash([]);
    
    // Price label on axis
    const cp = hi - (S.mouse.y/chartH)*priceRange;
    ctx.fillStyle='#363a45'; ctx.fillRect(drawW, S.mouse.y-9, AXIS_W, 18);
    ctx.fillStyle='#d1d4dc'; ctx.font='10px Consolas'; ctx.textAlign='left';
    ctx.fillText(fmt(cp), drawW+5, S.mouse.y+4);

    // OHLC tooltip
    const ci = Math.floor(S.mouse.x / cW);
    if (ci >= 0 && ci < vis.length) {
      const c = vis[ci];
      const green = c.close >= c.open;
      ctx.font = '11px Consolas'; ctx.textAlign = 'left';
      const txt = `O ${fmt(c.open)}  H ${fmt(c.high)}  L ${fmt(c.low)}  C ${fmt(c.close)}  V ${c.volume.toFixed(2)}`;
      ctx.fillStyle = green ? '#26a69a' : '#ef5350';
      ctx.fillText(txt, 8, 16);

      // Footprint summary in tooltip
      if (S.showFootprint && c.footprint) {
        const totalBuy = Object.values(c.footprint).reduce((a, v) => a + v.buy, 0);
        const totalSell = Object.values(c.footprint).reduce((a, v) => a + v.sell, 0);
        const delta = totalBuy - totalSell;
        const deltaStr = delta >= 0 ? `+${fmtVol(delta)}` : fmtVol(delta);
        ctx.fillStyle = '#8b949e';
        ctx.fillText(`Buy: ${fmtVol(totalBuy)}  Sell: ${fmtVol(totalSell)}  Delta: `, 8, 30);
        const textW = ctx.measureText(`Buy: ${fmtVol(totalBuy)}  Sell: ${fmtVol(totalSell)}  Delta: `).width;
        ctx.fillStyle = delta >= 0 ? '#3fb950' : '#f85149';
        ctx.fillText(deltaStr, 8 + textW, 30);
      }
    }
  }

  requestAnimationFrame(render);
}

// ═══════════════════════════════════════
// LIQUIDITY COLOR (Bookmap style)
// Small orders = dark blue, Large orders = bright red/orange
// ═══════════════════════════════════════
function liquidityColor(strength) {
  const s = Math.max(0, Math.min(1, strength));
  // 7-step gradient: dark → blue → cyan → green → yellow → orange → red
  if (s < 0.1)  return `rgba(15, 30, 80, 0.5)`;
  if (s < 0.2)  return `rgba(25, 60, 140, 0.55)`;
  if (s < 0.35) return `rgba(0, 120, 180, 0.6)`;
  if (s < 0.5)  return `rgba(0, 180, 160, 0.65)`;
  if (s < 0.65) return `rgba(180, 200, 0, 0.7)`;
  if (s < 0.8)  return `rgba(240, 150, 0, 0.75)`;
  return `rgba(240, 50, 0, 0.85)`;
}

// ═══════════════════════════════════════
// SIDE PANEL
// ═══════════════════════════════════════
function renderSide() {
  // DOM
  const bids = Object.entries(S.orderBook.bids).map(([p,q])=>({price:+p,qty:q})).sort((a,b)=>b.price-a.price).slice(0,10);
  const asks = Object.entries(S.orderBook.asks).map(([p,q])=>({price:+p,qty:q})).sort((a,b)=>a.price-b.price).slice(0,10);
  const mq = Math.max(...bids.map(b=>b.qty),...asks.map(a=>a.qty),1);
  
  let h = '';
  [...asks].reverse().forEach(l => {
    h += `<div class="dom-row"><div></div><div class="dom-price" style="color:#ef5350">${fmt(l.price)}</div><div class="dom-ask">${l.qty.toFixed(3)}</div><div class="dom-bar-ask" style="width:${(l.qty/mq)*45}%"></div></div>`;
  });
  if (bids.length && asks.length) {
    const sp = asks[0].price - bids[0].price;
    h += `<div class="dom-row spread-row"><div></div><div class="dom-price" style="color:#f7a600;font-size:9px">spread ${fmt(sp)}</div><div></div></div>`;
  }
  bids.forEach(l => {
    h += `<div class="dom-row"><div class="dom-bid">${l.qty.toFixed(3)}</div><div class="dom-price" style="color:#26a69a">${fmt(l.price)}</div><div></div><div class="dom-bar-bid" style="width:${(l.qty/mq)*45}%"></div></div>`;
  });
  document.getElementById('dom').innerHTML = h;

  // Events
  const evs = S.events.slice(-20).reverse();
  let evH = '';
  evs.forEach(ev => {
    const t = new Date(ev.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    let cls='', txt='';
    if (ev.type==='AGGRESSIVE_BUY') { cls='buy'; txt=`${t} BUY ${ev.size?.toFixed(3)||''} @${fmt(ev.price)}`; }
    else if (ev.type==='AGGRESSIVE_SELL') { cls='sell'; txt=`${t} SELL ${ev.size?.toFixed(3)||''} @${fmt(ev.price)}`; }
    else if (ev.type==='ORDER_PULL') { cls='pull'; txt=`${t} ${ev.side} PULLED @${fmt(ev.price)}`; }
    else if (ev.type==='ORDER_STACK') { cls='stack'; txt=`${t} ${ev.side} STACKED @${fmt(ev.price)}`; }
    else txt=`${t} ${ev.type}`;
    evH += `<div class="ev ${cls}">${txt}</div>`;
  });
  document.getElementById('events').innerHTML = evH;

  // Stats
  const bv = Object.values(S.orderBook.bids).reduce((a,b)=>a+b,0);
  const av = Object.values(S.orderBook.asks).reduce((a,b)=>a+b,0);
  document.getElementById('sBid').textContent = bv.toFixed(2);
  document.getElementById('sAsk').textContent = av.toFixed(2);
  document.getElementById('sBuy').textContent = S.trades.filter(t=>t.isBuy).reduce((a,t)=>a+t.qty,0).toFixed(3);
  document.getElementById('sSell').textContent = S.trades.filter(t=>!t.isBuy).reduce((a,t)=>a+t.qty,0).toFixed(3);
  const tot = bv+av;
  const im = tot>0?((bv-av)/tot*100).toFixed(1):'0';
  const bP=Object.keys(S.orderBook.bids).map(Number), aP=Object.keys(S.orderBook.asks).map(Number);
  document.getElementById('sSpread').textContent = fmt(bP.length&&aP.length?Math.min(...aP)-Math.max(...bP):0);
  const ie=document.getElementById('sImbal');
  ie.textContent=im+'%'; ie.style.color=im>0?'#26a69a':im<0?'#ef5350':'#787b86';

  // Price
  const pe = document.getElementById('priceVal');
  pe.textContent = fmt(S.currentPrice);
  pe.style.color = S.candles.length>0 && S.currentPrice>=S.candles[S.candles.length-1].open ? '#26a69a' : '#ef5350';

  // Countdown
  const tfMs = TF_MS[S.currentTimeframe]||60000;
  const rem = (Math.floor(Date.now()/tfMs)*tfMs+tfMs)-Date.now();
  document.getElementById('countdown').textContent = `${Math.floor(rem/60000)}:${String(Math.floor((rem%60000)/1000)).padStart(2,'0')}`;

  // Status
  document.getElementById('connDot').className='conn-dot'+(S.connected?' on':'');
  document.getElementById('connText').textContent=S.connected?(S.serverConnected?'Live':'REST'):'Offline';
  document.getElementById('sInst').textContent=S.instruments[S.currentInstrument]?.name||'';
  document.getElementById('sInfo').textContent=`${S.candles.length}c ${S.domHistory.length}dom`;
}
setInterval(renderSide, 300);

// ═══════════════════════════════════════
// CONTROLS
// ═══════════════════════════════════════
function buildButtons() {
  const ie=document.getElementById('instBtns'); ie.innerHTML='';
  Object.keys(S.instruments).forEach(k=>{
    const b=document.createElement('button');
    b.className='btn inst'+(k===S.currentInstrument?' active':'');
    b.textContent=k; b.dataset.val=k;
    b.onclick=()=>{send({type:'CHANGE_INSTRUMENT',instrument:k});setActive('.inst',k);};
    ie.appendChild(b);
  });
  const te=document.getElementById('tfBtns'); te.innerHTML='';
  S.timeframes.forEach(tf=>{
    const b=document.createElement('button');
    b.className='btn tf'+(tf===S.currentTimeframe?' active':'');
    b.textContent=tf; b.dataset.val=tf;
    b.onclick=()=>{send({type:'CHANGE_TIMEFRAME',timeframe:tf});setActive('.tf',tf);document.getElementById('sTf').textContent=tf;};
    te.appendChild(b);
  });
}
function setActive(s,v){document.querySelectorAll(s).forEach(b=>b.classList.toggle('active',b.dataset.val===v));}
function updateUI(){
  document.getElementById('connDot').className='conn-dot'+(S.connected?' on':'');
  document.getElementById('connText').textContent=S.connected?'Connected':'Reconnecting';
}

// Zoom
document.getElementById('zoomIn').onclick=()=>{S.targetZoom=Math.min(S.targetZoom*1.4,8);};
document.getElementById('zoomOut').onclick=()=>{S.targetZoom=Math.max(S.targetZoom/1.4,0.2);};
document.getElementById('zoomReset').onclick=()=>{S.targetZoom=1;S.targetScrollX=0;};

canvas.addEventListener('wheel',(e)=>{
  e.preventDefault();
  S.targetZoom=Math.max(0.2,Math.min(8,S.targetZoom*(e.deltaY<0?1.08:0.92)));
},{passive:false});

canvas.addEventListener('mousedown',(e)=>{
  S.dragging=true; S.dragStartX=e.clientX; S.dragStartScroll=S.targetScrollX;
  canvas.style.cursor='grabbing';
});
canvas.addEventListener('mousemove',(e)=>{
  const r=canvas.getBoundingClientRect();
  S.mouse={x:e.clientX-r.left,y:e.clientY-r.top};
  if(S.dragging){
    const dx=e.clientX-S.dragStartX;
    const ppc=(W-AXIS_W)*0.9/Math.round(60/S.targetZoom);
    S.targetScrollX=Math.max(0,Math.min(S.candles.length-20,S.dragStartScroll+dx/ppc));
  }
});
canvas.addEventListener('mouseleave',()=>{S.mouse=null;});
window.addEventListener('mouseup',()=>{S.dragging=false;canvas.style.cursor='crosshair';});
canvas.style.cursor='crosshair';

function fmt(p){
  if(!p||p===0)return'--';
  if(p>1000)return p.toFixed(2);
  if(p>1)return p.toFixed(4);
  return p.toFixed(6);
}

// Format volume for footprint display
function fmtVol(v) {
  const abs = Math.abs(v);
  if (abs >= 1000) return (v/1000).toFixed(1) + 'k';
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(3);
  return v.toFixed(4);
}

// Footprint toggle
function toggleFootprint() {
  S.showFootprint = !S.showFootprint;
  const btn = document.getElementById('fpBtn');
  if (btn) btn.classList.toggle('active', S.showFootprint);
}

// START
connect();
render();
