# DIP-X paper trader ($20 / $5 per trade)

Runs by itself on GitHub every 5 minutes. No server, no API keys, no browser needed.
It watches the top 25 Binance USDT coins (by 30-day median volume), paper-buys $5 of any coin
whose 24h drop reaches -10%, exits 24 hours later, and saves everything in `docs/data/`.
A web page (GitHub Pages) shows the results. Paper trading only: it never places real orders.

Built for a $20 account: every coin is checked against Binance's real minimum order size,
so only coins that actually accept a $5 order are traded (the rest are shown, but skipped).

## Set up (about 10 minutes, once)

1. On github.com click **New repository**. Name it `dip-x`, choose **Public**, click Create.
2. Click **uploading an existing file** and drag in everything from this folder
   (`.github`, `docs`, `scanner`, `config.json`, `README.md`), then **Commit changes**.
   - If the hidden `.github` folder does not upload: click **Add file > Create new file**,
     type `.github/workflows/scan.yml` as the name and paste the content of that file.
3. **Settings > Pages**: Source = *Deploy from a branch*, Branch = `main`, folder = `/docs`, Save.
   Your page address appears after a minute or two.
4. **Actions** tab: if GitHub asks, click *I understand my workflows, enable them*.
   Open **Dip-X scan** and click **Run workflow**. The first run takes 1-2 minutes and
   creates `docs/data/state.json` (the first commit by the bot).
5. Open your Pages address. Bookmark it. That is all - it updates by itself.

## The rules it trades (from the validated backtest)

- Universe: top 25 USDT spot pairs by 30-day median daily volume (stables and
  leveraged tokens excluded, refreshed every 6 hours)
- Entry: last closed 1h bar shows a 24h drop of -10% or worse -> buy $5 at market
  (most-liquid coin first when several fire at once)
- Exit: exactly 24h later, at market. No stop-loss - in the backtest 64% of winners
  dipped at least 3% further before the bounce
- Max 4 open positions, one per coin, re-entry allowed right after an exit
- Fees: 0.1% per side (0.2% round trip) - on $5 that's about 1 cent per trade
- $5 filter: coins whose Binance minimum order is above $5 (some pairs need $10+)
  are skipped and marked in the watchlist. BTC and ETH themselves accept $5 orders
  (min notional 5 USDT), so they stay eligible.

## Settings

Edit `config.json` on GitHub (pencil icon):

| key | default | meaning |
|---|---|---|
| `startEquity` | 20 | starting cash of the paper account |
| `perTrade` | 5 | dollars per trade (fixed) |
| `thresholdPct` | -10 | 24h drop that triggers a buy (-8 = more trades, a bit weaker edge) |
| `holdHours` | 24 | time exit |
| `maxOpen` | 4 | max simultaneous positions |
| `topN` | 25 | watchlist size (do not raise past ~50; the edge dies in small caps) |

To restart the account from zero: delete `docs/data/state.json` and run the workflow once.

## Things to know

- GitHub commits only when something happens (a trade, a signal, a watchlist change)
  or every 3 hours, so the repo history stays small. The dashboard warns you if data
  is older than ~30 minutes - that usually means the Actions schedule was paused:
  open the Actions tab and re-enable it (GitHub pauses cron after 60 days of no
  activity; the bot's own commits normally prevent this).
- The page reads `docs/data/state.json` and also pulls live prices from
  `data-api.binance.vision` directly in your browser, so numbers move between scans.
- Fills use the live price at the moment the scanner sees the signal (within ~5 min
  of the hour closing). If GitHub's runner is late, you'll see the real fill with
  its slippage in the signal log - that is intentional, it measures the strategy
  as you would actually experience it.
- What to expect: the backtest (2021-2026, top-25 coins) gave ~53% win rate and
  +0.9% per trade after fees, about 5 signals a week. On $5 that is +4.5 cents per
  trade on average. Judge after 50+ closed trades (2-3 months), not the first week.
- Optional Telegram alerts: create a bot with @BotFather, send it a message, find
  your chat id, then in **Settings > Secrets and variables > Actions** add
  `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

Research tool. Paper trading only. Backtests are not a promise of future results;
this is not financial advice.
