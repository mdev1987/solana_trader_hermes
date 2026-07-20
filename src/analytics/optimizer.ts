import type { StrategyConfig } from '../types/strategy.ts';
import type { FeatureSnapshot } from '../types/feature.ts';
import type { TradeMetrics } from './metrics.ts';
import { Strategy } from '../strategy/strategy.ts';
import { PaperExecutor } from '../execution/paper.ts';
import { calculateMetrics } from './metrics.ts';

export interface OptimizationResult {
  config: StrategyConfig;
  metrics: TradeMetrics;
  totalPnl: number;
}

export class Optimizer {
  async gridSearch(
    snapshots: FeatureSnapshot[],
    baseConfig: StrategyConfig,
    paramRanges: {
      minScore?: number[];
      minLiquidity?: number[];
      minActivityScore?: number[];
      minSmartWallets?: number[];
    },
  ): Promise<OptimizationResult[]> {
    const results: OptimizationResult[] = [];
    const scores = paramRanges.minScore ?? [baseConfig.minScore];
    const liquidities = paramRanges.minLiquidity ?? [baseConfig.minLiquidity];
    const activities = paramRanges.minActivityScore ?? [baseConfig.minActivityScore];
    const wallets = paramRanges.minSmartWallets ?? [baseConfig.minSmartWallets];

    for (const score of scores) {
      for (const liq of liquidities) {
        for (const act of activities) {
          for (const wal of wallets) {
            const config: StrategyConfig = { ...baseConfig, minScore: score, minLiquidity: liq, minActivityScore: act, minSmartWallets: wal };
            const pnl = this.runBacktest(snapshots, config);
            results.push({ config, metrics: null as unknown as TradeMetrics, totalPnl: pnl });
          }
        }
      }
    }

    results.sort((a, b) => b.totalPnl - a.totalPnl);
    return results;
  }

  runBacktest(snapshots: FeatureSnapshot[], config: StrategyConfig): number {
    const strategy = new Strategy(config);
    const executor = new PaperExecutor(config, 1000, 0.1);

    for (const snapshot of snapshots) {
      const { decision } = strategy.evaluate(snapshot);
      if (decision === 'BUY') {
        executor.buy(snapshot.mint, 0.001, snapshot.timestamp);
      }

      const priceMap = new Map<string, number>();
      priceMap.set(snapshot.mint, 0.001);
      executor.checkPositions(priceMap, snapshot.timestamp);
    }

    const trades = executor.getTrades();
    if (trades.length === 0) return -999999;

    const metrics = calculateMetrics(trades);
    return metrics.totalPnl;
  }
}
