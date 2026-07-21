import { PaperExecutor } from './paper.ts';
import type { Decision } from '../types/strategy.ts';
import type { FeatureSnapshot } from '../types/feature.ts';
import type { TradeResult, OpenPosition } from '../types/trade.ts';

export class ExecutionRouter {
  private paper: PaperExecutor;

  constructor(paper: PaperExecutor) {
    this.paper = paper;
  }

  execute(decision: Decision, snapshot: FeatureSnapshot, price: number, entryDelayMs = 0, signalAgeMs = 0, decisionPrice = 0, entryScore = 0): OpenPosition | null {
    if (decision !== 'BUY' || price <= 0) return null;
    return this.paper.buy(snapshot.mint, price, snapshot.timestamp, entryDelayMs, signalAgeMs, decisionPrice, entryScore);
  }

  updatePositions(priceMap: Map<string, number>, timestamp: number): TradeResult[] {
    return this.paper.checkPositions(priceMap, timestamp);
  }

  getPaper(): PaperExecutor {
    return this.paper;
  }
}
