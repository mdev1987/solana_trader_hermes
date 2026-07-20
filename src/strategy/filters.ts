import type { FeatureSnapshot } from '../types/feature.ts';
import type { StrategyConfig } from '../types/strategy.ts';

export class Filters {
  private config: StrategyConfig;

  constructor(config: StrategyConfig) {
    this.config = config;
  }

  passes(snapshot: FeatureSnapshot): boolean {
    if (snapshot.liquidity < this.config.minLiquidity) return false;
    if (snapshot.timeSinceLaunchMs < 0) return false;
    if (snapshot.buyRatio < 0.3) return false;
    return true;
  }
}
