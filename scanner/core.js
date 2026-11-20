'use strict';
/* ===== DIP-X engine: top-25 (30d median volume) 24h-dip bounce, 1h bars =====
   Rules ported 1:1 from the validated backtest:
   - signal: last CLOSED 1h bar close vs close 24 bars earlier <= threshold (default -10%)
   - universe: top N by 30-day MEDIAN daily quote volume (USDT spot, no stables/lev tokens)
   - $5-tradeable filter: coin's real Binance min order (minNotional / LOT_SIZE) must accept perTrade
   - entry at live price when the scanner first sees the signal; exit 24h later at live price
   - no stop-loss (64% of winners dip >=3% further before bouncing), time exit only
   - one position per coin, re-entry allowed after exit, most-liquid-first priority
   Pure functions only, no IO. */

const DAY = 86400000, HOUR = 3600000;

const DEFAULTS = {
  startEquity: 20, perTrade: 5, feePctSide: 0.001, thresholdPct: -10,
  topN: 25, holdHours: 24, maxOpen: 4, minOrderUsd: 5
};

const STABLE = new Set(['USDC','TUSD','BUSD','USDP','USDS','FDUSD','DAI','AEUR','EUR','EURI','UST','PAX','SUSD','GBP','AUD','TRY','BRL','RUB','UAH','NGN','ZAR','IDR','PLN','RON','ARS','JPY','CZK','MXN','COP','WBTC','PAXG','XAUT','USD1','PYUSD','RLUSD','XUSD','BFUSD','VAI','BIDR','IDRT','BVND','USDE','USTC','USDT']);

function median(a) {
  if (!a || !a.length) return NaN;
  const s = Array.from(a).sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ---- exchange filters ---- */
function parseFilters(symbols) {
  const out = {};
  for (const s of symbols) {
    let minNotional = 0, stepSize = '1', minQty = '1', tickSize = '0.01';
    for (const f of s.filters || []) {
      if (f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') minNotional = +f.minNotional || 0;
      if (f.filterType === 'LOT_SIZE') { stepSize = f.stepSize; minQty = f.minQty; }
      if (f.filterType === 'PRICE_FILTER') tickSize = f.tickSize;
    }
    out[s.symbol] = { minNotional, stepSize, minQty, tickSize, status: s.status };
  }
  return out;
}

function stepDecimals(step) {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/* Best real order near usd: try floor and next tick up, must satisfy minNotional/minQty.
   Tolerance: up to +15% over usd, because price grids (stepSize x price) don't always land
   exactly on $5 - e.g. BTC at $87k with step 0.00001 ticks at $0.87: valid orders are
   $4.35 (below 5 minNotional) or $5.22. We take the smallest VALID order <= usd*1.15.
   Returns {qty, notional, ok, minOrderUsd}. */
function qtyForUsd(usd, price, filt) {
  if (!filt || !(price > 0)) return { qty: 0, notional: 0, ok: false, minOrderUsd: Infinity };
  const step = +filt.stepSize || 1, minQty = +filt.minQty || 0;
  const minOrderUsd = Math.max(filt.minNotional || 0, step * price, minQty * price);
  const cap = usd * 1.15;
  const qFloor = Math.floor(usd / price / step) * step;
  let best = null;
  for (const q of [qFloor, qFloor + step]) {
    const n = q * price;
    if (q >= minQty - 1e-12 && n >= (filt.minNotional || 0) - 1e-9 && n <= cap + 1e-9)
      if (!best || n < best.notional) best = { qty: q, notional: n };
  }
  if (!best) return { qty: 0, notional: 0, ok: false, minOrderUsd: +minOrderUsd.toFixed(2) };
  const d = stepDecimals(filt.stepSize);
  return { qty: +best.qty.toFixed(d), notional: +best.notional.toFixed(6), ok: true, minOrderUsd: +minOrderUsd.toFixed(2) };
}

/* ---- signal: 24h change on CLOSED 1h bars only ---- */
/* bars = {t:[openTime ms], c:[close]} chronological. Returns null if not enough data. */
function r24Closed(bars, nowMs) {
  const n = bars.c.length;
  let L = -1;
  for (let i = n - 1; i >= 0; i--) { if (bars.t[i] + HOUR <= nowMs) { L = i; break; } }
  if (L < 24) return null;
  const px = bars.c[L], base = bars.c[L - 24];
  if (!(base > 0)) return null;
  return { r24: px / base - 1, sigPx: px, sigOpen: bars.t[L], barsNeeded: 0 };
}

/* ---- 30d median daily quote volume from 1d bars (closed bars only) ---- */
function qv30(d1, nowMs) {
  const closed = [];
  for (let i = d1.t.length - 1; i >= 0 && closed.length < 30; i--)
    if (d1.t[i] + DAY <= nowMs) closed.push(d1.q[i]);
  if (closed.length < 20) return 0;
  return median(closed);
}

/* ---- universe candidates from the full 24h ticker ---- */
function candidateSymbols(tickers, filters) {
  const price = {}, qv = {};
  for (const t of tickers) { price[t.symbol] = +t.lastPrice; qv[t.symbol] = +t.quoteVolume; }
  const cands = tickers.map(t => t.symbol).filter(s => {
    if (!s.endsWith('USDT')) return false;
    const b = s.slice(0, -4);
    if (STABLE.has(b) || /USD$/.test(b)) return false;
    for (const suf of ['UP', 'DOWN', 'BULL', 'BEAR'])
      if (b.endsWith(suf) && price[b.slice(0, -suf.length) + 'USDT'] !== undefined) return false;
    if (filters && filters[s] && filters[s].status !== 'TRADING') return false;
    return qv[s] >= 2e6;
  });
  cands.sort((a, b) => qv[b] - qv[a]);
  return cands.slice(0, 120); // by yesterday's volume; qv30 ranking happens after
}

module.exports = { DAY, HOUR, DEFAULTS, STABLE, median, parseFilters, qtyForUsd, r24Closed, qv30, candidateSymbols, stepDecimals };
