import { RejectedSignalRepository } from '../storage/rejected_signal_repository.ts';
import type { FeatureSnapshot } from '../types/feature.ts';

let repo: RejectedSignalRepository | null = null;

function getRepo(): RejectedSignalRepository {
  if (!repo) repo = new RejectedSignalRepository();
  return repo;
}

export function logRejection(
  mint: string,
  timestamp: number,
  snapshot: FeatureSnapshot,
  score: number,
  rejectReason: string,
  price: number,
): void {
  getRepo().save({
    mint,
    timestamp,
    score,
    activityScore: snapshot.activityScore,
    buyRatio: snapshot.buyRatio,
    walletCount: snapshot.walletCount,
    liquidity: snapshot.liquidity,
    signalAgeMs: snapshot.timeSinceLaunchMs,
    rejectReason,
    price,
  });
}
