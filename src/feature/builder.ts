import type { ReplayEvent } from '../types/replay.ts';
import type { FeatureSnapshot } from '../types/feature.ts';
import type { TokenRank } from '../types/rank.ts';
import type { SignalInfo } from '../types/heatmap.ts';
import { TokenFeatureExtractor } from './token.ts';
import { MarketFeatureExtractor } from './market.ts';

interface MintState {
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  buyCount: number;
  sellCount: number;
  volumeTotal: number;
  wallets: Set<string>;
  highestQuoteAmount: number;
  lastQuoteAmount: number;
  lastTokenAmount: number;
}

export class FeatureBuilder {
  private tokenExtractor: TokenFeatureExtractor;
  private marketExtractor: MarketFeatureExtractor;
  private state: Map<string, MintState> = new Map();

  constructor() {
    this.tokenExtractor = new TokenFeatureExtractor();
    this.marketExtractor = new MarketFeatureExtractor();
  }

  private getOrCreateState(mint: string): MintState {
    let s = this.state.get(mint);
    if (!s) {
      s = {
        firstSeen: 0,
        lastSeen: 0,
        eventCount: 0,
        buyCount: 0,
        sellCount: 0,
        volumeTotal: 0,
        wallets: new Set(),
        highestQuoteAmount: 0,
        lastQuoteAmount: 0,
        lastTokenAmount: 0,
      };
      this.state.set(mint, s);
    }
    return s;
  }

  fromReplayEvent(event: ReplayEvent): FeatureSnapshot | null {
    if (!event.mint || !event.mint.endsWith('pump')) return null;
    if (event.action !== 'buy' && event.action !== 'sell' && event.action !== 'create') return null;

    const s = this.getOrCreateState(event.mint);

    if (s.eventCount === 0) s.firstSeen = event.timestamp;
    s.lastSeen = event.timestamp;
    s.eventCount++;

    if (event.action === 'buy') s.buyCount++;
    else if (event.action === 'sell') s.sellCount++;

    if (event.txSigner) s.wallets.add(event.txSigner);

    if (event.action === 'buy' || event.action === 'sell') {
      s.volumeTotal += event.quoteAmount ?? 0;
      if ((event.quoteAmount ?? 0) > s.highestQuoteAmount) {
        s.highestQuoteAmount = event.quoteAmount ?? 0;
      }
      s.lastQuoteAmount = event.quoteAmount ?? 0;
      s.lastTokenAmount = event.tokenAmount ?? 0;
    }

    if (event.action === 'create') {
      s.volumeTotal += event.quoteAmount ?? 0;
      s.buyCount++;
      s.lastQuoteAmount = event.quoteAmount ?? 0;
      s.lastTokenAmount = event.initialBuy ?? 0;
    }

    const timeSpan = Math.max(s.lastSeen - s.firstSeen, 1);
    const eventsPerMin = s.eventCount / (timeSpan / 60000);
    const activityScore = Math.min(eventsPerMin / 100, 1);
    const walletCount = s.wallets.size;
    const price = s.lastTokenAmount > 0 ? s.lastQuoteAmount / s.lastTokenAmount : 0;

    return {
      mint: event.mint,
      timestamp: event.timestamp,
      rankScore: 0,
      signalCount: s.eventCount,
      walletCount,
      tradeVolume: s.volumeTotal,
      liquidity: s.volumeTotal,
      holders: walletCount,
      activityScore,
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
