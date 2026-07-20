import type { FeatureSnapshot } from '../types/feature.ts';

export class Scorer {
  private weights = {
    activityScore: 0.3,
    smartWallets: 0.25,
    liquidity: 0.2,
    tradeVolume: 0.15,
    walletCount: 0.1,
  };

  score(snapshot: FeatureSnapshot): number {
    const a = this.normalize(snapshot.activityScore, 0, 1);
    const s = this.normalize(snapshot.smartWallets, 0, 50);
    const l = this.normalize(Math.log10(snapshot.liquidity + 1), 0, 6);
    const v = this.normalize(Math.log10(snapshot.tradeVolume + 1), 0, 8);
    const w = this.normalize(snapshot.walletCount, 0, 1000);

    return (
      a * this.weights.activityScore +
      s * this.weights.smartWallets +
      l * this.weights.liquidity +
      v * this.weights.tradeVolume +
      w * this.weights.walletCount
    ) * 100;
  }

  private normalize(value: number, min: number, max: number): number {
    if (max <= min) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }
}
