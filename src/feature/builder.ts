import type { ReplayEvent } from '../types/replay.ts';
import type { FeatureSnapshot } from '../types/feature.ts';
import type { TokenRank } from '../types/rank.ts';
import type { SignalInfo } from '../types/heatmap.ts';
import { TokenFeatureExtractor } from './token.ts';
import { MarketFeatureExtractor } from './market.ts';

export class FeatureBuilder {
  private tokenExtractor: TokenFeatureExtractor;
  private marketExtractor: MarketFeatureExtractor;

  constructor() {
    this.tokenExtractor = new TokenFeatureExtractor();
    this.marketExtractor = new MarketFeatureExtractor();
  }

  fromReplayEvent(event: ReplayEvent): FeatureSnapshot {
    return {
      mint: event.mint,
      timestamp: event.timestamp,
      rankScore: 0,
      signalCount: 0,
      walletCount: 0,
      tradeVolume: event.volume,
      liquidity: 0,
      holders: 0,
      activityScore: 0,
      smartWallets: 0,
    };
  }

  fromRankData(rank: TokenRank): FeatureSnapshot {
    return this.tokenExtractor.extract(rank);
  }

  fromSignalInfo(mint: string, signal: SignalInfo): FeatureSnapshot {
    return {
      mint,
      timestamp: signal.first_time,
      rankScore: 0,
      signalCount: signal.signal_count,
      walletCount: 0,
      tradeVolume: 0,
      liquidity: 0,
      holders: 0,
      activityScore: this.marketExtractor.signalLevelToScore(signal.token_level),
      smartWallets: 0,
    };
  }

  merge(base: FeatureSnapshot, update: Partial<FeatureSnapshot>): FeatureSnapshot {
    return { ...base, ...update };
  }
}
