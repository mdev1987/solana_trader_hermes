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
  private breakEvenActivatePercent: number;
  ttlMs: number;

  constructor(config: StrategyConfig) {
    this.stopLoss = new StopLoss(config.stopLossPercent);
    this.takeProfit = new TakeProfit(config.takeProfitPercent);
    this.trailingStop = new TrailingStop(config.trailingStopActivatePercent, config.trailingStopDistance);
    this.deadHoldMs = config.maxDeadHoldMs;
    this.breakEvenActivatePercent = config.breakEvenActivatePercent;
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
    if (currentPrice < pos.lowestPrice) {
      pos.lowestPrice = currentPrice;
    }

    const breakEvenThreshold = pos.entryPrice * (1 + this.breakEvenActivatePercent);
    if (pos.highestPrice >= breakEvenThreshold && pos.stopLoss < pos.entryPrice) {
      pos.stopLoss = pos.entryPrice * 0.995;
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
