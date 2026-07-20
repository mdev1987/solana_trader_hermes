# solana_trader_hermes

Deterministic Solana memecoin trading bot. No AI, no LLM — just replay, score, trade, and optimize.

## Architecture

```
Replay → Feature Builder → Strategy → Paper Executor → Position Manager → DB → Analytics
```

Every module is decoupled. The strategy is a pure function: `evaluate(snapshot) → BUY | SKIP`. Parameters are optimized via brute-force grid search — not Hermes.

## Setup

```bash
bun install
cp .env.example .env   # then edit .env with your values
```

## Commands

| Command | Description |
|---------|-------------|
| `bun run replay <hours>` | Replay last N hours of pump.fun data, run strategy |
| `bun run rank <limit>` | Fetch top ranked tokens from debot.ai |
| `bun run heatmap` | Show current market heatmap |
| `bun run optimize` | Grid search optimal strategy params |
| `bun run report` | Trade performance report from DB |
| `bun run bot` | Start Telegram bot |

## Backtesting Guide

### 1. Install & Configure

```bash
bun install
cp .env.example .env
```

Set paper trading params in `.env`:

```
PAPER_BALANCE=1000       # starting USD
PAPER_SOL_AMOUNT=0.1     # SOL per trade
DB_PATH=./data/trader.db
```

### 2. Run a Backtest

```bash
bun run replay 6
```

Downloads the last **6 hours** of pump.fun data, feeds each event through the pipeline, saves every completed trade, and prints metrics:

```
[replay] Downloading last 6 hours...
[replay] Processed 142,380 events
[replay] Trades: 47
═══════════════════════════════════════
  Total Trades:    47
  Win Rate:        61.70%
  Total PnL:       $12.34
  Profit Factor:   1.82
  Sharpe:          1.24
═══════════════════════════════════════
```

### 3. Review Results

```bash
bun run report
```

Shows the same report aggregated from all trades in the database.

### 4. Optimize Parameters

After accumulating features from replay runs, find optimal thresholds:

```bash
bun run optimize
```

Brute-forces combinations of `minScore`, `minLiquidity`, `minActivityScore`, and `minSmartWallets`, ranked by total PnL:

```
[optimize] Top 10 parameter combinations:
  #1 score>=75 liq>=1000 act>=0.10 wallets>=1 → PnL=$18.42
  #2 score>=75 liq>=2000 act>=0.10 wallets>=1 → PnL=$16.91
  #3 score>=70 liq>=1000 act>=0.10 wallets>=2 → PnL=$15.33
```

### 5. Apply Best Params

Update `src/config/config.ts` with the winning values, then re-run:

```bash
bun run replay 6    # validate with new params
```

### 6. Iterate

The optimization loop:

```
replay → review report → optimize → update config → replay → commit best candidate
```

To search additional parameters (TP, SL, trailing), edit the ranges in `src/analytics/optimizer.ts`.

## Telegram Bot

Commands: `/start`, `/status`, `/report`, `/replay <hours>`, `/rank <limit>`, `/heatmap`, `/optimize`.

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. When `CHAT_ID` is set, only that chat can use the bot.

## Data Flow

```
pump.fun replay API
    │ fetches .jsonl.zst per hour
    ▼
Replay Player
    │ decompresses, parses, emits events with virtual clock
    ▼
Feature Builder
    │ produces FeatureSnapshot (mint, score, volume, liquidity, wallets, ...)
    ▼
Strategy
    │ pure function: filters → scorer → decision
    ▼
Paper Executor
    │ simulated buy/sell with configurable balance
    ▼
Position Manager
    │ TP / SL / trailing stop / TTL
    ▼
SQLite (features, trades, replay_state)
    ▼
Analytics (win rate, expectancy, Sharpe, drawdown)
    │
    ▼
Optimizer (brute-force grid search over params)
```

## Project Structure

```
src/
├── api/         — HTTP clients (rank, heatmap, replay, dexscreener)
├── replay/      — download, parse, play back historical data
├── feature/     — build & store feature snapshots
├── strategy/    — filters, scorer, decision (pure logic)
├── execution/   — paper trading engine
├── position/    — TP/SL/trailing/TTL management
├── storage/     — SQLite repos (features, trades, replay_state)
├── analytics/   — metrics, reports, grid optimizer
├── bot/         — Telegram bot (grammy)
├── config/      — env & default config
└── types/       — all interfaces
```

## Design

- **Deterministic** — same input always produces the same output
- **No AI** — just math and brute force
- **Immutable features** — never modify a FeatureSnapshot after creation
- **Strategy is a single file** — rewrite it without touching anything else
- **Optimizer replaces Hermes** — grid search over param ranges, measure PnL, keep best
