import { initDb } from './storage/database.ts';
import { Player } from './replay/player.ts';
import { FeatureBuilder } from './feature/builder.ts';
import { FeatureStore } from './feature/store.ts';
import { Strategy } from './strategy/strategy.ts';
import { PaperExecutor } from './execution/paper.ts';
import { ExecutionRouter } from './execution/router.ts';
import { TradeRepository } from './storage/trade_repository.ts';
import { FeatureRepository } from './storage/feature_repository.ts';

import { calculateMetrics, outlierReports } from './analytics/metrics.ts';
import { printReport, printOutlierReports } from './analytics/report.ts';
import { analyzeDb } from './analytics/analysis.ts';
import { Optimizer } from './analytics/optimizer.ts';
import { logRejection } from './strategy/rejection_logger.ts';
import { createConfig } from './config/config.ts';
import { ENV } from './config/env.ts';
import { fetchRankings } from './api/rank_api.ts';
import { fetchHeatmap } from './api/heatmap_api.ts';
import type { ReplayEvent } from './types/replay.ts';
import type { FeatureSnapshot } from './types/feature.ts';

interface PendingBuy {
  mint: string;
  snapshot: FeatureSnapshot;
  score: number;
  executeAt: number;
  expiresAt: number;
  decisionPrice: number;
}

