import type { FeatureSnapshot } from '../types/feature.ts';
import { getDb } from './database.ts';

export class FeatureRepository {
  save(snapshot: FeatureSnapshot): void {
    const db = getDb();
    db.run(
      `INSERT OR REPLACE INTO features (mint, timestamp, rank_score, signal_count, wallet_count, trade_volume, liquidity, holders, activity_score, smart_wallets, buy_ratio, time_since_launch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.mint,
        snapshot.timestamp,
        snapshot.rankScore,
        snapshot.signalCount,
        snapshot.walletCount,
        snapshot.tradeVolume,
        snapshot.liquidity,
        snapshot.holders,
        snapshot.activityScore,
        snapshot.smartWallets,
        snapshot.buyRatio,
        snapshot.timeSinceLaunchMs,
      ],
    );
  }

  saveBatch(snapshots: FeatureSnapshot[]): void {
    const db = getDb();
    const tx = db.transaction(() => {
      for (const s of snapshots) {
        this.save(s);
      }
    });
    tx();
  }

  getByMint(mint: string): FeatureSnapshot[] {
    const db = getDb();
    const rows = db.query(
      'SELECT * FROM features WHERE mint = ? ORDER BY timestamp ASC',
    ).all(mint) as Array<Record<string, unknown>>;

    return rows.map(this.mapRow);
  }

  getAll(): FeatureSnapshot[] {
    const db = getDb();
    const rows = db.query('SELECT * FROM features ORDER BY timestamp DESC').all() as Array<Record<string, unknown>>;
    return rows.map(this.mapRow);
  }

  getCount(): number {
    const db = getDb();
    const row = db.query('SELECT COUNT(*) as count FROM features').get() as { count: number };
    return row.count;
  }

  private mapRow(row: Record<string, unknown>): FeatureSnapshot {
    return {
      mint: row.mint as string,
      timestamp: row.timestamp as number,
      rankScore: row.rank_score as number,
      signalCount: row.signal_count as number,
      walletCount: row.wallet_count as number,
      tradeVolume: row.trade_volume as number,
      liquidity: row.liquidity as number,
      holders: row.holders as number,
      activityScore: row.activity_score as number,
      smartWallets: row.smart_wallets as number,
      buyRatio: (row.buy_ratio as number) ?? 0,
      timeSinceLaunchMs: (row.time_since_launch as number) ?? 0,
    };
  }
}
