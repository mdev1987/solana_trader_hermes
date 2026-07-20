import type { FeatureSnapshot } from '../types/feature.ts';
import type { StrategyConfig } from '../types/strategy.ts';

export class Filters {
  private config: StrategyConfig;

  constructor(config: StrategyConfig) {
    this.config = config;
  }

  passes(snapshot: FeatureSnapshot): boolean {
    if (snapshot.liquidity < this.config.minLiquidity) return false;
    if (snapshot.activityScore < this.config.minActivityScore) return false;
    if (snapshot.holders > this.config.maxHolders) return false;
    if (snapshot.smartWallets < this.config.minSmartWallets) return false;
    return true;
  }
}
