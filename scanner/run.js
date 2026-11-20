'use strict';
/* DIP-X autopilot: GitHub Actions runs this every 5 minutes. No server, no API keys,
   paper trading only. Fetches Binance public data, maintains the $20 / $5-per-trade
   paper account, writes docs/data/state.json (+ CSVs). The workflow commits changes. */
const fs = require('fs'), path = require('path');
const C = require('./core.js');
const { DAY, HOUR, DEFAULTS, STABLE } = C;
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'docs', 'data');
const CFG_PATH = path.join(ROOT, 'config.json');
const API = 'https://data-api.binance.vision';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jget(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status === 418) { await sleep(2500 * (t + 1)); continue; }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) { if (t === tries - 1) throw e; await sleep(700 * (t + 1)); }
  }
}
async function pool(items, limit, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } }
  }));
  return out;
}
const klines = (s, tf, n) => jget(`${API}/api/v3/klines?symbol=${s}&interval=${tf}&limit=${n}`).then(rows => {
  const b = { t: [], q: [], c: [] };
  for (const r of rows) { b.t.push(r[0]); b.c.push(+r[4]); b.q.push(+r[7]); }
  return b;
});
const csvEsc = (x) => /[",\n]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x;

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let user = {}; try { user = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) {}
  const cfg = Object.assign({}, DEFAULTS, user);
  const thr = cfg.thresholdPct / 100;
  const now = Date.now();

  const SP = path.join(DATA, 'state.json');
  let S = null;
  try { S = JSON.parse(fs.readFileSync(SP, 'utf8')); } catch (e) {}
  if (!S || S.v !== 1) {
    S = { v: 1, startMs: now, cash: cfg.startEquity, positions: [], closed: [], equity: [{ t: now, eq: cfg.startEquity }],
          log: [], watchlist: [], filters: {}, filtersMs: 0, universeMs: 0, lastCommitMs: 0, cfg: null };
    log('new paper account: $' + cfg.startEquity + ' start, $' + cfg.perTrade + ' per trade');
  }
  const before = JSON.stringify([S.positions, S.closed.length, S.log.length, S.watchlist.map(w => w.sym + w.rank + w.tradeable)]);

  /* ---------- 1. full 24h ticker ---------- */
  log('tickers');
  const tickers = await jget(`${API}/api/v3/ticker/24hr`);
  const live = {}, qv24 = {};
  for (const t of tickers) { live[t.symbol] = +t.lastPrice; qv24[t.symbol] = +t.quoteVolume; }

  /* ---------- 2. exchange filters (daily) ---------- */
  if (now - (S.filtersMs || 0) > DAY || !S.filters || !Object.keys(S.filters).length) {
    try {
      log('exchangeInfo');
      const ex = await jget(`${API}/api/v3/exchangeInfo`, 2);
      S.filters = C.parseFilters(ex.symbols.filter(x => x.quoteAsset === 'USDT'));
      S.filtersMs = now;
    } catch (e) { log('exchangeInfo failed, keeping old filters:', e.message); }
  }

  /* ---------- 3. universe: top-N by 30d median volume (every 6h) ---------- */
  if (now - (S.universeMs || 0) > 6 * HOUR || !S.watchlist.length) {
    log('universe refresh');
    const cands = C.candidateSymbols(tickers, S.filters);
    const d1s = await pool(cands, 6, s => klines(s, '1d', 32));
    const scored = [];
    cands.forEach((s, k) => {
      const b = d1s[k]; if (!b) return;
      const q = C.qv30(b, now); if (q >= 1e6) scored.push({ sym: s, qv30: q });
    });
    scored.sort((a, b) => b.qv30 - a.qv30);
    S.watchlist = scored.slice(0, cfg.topN).map((x, i) => {
      const f = S.filters[x.sym] || {};
      const px = live[x.sym] || 0;
      const probe = C.qtyForUsd(cfg.perTrade, px || 1, f);
      return { sym: x.sym, rank: i + 1, qv30: Math.round(x.qv30), minOrderUsd: probe.minOrderUsd, tradeable: !!(probe.ok && (f.status || 'TRADING') === 'TRADING') };
    });
    S.universeMs = now;
    log('watchlist: ' + S.watchlist.length + ' coins, ' + S.watchlist.filter(w => w.tradeable).length + ' tradeable at $' + cfg.perTrade);
  }

  /* ---------- 4. hourly bars for the watchlist -> closed-bar 24h change ---------- */
  const h1 = await pool(S.watchlist.map(w => w.sym), 6, s => klines(s, '1h', 27));
  const r24map = {};
  S.watchlist.forEach((w, k) => { const b = h1[k]; if (b) { const r = C.r24Closed(b, now); if (r) r24map[w.sym] = r; } });

  /* ---------- 5. exits (time exit 24h after entry, at live price) ---------- */
  const stillOpen = [];
  for (const p of S.positions) {
    const px = live[p.sym] || p.lastPx || p.entryPx;
    p.lastPx = px;
    if (now >= p.exitDueMs) {
      const gross = p.qty * px, fee = gross * cfg.feePctSide;
      const pnl = gross - fee - p.costBasis; // costBasis = notional + entry fee
      S.cash += gross - fee;
      S.closed.push({ id: p.id, sym: p.sym, qty: p.qty, entryPx: p.entryPx, entryNotional: +p.entryNotional.toFixed(6),
        entryMs: p.entryMs, exitPx: px, exitMs: now, holdH: +((now - p.entryMs) / HOUR).toFixed(2),
        pnlUsd: +pnl.toFixed(4), pnlPct: +(pnl / p.costBasis * 100).toFixed(3), signalR24: p.signalR24 });
      S.log.unshift({ ms: now, sym: p.sym, r24: +(p.signalR24 * 100).toFixed(2), action: 'EXIT', note: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} net (${(pnl / p.costBasis * 100).toFixed(2)}%)` });
      log(`EXIT ${p.sym} pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    } else stillOpen.push(p);
  }
  S.positions = stillOpen;
  if (S.closed.length > 600) S.closed = S.closed.slice(-600);

  /* ---------- 6. entries (most-liquid first, one per coin, $5 fixed) ---------- */
  const sigs = S.watchlist
    .filter(w => r24map[w.sym] && r24map[w.sym].r24 <= thr)
    .sort((a, b) => a.rank - b.rank);
  for (const w of sigs) {
    if (S.positions.some(p => p.sym === w.sym)) { S.log.unshift({ ms: now, sym: w.sym, r24: +(r24map[w.sym].r24 * 100).toFixed(2), action: 'SKIP_ALREADY_OPEN' }); continue; }
    if (S.positions.length >= cfg.maxOpen) { S.log.unshift({ ms: now, sym: w.sym, r24: +(r24map[w.sym].r24 * 100).toFixed(2), action: 'SKIP_MAX_OPEN' }); continue; }
    if (!w.tradeable) { S.log.unshift({ ms: now, sym: w.sym, r24: +(r24map[w.sym].r24 * 100).toFixed(2), action: 'SKIP_MIN_ORDER', note: `min order $${w.minOrderUsd} > $${cfg.perTrade}` }); continue; }
    if (S.cash < cfg.perTrade - 0.001) { S.log.unshift({ ms: now, sym: w.sym, r24: +(r24map[w.sym].r24 * 100).toFixed(2), action: 'SKIP_NO_CASH' }); continue; }
    const px = live[w.sym];
    const fill = C.qtyForUsd(cfg.perTrade, px, S.filters[w.sym]);
    if (!fill.ok) { S.log.unshift({ ms: now, sym: w.sym, r24: +(r24map[w.sym].r24 * 100).toFixed(2), action: 'SKIP_MIN_ORDER', note: `cannot build a $${cfg.perTrade} order (min $${fill.minOrderUsd})` }); continue; }
    const fee = fill.notional * cfg.feePctSide;
    S.cash -= fill.notional + fee;
    S.positions.push({ id: `${w.sym}-${now}`, sym: w.sym, qty: fill.qty, entryPx: px, entryNotional: fill.notional,
      costBasis: +(fill.notional + fee).toFixed(6), entryMs: now, exitDueMs: now + cfg.holdHours * HOUR,
      signalR24: r24map[w.sym].r24, sigPx: r24map[w.sym].sigPx, lastPx: px });
    S.log.unshift({ ms: now, sym: w.sym, r24: +(r24map[w.sym].r24 * 100).toFixed(2), action: 'ENTER',
      note: `$${fill.notional.toFixed(2)} @ ${px} (signal close ${r24map[w.sym].sigPx})` });
    log(`ENTER ${w.sym} $${fill.notional.toFixed(2)} @ ${px}`);
  }
  if (S.log.length > 800) S.log = S.log.slice(0, 800);

  /* ---------- 7. marks + equity curve ---------- */
  for (const p of S.positions) if (live[p.sym]) p.lastPx = live[p.sym];
  const eq = S.cash + S.positions.reduce((a, p) => a + p.qty * (p.lastPx || p.entryPx), 0);
  const lastEq = S.equity[S.equity.length - 1];
  if (!lastEq || now - lastEq.t > HOUR || Math.abs(eq - lastEq.eq) > 0.005) S.equity.push({ t: now, eq: +eq.toFixed(4) });
  if (S.equity.length > 3000) S.equity = [S.equity[0]].concat(S.equity.slice(S.equity.length - 2999));

  /* ---------- 8. write policy: only real changes, or a 3h heartbeat ---------- */
  const after = JSON.stringify([S.positions, S.closed.length, S.log.length, S.watchlist.map(w => w.sym + w.rank + w.tradeable)]);
  const changed = after !== before;
  const heartbeat = now - (S.lastCommitMs || 0) > 3 * HOUR;
  if (changed || heartbeat || !fs.existsSync(SP)) {
    S.cfg = { startMs: S.startMs, startEquity: cfg.startEquity, perTrade: cfg.perTrade, feePctSide: cfg.feePctSide,
      thresholdPct: cfg.thresholdPct, topN: cfg.topN, holdHours: cfg.holdHours, maxOpen: cfg.maxOpen, minOrderUsd: cfg.minOrderUsd };
    S.updatedMs = now; S.equityNow = +eq.toFixed(4);
    fs.writeFileSync(SP, JSON.stringify(S));
    fs.writeFileSync(path.join(DATA, 'closed_trades.csv'),
      'exit_pkt,entry_pkt,coin,qty,entry,exit,hold_h,pnl_usd,pnl_pct,r24_at_entry_pct\n' +
      S.closed.map(p => [pkt(p.exitMs), pkt(p.entryMs), p.sym, p.qty, p.entryPx, p.exitPx, p.holdH, p.pnlUsd, p.pnlPct, (p.signalR24 * 100).toFixed(2)].map(csvEsc).join(',')).join('\n') + '\n');
    fs.writeFileSync(path.join(DATA, 'signal_log.csv'),
      'time_pkt,coin,r24_pct,action,note\n' +
      S.log.slice(0, 400).map(l => [pkt(l.ms), l.sym, l.r24, l.action, csvEsc(l.note || '')].join(',')).join('\n') + '\n');
    S.lastCommitMs = now;
    log(`state written: equity $${eq.toFixed(2)} (${changed ? 'changed' : 'heartbeat'}), ${S.positions.length} open, ${S.closed.length} closed`);
  } else {
    log(`no change (equity $${eq.toFixed(2)}), state not rewritten`);
  }
}
function pkt(ms) { return new Date(ms + 5 * HOUR).toISOString().slice(0, 16).replace('T', ' '); }
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
