import { initDb } from './storage/database.ts';
import { Player } from './replay/player.ts';
import { FeatureBuilder } from './feature/builder.ts';
import { FeatureStore } from './feature/store.ts';
import { Strategy } from './strategy/strategy.ts';
import { PaperExecutor } from './execution/paper.ts';
import { ExecutionRouter } from './execution/router.ts';
import { TradeRepository } from './storage/trade_repository.ts';
import { FeatureRepository } from './storage/feature_repository.ts';

import { calculateMetrics } from './analytics/metrics.ts';
import { printReport } from './analytics/report.ts';
import { Optimizer } from './analytics/optimizer.ts';
import { createConfig } from './config/config.ts';
import { ENV } from './config/env.ts';
import { fetchRankings } from './api/rank_api.ts';
import { fetchHeatmap } from './api/heatmap_api.ts';
import type { ReplayEvent } from './types/replay.ts';
import type { FeatureSnapshot } from './types/feature.ts';

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'replay';

  initDb();

  switch (command) {
    case 'replay':
      await runReplay(args);
      break;
    case 'rank':
      await runRank(args);
      break;
    case 'heatmap':
      await runHeatmap(args);
      break;
    case 'optimize':
      await runOptimize();
      break;
    case 'report':
      await runReport();
      break;
    case 'bot':
      await runBot();
      break;
    default:
      console.log(`Usage: bun run main.ts <command>`);
      console.log('  replay   - Replay recent hours (default 2). Flags: --hour YYYY/MM/DD/HH, --file <path>, --no-cache');
      console.log('  rank     - Fetch and display current rankings');
      console.log('  heatmap  - Fetch and display heatmap data');
      console.log('  optimize - Run grid search optimization');
      console.log('  report   - Show trade report from database');
      console.log('  bot      - Start Telegram bot');
  }
}

async function runReplay(args: string[]): Promise<void> {
  const noCache = args.includes('--no-cache');
  const numericArgs = args.filter((a) => !a.startsWith('--'));
  const hoursCount = Number(numericArgs[1] ?? 2);
  const config = createConfig();
  const featureBuilder = new FeatureBuilder();
  const featureStore = new FeatureStore();
  const player = new Player();
  player.noCache = noCache;
  const strategy = new Strategy(config);
  const executor = new PaperExecutor(config, ENV.PAPER_BALANCE, ENV.PAPER_SOL_AMOUNT);
  const router = new ExecutionRouter(executor);
  const tradeRepo = new TradeRepository();
  const featureRepo = new FeatureRepository();
  const snapshotCache = new Map<string, FeatureSnapshot>();

  player.onEvent((event: ReplayEvent) => {
    if (!event.mint || !event.mint.endsWith('pump')) return;
    if (event.action !== 'buy' && event.action !== 'sell' && event.action !== 'create') return;

    const tokenAmount = event.tokenAmount ?? event.initialBuy ?? 0;
    const price = event.quoteAmount && tokenAmount ? event.quoteAmount / tokenAmount : 0;

    const snapshot = featureBuilder.fromReplayEvent(event);
    if (!snapshot) return;
    featureStore.set(snapshot);
    snapshotCache.set(event.mint, snapshot);

    const { decision, score } = strategy.evaluate(snapshot);
    if (decision === 'BUY') {
      const pos = router.execute(decision, snapshot);
      if (pos) console.log(`[BUY] ${event.mint} score=${score.toFixed(1)} price=${price.toExponential(3)}`);
    }

    const priceMap = new Map([[event.mint, price]]);
    const exited = router.updatePositions(priceMap, event.timestamp);
    for (const trade of exited) {
      console.log(`[SELL] ${trade.mint} pnl=${trade.pnl.toFixed(4)} (${(trade.pnlPercent * 100).toFixed(2)}%) reason=${trade.exitReason}`);
      tradeRepo.save(trade);
      featureRepo.save(snapshot);
    }

    snapshotCache.set(event.mint, { ...snapshot, rankScore: score });
  });

  let count = 0;

  const hourIdx = args.indexOf('--hour');
  if (hourIdx !== -1 && args[hourIdx + 1]) {
    const parts = args[hourIdx + 1]!.split(/[/:]/);
    if (parts.length === 4) {
      const hour = { year: Number(parts[0]!), month: Number(parts[1]!), day: Number(parts[2]!), hour: Number(parts[3]!) };
      count = await player.replayHours([hour], `hour`);
    }
  }

  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    count += await player.replayFile(args[fileIdx + 1]!);
  }

  if (!args.includes('--hour') && !args.includes('--file')) {
    console.log(`[replay] Downloading last ${hoursCount} hours...`);
    count = await player.replayRecent(hoursCount);
  }

  console.log(`[replay] Processed ${count} events`);

  const trades = executor.getTrades();
  console.log(`[replay] Trades: ${trades.length}`);

  if (trades.length > 0) {
    const metrics = calculateMetrics(trades);
    printReport(metrics);
  }
}

async function runRank(args: string[]): Promise<void> {
  const limit = Number(args[1] ?? 10);
  const rankings = await fetchRankings(limit);
  console.log(`Top ${rankings.length} tokens by rank:\n`);
  for (const r of rankings) {
    console.log(`  ${r.symbol.padEnd(12)} score=${r.activity_score.toFixed(4)} liq=$${r.pair_summary_info.liquidity.toFixed(0)} wallets=${r.smart_wallet_total_count} tier=${r.token_tier || '-'}`);
  }
}

async function runHeatmap(_args: string[]): Promise<void> {
  const heatmap = await fetchHeatmap();
  const entries = heatmap.data.heatmap;
  console.log(`Heatmap: ${entries.length} entries\n`);
  for (const e of entries.slice(0, 20)) {
    const time = new Date(e.time * 1000).toISOString();
    console.log(`  ${time} wallets=${e.wallet_count} vol=$${e.trade_volume.toFixed(0)} tokens=${e.tokens.length}`);
  }
}

async function runOptimize(): Promise<void> {
  const featureRepo = new FeatureRepository();
  const snapshots = featureRepo.getAll();

  if (snapshots.length === 0) {
    console.log('[optimize] No features in database. Run `replay` first.');
    return;
  }

  const base = createConfig();
  const optimizer = new Optimizer();
  const results = await optimizer.gridSearch(snapshots, base, {
    minScore: [60, 65, 70, 75, 80, 85, 90],
    minLiquidity: [500, 1000, 2000, 5000],
    minActivityScore: [0.05, 0.1, 0.2, 0.3],
    minSmartWallets: [0, 1, 2, 3],
  });

  console.log('[optimize] Top 10 parameter combinations:\n');
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i]!;
    console.log(`  #${i + 1} score>=${r.config.minScore} liq>=${r.config.minLiquidity} act>=${r.config.minActivityScore} wallets>=${r.config.minSmartWallets} → PnL=$${r.totalPnl.toFixed(2)}`);
  }
}

async function runReport(): Promise<void> {
  const tradeRepo = new TradeRepository();
  const trades = tradeRepo.getAll();
  console.log(`[report] ${trades.length} trades in database\n`);
  if (trades.length > 0) {
    const metrics = calculateMetrics(trades);
    printReport(metrics);
  }
}

async function runBot(): Promise<void> {
  const { startBot } = await import('./bot/index.ts');
  await startBot();
}

main().catch(console.error);
