import type { TradeResult } from '../types/trade.ts';
import type { OpenPosition } from '../types/trade.ts';
import type { StrategyConfig } from '../types/strategy.ts';
import { StopLoss } from './stop_loss.ts';
import { TakeProfit } from './take_profit.ts';
import { TrailingStop } from './trailing_stop.ts';

export class PositionManager {
  private stopLoss: StopLoss;
  private takeProfit: TakeProfit;
  private trailingStop: TrailingStop;
  private deadHoldMs: number;
  ttlMs: number;

  constructor(config: StrategyConfig) {
    this.stopLoss = new StopLoss(config.stopLossPercent);
    this.takeProfit = new TakeProfit(config.takeProfitPercent);
    this.trailingStop = new TrailingStop(config.trailingStopActivatePercent, config.trailingStopDistance);
    this.deadHoldMs = config.maxDeadHoldMs;
    this.ttlMs = config.positionTtlMs;
  }

  calcStopLoss(entryPrice: number): number {
    return this.stopLoss.calc(entryPrice);
  }

  calcTakeProfit(entryPrice: number): number {
    return this.takeProfit.calc(entryPrice);
  }

  checkExit(pos: OpenPosition, currentPrice: number, timestamp: number): TradeResult['exitReason'] | null {
    if (currentPrice > pos.highestPrice) {
      pos.highestPrice = currentPrice;
    }

    if (this.stopLoss.isHit(currentPrice, pos.stopLoss)) {
      return 'sl';
    }

    if (this.takeProfit.isHit(currentPrice, pos.takeProfit)) {
      return 'tp';
    }

    if (timestamp >= pos.ttl) {
      return 'ttl';
    }

    const holdMs = timestamp - pos.entryTime;
    if (holdMs >= this.deadHoldMs && pos.highestPrice <= pos.entryPrice) {
      return 'dead';
    }

    if (this.trailingStop.shouldActivate(currentPrice, pos.entryPrice)) {
      pos.trailingStopActivated = true;
    }

    if (pos.trailingStopActivated) {
      const trailStop = this.trailingStop.updateStop(pos.highestPrice);
      if (this.trailingStop.isHit(currentPrice, trailStop)) {
        return 'trailing';
      }
    }

    return null;
  }
}
