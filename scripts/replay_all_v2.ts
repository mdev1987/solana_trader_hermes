import { initDb } from '../src/storage/database.ts';
import { Player } from '../src/replay/player.ts';
import { FeatureBuilder } from '../src/feature/builder.ts';
import { FeatureStore } from '../src/feature/store.ts';
import { Strategy } from '../src/strategy/strategy.ts';
import { PaperExecutor } from '../src/execution/paper.ts';
import { ExecutionRouter } from '../src/execution/router.ts';
import { TradeRepository } from '../src/storage/trade_repository.ts';
import { FeatureRepository } from '../src/storage/feature_repository.ts';
import { calculateMetrics, outlierReports } from '../src/analytics/metrics.ts';
import { printReport, printOutlierReports } from '../src/analytics/report.ts';
import { createConfig } from '../src/config/config.ts';
import { ENV } from '../src/config/env.ts';
import type { ReplayEvent } from '../src/types/replay.ts';
import type { FeatureSnapshot } from '../src/types/feature.ts';
import { readdirSync } from 'node:fs';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

function replayDir(): string {
  const base = ENV.DATA_DIR;
  return `${base}/replay/2026/07/20`;
}

async function main() {
  try {
    const files = readdirSync(replayDir())
      .filter(f => f.endsWith('.jsonl.zst'))
      .sort();
    console.log(`Found ${files.length} replay files`);
    initDb();

    const config = createConfig();
    const featureBuilder = new FeatureBuilder();
    const featureStore = new FeatureStore();
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
          executor.setLastTradeFeatures(JSON.stringify({
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
          }));
          console.log(`[BUY] ${pb.mint} score=${pb.score.toFixed(1)} age=${ageSec}s buyR=${br} price=${price.toExponential(3)} delay=${entryDelayMs}ms`);
        }
      }
      return filled;
    };

    const cleanupExpiredPendingBuys = (now: number): void => {
      let i = 0;
      while (i < pendingBuys.length) {
        if (pendingBuys[i]!.expiresAt <= now) { pendingBuys.splice(i, 1); }
        else { i++; }
      }
    };

    const handler = (event: ReplayEvent) => {
      if (!event.mint || !event.mint.endsWith('pump')) return;
      if (event.action !== 'buy' && event.action !== 'sell' && event.action !== 'create') return;

      const tokenAmount = event.tokenAmount ?? event.initialBuy ?? 0;
      const price = event.quoteAmount && tokenAmount ? event.quoteAmount / tokenAmount : 0;

      tryFillPendingBuy(event, price);
      cleanupExpiredPendingBuys(event.timestamp);

      if (price <= 0) return;

      const snapshot = featureBuilder.fromReplayEvent(event);
      if (!snapshot) return;
      if (snapshot.timeSinceLaunchMs < DECISION_DELAY_MS) return;
      featureStore.set(snapshot);

      const { decision, score } = strategy.evaluate(snapshot);
      snapshotCache.set(event.mint, { ...snapshot, rankScore: score });
      if (decision === 'BUY') {
        if (price < MIN_PRICE) return;
        const soldAt = recentlySold.get(event.mint);
        if (soldAt && event.timestamp - soldAt < COOLDOWN_MS) return;
        if (pendingBuys.some(pb => pb.mint === event.mint)) return;
        if (router.getPaper().getPositions().has(event.mint!)) return;
        if (router.getPaper().getPositions().size + pendingBuys.length >= MAX_POSITIONS) return;
        pendingBuys.push({
          mint: event.mint, snapshot, score,
          executeAt: event.timestamp + DELAY_MS,
          expiresAt: event.timestamp + DELAY_MS + PENDING_BUY_TIMEOUT_MS,
          decisionPrice: price,
        });
        console.log(`[SIGNAL] ${event.mint} score=${score.toFixed(1)} price=${price.toExponential(3)} delay=${DELAY_MS}ms`);
      }

      const priceMap = new Map([[event.mint, price]]);
      const exited = router.updatePositions(priceMap, event.timestamp);
      for (const trade of exited) {
        const holdSec = ((trade.exitTime - trade.entryTime) / 1000).toFixed(0);
        trade.features = JSON.stringify({
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
        console.log(`[SELL] ${trade.mint} pnl=${trade.pnl.toFixed(4)} (${(trade.pnlPercent * 100).toFixed(2)}%) reason=${trade.exitReason} hold=${holdSec}s`);
        recentlySold.set(trade.mint, event.timestamp);
        tradeRepo.save(trade);
        featureRepo.save(snapshot);
      }
    };

    let totalCount = 0;
    for (const file of files) {
      const filePath = `${replayDir()}/${file}`;
      console.log(`[file] ${filePath}`);
      const player = new Player();
      player.onEvent(handler);
      try {
        const count = await player.replayFile(filePath);
        totalCount += count;
        console.log(`  done: ${count} events`);
        await sleep(100);
      } catch (e) {
        console.error(`  ERROR on ${file}:`, e);
        break;
      }
    }

    console.log(`[replay] Processed ${totalCount} events across ${files.length} files`);

    const trades = executor.getTrades();
    console.log(`[replay] Trades: ${trades.length}`);

    if (trades.length > 0) {
      const metrics = calculateMetrics(trades);
      printReport(metrics);
      const reports = outlierReports(trades);
      if (reports.length > 0) printOutlierReports(reports);
    }
  } catch (e) {
    console.error('FATAL:', e);
  }
}

main();
