# Free Bookmap Heatmap - Live Trading Tool

A **FREE** alternative to Bookmap ($49-$99/month) that gives you real-time order book heatmap visualization with live market data. No API key required. No subscription. No limits.

![Heatmap](https://img.shields.io/badge/LIVE-HEATMAP-00e5ff?style=for-the-badge)
![Free](https://img.shields.io/badge/COST-FREE-00e676?style=for-the-badge)
![Data](https://img.shields.io/badge/DATA-BINANCE_WS-ffaa00?style=for-the-badge)

---

## Available Instruments

| Button | Instrument | Binance Symbol | Description |
|--------|-----------|----------------|-------------|
| XAUUSD | Gold | PAXGUSDT | Tokenized gold - tracks XAU/USD perfectly |
| BTCUSD | Bitcoin | BTCUSDT | Best liquidity, ideal for learning |
| ETHUSD | Ethereum | ETHUSDT | High volume, great heatmap patterns |
| EURUSD | Euro/Dollar | EURUSDT | Forex proxy - correlates with EUR/USD |
| GBPUSD | Pound/Dollar | GBPUSDT | Forex proxy - correlates with GBP/USD |
| NAS100 | Nasdaq proxy | BNBUSDT | Correlated risk asset for US100 bias |
| SOLUSD | Solana | SOLUSDT | High volatility, clear order flow |

---

## Step-by-Step Setup Guide

### Step 1: Install Node.js
Download and install from https://nodejs.org (LTS version recommended).

### Step 2: Clone This Repository
```bash
git clone https://github.com/BOYremz/MYPROJECT.git
cd MYPROJECT
```

### Step 3: Install Dependencies
```bash
npm install
```

### Step 4: Start The Heatmap
```bash
npm start
```

### Step 5: Open In Browser
Navigate to **http://localhost:3000** — you'll see the live heatmap building in real-time!

---

## How To Read The Heatmap (Trading Guide)

### The Heatmap Display

The main canvas shows **time on the X-axis** and **price on the Y-axis**. Each column is a snapshot of the order book:

- **Green zones** = Bid liquidity (buy orders resting below price)
- **Red zones** = Ask liquidity (sell orders resting above price)
- **Brighter color** = More liquidity at that price level
- **Yellow line** = Current market price moving through time
- **Mouse wheel** = Zoom in/out on price range

---

## Order Flow Features & How To Trade Them

### 1. Resting Liquidity (Bright spots on heatmap)

**What it looks like:** Bright green or red horizontal bands that persist across multiple time columns.

**What it means:** Large limit orders sitting at a price level. These act as magnets — price tends to move TOWARD resting liquidity because market makers want to fill these orders.

**How to trade:**
- Bright green band below price → Price likely to move DOWN to sweep that liquidity → Look for short entries
- Bright red band above price → Price likely to move UP to sweep that liquidity → Look for long entries
- After liquidity is swept (bright band disappears), expect a reversal

---

### 2. Market Orders (Trade dots on heatmap)

**What it looks like:** Green circles (buys) and red circles (sells) appearing on the price line. Bigger circles = bigger trades.

**What it means:** Actual executed trades. These are aggressive traders hitting the market NOW.

**How to trade:**
- Cluster of large green dots → Strong buying pressure → Bullish bias
- Cluster of large red dots → Strong selling pressure → Bearish bias
- Watch for divergence: price going up but mostly red dots = exhaustion, likely reversal

---

### 3. Order Pulling (⚠️ Diamond markers)

**What it looks like:** Yellow/orange diamond markers on the heatmap. In the events log: "⚠️ BID/ASK PULLED"

**What it means:** A large order was placed then REMOVED before being filled. This is often **spoofing** — someone trying to fake supply/demand.

**How to trade:**
- Bids being pulled below price → The "support" is fake → Bearish signal
- Asks being pulled above price → The "resistance" is fake → Bullish signal  
- If you see pulling on one side + stacking on the other → Strong directional signal

---

### 4. Order Stacking (🧱 Square markers)

**What it looks like:** Purple square markers on the heatmap. In the events log: "🧱 BID/ASK STACKED"

**What it means:** Someone is rapidly ADDING large orders at a price level. This creates a wall of liquidity.

**How to trade:**
- Bid stacking = Someone building a floor → Likely support → Bullish
- Ask stacking = Someone building a ceiling → Likely resistance → Bearish
- BUT: If the stack gets swept through quickly, it's a strong breakout signal in that direction

---

### 5. Iceberg Absorption (🧊 Trapezoid markers)

**What it looks like:** Cyan/blue trapezoid markers. In the events log: "🧊 ICEBERG"

**What it means:** A price level keeps getting hit by market orders but the liquidity keeps REFILLING. There's a hidden large order (iceberg) absorbing all the selling/buying.

**How to trade:**
- Iceberg on bid side = Hidden buyer absorbing all sells → Very bullish → Price will likely move UP after absorption ends
- Iceberg on ask side = Hidden seller absorbing all buys → Very bearish → Price will likely move DOWN after absorption ends
- Icebergs are the STRONGEST signal — they represent institutional activity

---

### 6. Aggressive Buying/Selling (▲▼ Triangle markers)

**What it looks like:** Green up-triangles (aggressive buys) or red down-triangles (aggressive sells) on the chart.

**What it means:** An unusually large trade was executed (3x+ the average size). Someone is urgently entering/exiting a position.

**How to trade:**
- Multiple aggressive buys at the same level → Institutional accumulation → Bullish
- Multiple aggressive sells at the same level → Institutional distribution → Bearish
- Single aggressive trade after a long move → Could be a climax/exhaustion → Watch for reversal

---

### 7. DOM Evolution Over Time (The heatmap itself!)

**What it looks like:** The entire heatmap scrolling left as time passes. Watch how the liquidity landscape changes.

**What it means:** You can see WHERE liquidity is building up and WHERE it's being removed in real-time.

**How to trade:**
- Liquidity building above → Acts as resistance → Short until swept
- Liquidity building below → Acts as support → Long until swept
- Liquidity thinning out in one direction → Price will move that way easily (path of least resistance)
- Symmetrical liquidity = Balanced market = Wait for an imbalance to form

---

## Putting It All Together: The Trading Playbook

### Bullish Setup (Look for longs):
1. ✅ Resting liquidity building above price (target)
2. ✅ Iceberg absorption on bids (hidden buyer)
3. ✅ Ask walls getting pulled (fake resistance)
4. ✅ Aggressive buying appearing
5. ✅ Bid imbalance positive (shown in stats panel)

### Bearish Setup (Look for shorts):
1. ✅ Resting liquidity building below price (target)
2. ✅ Iceberg absorption on asks (hidden seller)
3. ✅ Bid walls getting pulled (fake support)
4. ✅ Aggressive selling appearing
5. ✅ Bid imbalance negative (shown in stats panel)

### Key Principle:
> **Price moves TOWARD liquidity to fill it, then reverses.**
> Smart money places hidden orders (icebergs) and removes visible orders (pulling) to trap retail traders.

---

## Stats Panel Explained

| Stat | Meaning |
|------|---------|
| Bid Vol | Total size of all visible buy orders |
| Ask Vol | Total size of all visible sell orders |
| Buy Pwr | Volume of aggressive buys in last 10 seconds |
| Sell Pwr | Volume of aggressive sells in last 10 seconds |
| Spread | Gap between best bid and best ask |
| Imbal | Order book imbalance (positive = more bids = bullish bias) |

---

## Tips

- **Best time to trade:** When you see 3+ signals aligning (e.g., iceberg + stacking + aggressive trades in same direction)
- **Use BTCUSDT first** to learn — it has the deepest order book and clearest patterns
- **Gold (XAUUSD)** trades best during London/NY sessions (8AM-4PM EST)
- **Scroll to zoom** in/out on the price axis for more detail
- **The events log** (right panel) shows you all detected patterns in real-time

---

## Technical Details

- **Data source:** Binance WebSocket (free, no API key, no rate limits for streaming)
- **Update speed:** ~100ms depth updates, real-time trade stream
- **Heatmap history:** Last 2 minutes of DOM evolution
- **Detection sensitivity:** Auto-adjusts based on average trade size for each instrument
- **Zero latency:** Direct WebSocket connection, no REST polling

---

## License

MIT — Free to use, modify, and share. No subscription needed. Ever.
