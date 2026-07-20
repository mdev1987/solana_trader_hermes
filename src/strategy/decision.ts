import type { Decision } from '../types/strategy.ts';
import type { FeatureSnapshot } from '../types/feature.ts';
import type { StrategyConfig } from '../types/strategy.ts';

export class DecisionMaker {
  private config: StrategyConfig;

  constructor(config: StrategyConfig) {
    this.config = config;
  }

  decide(score: number, _snapshot: FeatureSnapshot): Decision {
    return score >= this.config.minScore ? 'BUY' : 'SKIP';
  }
}
