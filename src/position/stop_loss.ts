export class StopLoss {
  private percent: number;

  constructor(percent: number) {
    this.percent = percent;
  }

  calc(entryPrice: number): number {
    return entryPrice * (1 + this.percent);
  }

  isHit(currentPrice: number, stopLoss: number): boolean {
    return currentPrice <= stopLoss;
  }
}
