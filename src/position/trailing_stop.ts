export class TrailingStop {
  private activatePercent: number;
  private distance: number;

  constructor(activatePercent: number, distance: number) {
    this.activatePercent = activatePercent;
    this.distance = distance;
  }

  shouldActivate(currentPrice: number, entryPrice: number): boolean {
    const gain = (currentPrice - entryPrice) / entryPrice;
    return gain >= this.activatePercent;
  }

  updateStop(currentPrice: number): number {
    return currentPrice * (1 - this.distance);
  }

  isHit(currentPrice: number, trailingStop: number): boolean {
    return currentPrice <= trailingStop;
  }
}
