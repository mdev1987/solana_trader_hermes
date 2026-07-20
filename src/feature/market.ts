export class MarketFeatureExtractor {
  signalLevelToScore(level: string): number {
    switch (level) {
      case 'gold': return 0.9;
      case 'silver': return 0.6;
      case 'bronze': return 0.3;
      default: return 0;
    }
  }
}
