import type { FeatureSnapshot } from '../types/feature.ts';
import type { StrategyConfig } from '../types/strategy.ts';

export class Filters {
  private config: StrategyConfig;

  constructor(config: StrategyConfig) {
    this.config = config;
  }

  passes(snapshot: FeatureSnapshot): string | null {
    if (snapshot.liquidity < this.config.minLiquidity) return `liquidity_below_min`;
    if (snapshot.liquidity > this.config.maxLiquidity) return `liquidity_above_max`;
    if (snapshot.timeSinceLaunchMs < 0) return `negative_age`;
    if (snapshot.timeSinceLaunchMs > this.config.maxSignalAgeMs) return `signal_too_old`;
    if (snapshot.walletCount > this.config.maxWallets) return `wallets_above_max`;
    if (snapshot.buyRatio < 0.3) return `buy_ratio_too_low`;
    return null;
  }
}