const PENDING_BUY_TIMEOUT_MS = 10_000;
const FILL_WINDOW_MS = 500;
const DECISION_DELAY_MS = 2000;

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
    case 'analysis':
      await runAnalysis();
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
      console.log('  analysis - Show detailed DB trade analysis');
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

  const COOLDOWN_MS = 300_000;
  const MAX_POSITIONS = 5;
  const MIN_PRICE = 1e-10;
  const DELAY_MS = config.executionDelayMs;

  const recentlySold = new Map<string, number>();
  const featureRepo = new FeatureRepository();
  const snapshotCache = new Map<string, FeatureSnapshot>();
  const lastPrices = new Map<string, number>();
  const pendingBuys: PendingBuy[] = [];

  const tryFillPendingBuy = (event: ReplayEvent, price: number): boolean => {
    let filled = false;
    let i = 0;
    while (i < pendingBuys.length) {
      const pb = pendingBuys[i]!;
      if (pb.mint !== event.mint) { i++; continue; }
      if (event.timestamp < pb.executeAt) { i++; continue; }

      const windowEnd = pb.executeAt + FILL_WINDOW_MS;
      if (event.timestamp >= windowEnd) {
        pendingBuys.splice(i, 1);
        console.log(`[CANCEL] ${pb.mint} score=${pb.score.toFixed(1)} reason=fill_window_exceeded`);
        continue;
      }

      pendingBuys.splice(i, 1);

      const soldAt = recentlySold.get(pb.mint);
      if (soldAt && event.timestamp - soldAt < COOLDOWN_MS) continue;
      if (router.getPaper().getPositions().has(pb.mint)) continue;
      if (router.getPaper().getPositions().size >= MAX_POSITIONS) continue;
      if (price <= 0) continue;

      const entryDelayMs = event.timestamp - (pb.executeAt - DELAY_MS);
      const signalAgeMs = pb.snapshot.timeSinceLaunchMs;
      const pos = router.execute('BUY', pb.snapshot, price, entryDelayMs, signalAgeMs, pb.decisionPrice, pb.score);
      if (pos) {
        filled = true;
        const ageSec = (signalAgeMs / 1000).toFixed(1);
        const br = pb.snapshot.buyRatio.toFixed(2);
        const features = JSON.stringify({
          score: pb.score.toFixed(1),
          activity: pb.snapshot.activityScore.toFixed(3),
          buyRatio: br,
          wallets: pb.snapshot.walletCount,
          liquidity: pb.snapshot.liquidity.toFixed(2),
          signalAgeSec: ageSec,
          entryDelayMs,
          entryPrice: price.toExponential(3),
          decisionPrice: pb.decisionPrice.toExponential(3),
          decision: 'BUY',
        });
        executor.setLastTradeFeatures(features);
        console.log(`[BUY] ${pb.mint} score=${pb.score.toFixed(1)} age=${ageSec}s buyR=${br} price=${price.toExponential(3)} delay=${entryDelayMs}ms`);
      }
    }
    return filled;
  };

  const cleanupExpiredPendingBuys = (now: number): void => {
    let i = 0;
    while (i < pendingBuys.length) {
      if (pendingBuys[i]!.expiresAt <= now) {
        pendingBuys.splice(i, 1);
      } else {
        i++;
      }
    }
  };

  player.onEvent((event: ReplayEvent) => {
    if (!event.mint || !event.mint.endsWith('pump')) return;
    if (event.action !== 'buy' && event.action !== 'sell' && event.action !== 'create') return;

    const tokenAmount = event.tokenAmount ?? event.initialBuy ?? 0;
    const price = event.quoteAmount && tokenAmount ? event.quoteAmount / tokenAmount : 0;

    lastPrices.set(event.mint, price);
    tryFillPendingBuy(event, price);
    cleanupExpiredPendingBuys(event.timestamp);

    if (price <= 0) return;

    const snapshot = featureBuilder.fromReplayEvent(event);
    if (!snapshot) return;
    if (snapshot.timeSinceLaunchMs < DECISION_DELAY_MS) {
      logRejection(event.mint, event.timestamp, snapshot, 0, 'too_early', price);
      return;
    }
    featureStore.set(snapshot);

    const { decision, score, reason } = strategy.evaluate(snapshot);
    snapshotCache.set(event.mint, { ...snapshot, rankScore: score });
    if (decision === 'BUY') {
      if (price < MIN_PRICE) return;
      const soldAt = recentlySold.get(event.mint);
      if (soldAt && event.timestamp - soldAt < COOLDOWN_MS) return;
      if (pendingBuys.some(pb => pb.mint === event.mint)) return;
      if (router.getPaper().getPositions().has(event.mint!)) return;
      if (router.getPaper().getPositions().size + pendingBuys.length >= MAX_POSITIONS) return;

      pendingBuys.push({
        mint: event.mint,
        snapshot,
        score,
        executeAt: event.timestamp + DELAY_MS,
        expiresAt: event.timestamp + DELAY_MS + PENDING_BUY_TIMEOUT_MS,
        decisionPrice: price,
      });
      console.log(`[SIGNAL] ${event.mint} score=${score.toFixed(1)} price=${price.toExponential(3)} delay=${DELAY_MS}ms`);
    } else {
      logRejection(event.mint, event.timestamp, snapshot, score, reason, price);
    }

    const priceMap = new Map([[event.mint, price]]);
    const exited = router.updatePositions(priceMap, event.timestamp);
    for (const trade of exited) {
      const holdSec = ((trade.exitTime - trade.entryTime) / 1000).toFixed(0);
      const features = JSON.stringify({
        score: snapshotCache.get(trade.mint)?.rankScore.toFixed(1) ?? '?',
        activity: snapshot.activityScore.toFixed(3),
        buyRatio: snapshot.buyRatio.toFixed(2),
        wallets: snapshot.walletCount,
        liquidity: snapshot.liquidity.toFixed(2),
        holdSec,
        entryPrice: trade.entryPrice.toExponential(3),
        exitPrice: trade.exitPrice.toExponential(3),
        maxPrice: trade.maxPrice.toExponential(3),
        decisionPrice: trade.decisionPrice.toExponential(3),
        entryDelayMs: trade.entryDelayMs,
        roi: (trade.pnlPercent * 100).toFixed(2),
        decision: 'SELL',
        result: trade.pnl > 0 ? 'WIN' : 'LOSS',
        exitReason: trade.exitReason,
      });
      trade.features = features;
      console.log(`[SELL] ${trade.mint} pnl=${trade.pnl.toFixed(4)} (${(trade.pnlPercent * 100).toFixed(2)}%) reason=${trade.exitReason} hold=${holdSec}s`);
      recentlySold.set(trade.mint, event.timestamp);
      tradeRepo.save(trade);
      featureRepo.save(snapshot);
    }

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
  if (fileIdx !== -1) {
    let f = fileIdx + 1;
    while (f < args.length && !args[f]!.startsWith('--')) {
      count += await player.replayFile(args[f]!);
      f++;
    }
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
    const reports = outlierReports(trades);
    if (reports.length > 0) printOutlierReports(reports);
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

async function runAnalysis(): Promise<void> {
  const csv = process.argv.includes('--csv');
  analyzeDb(csv);
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
