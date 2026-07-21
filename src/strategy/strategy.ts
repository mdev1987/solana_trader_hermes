import type { Decision, StrategyConfig, ScoredToken } from '../types/strategy.ts';
import type { FeatureSnapshot } from '../types/feature.ts';
import { Filters } from './filters.ts';
import { Scorer } from './scorer.ts';
import { DecisionMaker } from './decision.ts';

export class Strategy {
  private filters: Filters;
  private scorer: Scorer;
  private decisionMaker: DecisionMaker;

  constructor(config: StrategyConfig) {
    this.filters = new Filters(config);
    this.scorer = new Scorer();
    this.decisionMaker = new DecisionMaker(config);
  }

  evaluate(snapshot: FeatureSnapshot): { decision: Decision; score: number; reason: string } {
    const filterReason = this.filters.passes(snapshot);
    if (filterReason) {
      return { decision: 'SKIP', score: 0, reason: filterReason };
    }

    const score = this.scorer.score(snapshot);
    if (score >= 98 && snapshot.walletCount < 100) {
      return { decision: 'SKIP', score, reason: 'high_score_low_wallets' };
    }
    const decision = this.decisionMaker.decide(score, snapshot);
    return { decision, score, reason: decision === 'BUY' ? `score=${score.toFixed(1)}` : 'below_min_score' };
  }

  evaluateBatch(snapshots: FeatureSnapshot[]): ScoredToken[] {
    return snapshots
      .map((s) => {
        const { score } = this.evaluate(s);
        return { mint: s.mint, score, reason: '' };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}
