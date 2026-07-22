import type { FeatureSnapshot } from '../types/feature.ts';

export class Scorer {
  private weights = {
    walletScore: 0.40,
    signalAgeScore: 0.45,
    liquidityScore: 0.15,
  };

  score(snapshot: FeatureSnapshot): number {
    const w = this.walletScore(snapshot.walletCount);
    const s = this.signalAgeScore(snapshot.timeSinceLaunchMs);
    const l = this.liquidityScore(snapshot.liquidity);

    return (
      w * this.weights.walletScore +
      s * this.weights.signalAgeScore +
      l * this.weights.liquidityScore
    ) * 100;
  }

  private walletScore(wallets: number): number {
    if (wallets < 20) return 0;
    if (wallets < 100) return (wallets - 20) / 80 * 0.3;
    if (wallets < 200) return 0.3 + (wallets - 100) / 100 * 0.1;
    if (wallets < 400) return 0.4 + (wallets - 200) / 200 * 0.2;
    if (wallets <= 800) return 0.6 + (wallets - 400) / 400 * 0.2;
    if (wallets <= 2000) return 0.8 + (wallets - 800) / 1200 * 0.2;
    if (wallets <= 5000) return 1 - (wallets - 2000) / 3000 * 0.4;
    return 0.6;
  }

  private liquidityScore(liquidity: number): number {
    if (liquidity < 10) return 0;
    if (liquidity < 500) return (liquidity - 10) / 490;
    if (liquidity <= 900) return 1;
    if (liquidity <= 2000) return 1 - (liquidity - 900) / 1100;
    return 0;
  }

  private signalAgeScore(ms: number): number {
    if (ms < 5_000) return 0;
    if (ms < 12_000) return (ms - 5_000) / 7_000 * 0.4;
    if (ms < 18_000) return 0.4 + (ms - 12_000) / 6_000 * 0.3;
    if (ms <= 30_000) return 0.7 + (ms - 18_000) / 12_000 * 0.3;
    if (ms <= 60_000) return 1 - (ms - 30_000) / 30_000 * 0.6;
    return 0.4;
  }
}
