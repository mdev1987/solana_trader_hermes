import { getDb } from './database.ts';
import type { FeatureSnapshot } from '../types/feature.ts';

export interface RejectedSignal {
  id?: number;
  mint: string;
  timestamp: number;
  score: number;
  activityScore: number;
  buyRatio: number;
  walletCount: number;
  liquidity: number;
  signalAgeMs: number;
  rejectReason: string;
  price: number;
}

export class RejectedSignalRepository {
  save(signal: RejectedSignal): void {
    const db = getDb();
    db.run(
      `INSERT INTO rejected_signals (mint, timestamp, score, activity_score, buy_ratio, wallet_count, liquidity, signal_age_ms, reject_reason, price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        signal.mint,
        signal.timestamp,
        signal.score,
        signal.activityScore,
        signal.buyRatio,
        signal.walletCount,
        signal.liquidity,
        signal.signalAgeMs,
        signal.rejectReason,
        signal.price,
      ],
    );
  }

  getAll(): RejectedSignal[] {
    const db = getDb();
    const rows = db.query(`
      SELECT id, mint, timestamp, score, activity_score, buy_ratio, wallet_count, liquidity, signal_age_ms, reject_reason, price
      FROM rejected_signals ORDER BY timestamp
    `).all() as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  getByReason(reason: string): RejectedSignal[] {
    const db = getDb();
    const rows = db.query(`
      SELECT id, mint, timestamp, score, activity_score, buy_ratio, wallet_count, liquidity, signal_age_ms, reject_reason, price
      FROM rejected_signals WHERE reject_reason = ? ORDER BY timestamp
    `).all(reason) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  countByReason(): { reason: string; count: number; avgScore: number }[] {
    const db = getDb();
    const rows = db.query(`
      SELECT reject_reason, COUNT(*) as cnt, AVG(score) as avg_score
      FROM rejected_signals GROUP BY reject_reason ORDER BY cnt DESC
    `).all() as Record<string, unknown>[];
    return rows.map(r => ({
      reason: r.reject_reason as string,
      count: r.cnt as number,
      avgScore: r.avg_score as number,
    }));
  }

  totalCount(): number {
    const db = getDb();
    const row = db.query('SELECT COUNT(*) as cnt FROM rejected_signals').get() as { cnt: number };
    return row.cnt;
  }

  private mapRow(r: Record<string, unknown>): RejectedSignal {
    return {
      id: r.id as number,
      mint: r.mint as string,
      timestamp: r.timestamp as number,
      score: r.score as number,
      activityScore: r.activity_score as number,
      buyRatio: r.buy_ratio as number,
      walletCount: r.wallet_count as number,
      liquidity: r.liquidity as number,
      signalAgeMs: r.signal_age_ms as number,
      rejectReason: r.reject_reason as string,
      price: r.price as number,
    };
  }
}
