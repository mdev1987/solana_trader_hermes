import type { OpenPosition, TradeResult } from '../types/trade.ts';
import type { StrategyConfig } from '../types/strategy.ts';
import { PositionManager } from '../position/manager.ts';

let tradeCounter = 0;

export class PaperExecutor {
  private balance: number;
  private solAmount: number;
  private positionManager: PositionManager;
  private trades: TradeResult[] = [];
  private positions: Map<string, OpenPosition> = new Map();

  constructor(config: StrategyConfig, initialBalance: number, solAmount: number) {
    this.balance = initialBalance;
    this.solAmount = solAmount;
    this.positionManager = new PositionManager(config);
  }

  getBalance(): number {
    return this.balance;
  }

  getPositions(): Map<string, OpenPosition> {
    return this.positions;
  }

  getTrades(): TradeResult[] {
    return this.trades;
  }

  buy(mint: string, price: number, timestamp: number): OpenPosition | null {
    const cost = this.solAmount * price;
    if (cost > this.balance) return null;

    this.balance -= cost;
    tradeCounter++;

    const position: OpenPosition = {
      id: `trade_${tradeCounter}`,
      mint,
      entryPrice: price,
      quantity: this.solAmount,
      entryTime: timestamp,
      highestPrice: price,
      stopLoss: this.positionManager.calcStopLoss(price),
      takeProfit: this.positionManager.calcTakeProfit(price),
      trailingStopDistance: 0,
      trailingStopActivated: false,
      ttl: timestamp + this.positionManager.ttlMs,
    };

    this.positions.set(mint, position);
    return position;
  }

  sell(mint: string, price: number, timestamp: number, exitReason: TradeResult['exitReason'] = 'manual'): TradeResult | null {
    const position = this.positions.get(mint);
    if (!position) return null;

    this.positions.delete(mint);
    const proceeds = position.quantity * price;
    this.balance += proceeds;

    const pnl = proceeds - (position.quantity * position.entryPrice);
    const pnlPercent = (price - position.entryPrice) / position.entryPrice;
    const fees = (proceeds + position.quantity * position.entryPrice) * 0.001;

    const trade: TradeResult = {
      id: position.id,
      mint,
      entryPrice: position.entryPrice,
      exitPrice: price,
      quantity: position.quantity,
      entryTime: position.entryTime,
      exitTime: timestamp,
      pnl: pnl - fees,
      pnlPercent,
      exitReason,
      fees,
    };

    this.trades.push(trade);
    return trade;
  }

  checkPositions(currentPriceMap: Map<string, number>, timestamp: number): TradeResult[] {
    const exited: TradeResult[] = [];

    for (const [mint, pos] of this.positions) {
      const price = currentPriceMap.get(mint);
      if (!price) continue;

      const reason = this.positionManager.checkExit(pos, price, timestamp);
      if (reason) {
        const result = this.sell(mint, price, timestamp, reason);
        if (result) exited.push(result);
      }
    }

    return exited;
  }
}
