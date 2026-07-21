import type { FeatureSnapshot } from '../types/feature.ts';

export class Scorer {
  private weights = {
    activityScore: 0.25,
    buyRatio: 0.30,
    timeSinceLaunch: 0.15,
    liquidity: 0.20,
    walletCount: 0.10,
  };

  score(snapshot: FeatureSnapshot): number {
    const a = this.normalize(snapshot.activityScore, 0, 1);
    const b = this.normalizeBuyRatio(snapshot.buyRatio);
    const t = this.decayTime(snapshot.timeSinceLaunchMs);
    const l = this.normalize(Math.log10(snapshot.liquidity + 1), 0, 6);
    const w = this.normalize(snapshot.walletCount, 0, 1000);

    return (
      a * this.weights.activityScore +
      b * this.weights.buyRatio +
      t * this.weights.timeSinceLaunch +
      l * this.weights.liquidity +
      w * this.weights.walletCount
    ) * 100;
  }

  private normalize(value: number, min: number, max: number): number {
    if (max <= min) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  private normalizeBuyRatio(ratio: number): number {
    if (ratio < 0.3) return 0;
    if (ratio > 1) return 1;
    return (ratio - 0.3) / 0.7;
  }

  private decayTime(ms: number): number {
    if (ms < 0) return 0;
    return Math.exp(-ms / 60_000);
  }
}
