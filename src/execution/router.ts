import { PaperExecutor } from './paper.ts';
import type { Decision } from '../types/strategy.ts';
import type { FeatureSnapshot } from '../types/feature.ts';
import type { TradeResult, OpenPosition } from '../types/trade.ts';

export class ExecutionRouter {
  private paper: PaperExecutor;

  constructor(paper: PaperExecutor) {
    this.paper = paper;
  }

  execute(decision: Decision, snapshot: FeatureSnapshot): OpenPosition | null {
    if (decision !== 'BUY') return null;
    return this.paper.buy(snapshot.mint, snapshot.rankScore > 0 ? 1 : 0.001, snapshot.timestamp);
  }

  updatePositions(priceMap: Map<string, number>, timestamp: number): TradeResult[] {
    return this.paper.checkPositions(priceMap, timestamp);
  }

  getPaper(): PaperExecutor {
    return this.paper;
  }
}
