import type { FeatureSnapshot } from '../types/feature.ts';
import type { TokenRank } from '../types/rank.ts';

export class TokenFeatureExtractor {
  extract(rank: TokenRank): FeatureSnapshot {
    return {
      mint: rank.address,
      timestamp: rank.market_info.last_update_time,
      rankScore: rank.activity_score * 100,
      signalCount: rank.market_info.swaps,
      walletCount: rank.market_info.uniq_wallet_swaps,
      tradeVolume: rank.market_info.volume,
      liquidity: rank.pair_summary_info.liquidity,
      holders: rank.market_info.holders,
      activityScore: rank.activity_score,
      smartWallets: rank.smart_wallet_total_count,
      buyRatio: 0,
      timeSinceLaunchMs: 0,
    };
  }
}
