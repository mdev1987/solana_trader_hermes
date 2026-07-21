import type { FeatureSnapshot } from '../types/feature.ts';

export class Scorer {
  private weights = {
    activityScore: 0.40,
    walletScore: 0.25,
    liquidityScore: 0.20,
    signalAgeScore: 0.15,
  };

  score(snapshot: FeatureSnapshot): number {
    const a = this.normalize(snapshot.activityScore, 0, 1);
    const w = this.walletScore(snapshot.walletCount);
    const l = this.liquidityScore(snapshot.liquidity);
    const s = this.signalAgeScore(snapshot.timeSinceLaunchMs);

    return (
      a * this.weights.activityScore +
      w * this.weights.walletScore +
      l * this.weights.liquidityScore +
      s * this.weights.signalAgeScore
    ) * 100;
  }

  private normalize(value: number, min: number, max: number): number {
    if (max <= min) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  private walletScore(wallets: number): number {
    if (wallets <= 0) return 0;
    if (wallets < 50) return wallets / 50;
    if (wallets <= 300) return 1;
    if (wallets <= 800) return 1 - (wallets - 300) / 500;
    if (wallets <= 2000) return 0.1;
    return 0;
  }

  private liquidityScore(liquidity: number): number {
    if (liquidity < 10) return liquidity / 10;
    if (liquidity <= 500) return 1;
    if (liquidity <= 2000) return 1 - (liquidity - 500) / 1500;
    return 0;
  }

  private signalAgeScore(ms: number): number {
    if (ms < 0) return 0;
    if (ms < 10_000) return 1;
    if (ms <= 60_000) return 1 - (ms - 10_000) / 50_000;
    return 0;
  }
}
