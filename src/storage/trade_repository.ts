import type { TradeResult } from '../types/trade.ts';
import { getDb } from './database.ts';

export class TradeRepository {
  save(trade: TradeResult): void {
    const db = getDb();
    db.run(
      `INSERT OR REPLACE INTO trades (id, mint, entry_price, exit_price, quantity, entry_time, exit_time, pnl, pnl_percent, exit_reason, fees)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trade.id,
        trade.mint,
        trade.entryPrice,
        trade.exitPrice,
        trade.quantity,
        trade.entryTime,
        trade.exitTime,
        trade.pnl,
        trade.pnlPercent,
        trade.exitReason,
        trade.fees,
      ],
    );
  }

  saveBatch(trades: TradeResult[]): void {
    const db = getDb();
    const tx = db.transaction(() => {
      for (const t of trades) {
        this.save(t);
      }
    });
    tx();
  }

  getAll(): TradeResult[] {
    const db = getDb();
    const rows = db.query('SELECT * FROM trades ORDER BY exit_time DESC').all() as Array<Record<string, unknown>>;
    return rows.map(this.mapRow);
  }

  getByMint(mint: string): TradeResult[] {
    const db = getDb();
    const rows = db.query(
      'SELECT * FROM trades WHERE mint = ? ORDER BY exit_time DESC',
    ).all(mint) as Array<Record<string, unknown>>;
    return rows.map(this.mapRow);
  }

  getCount(): number {
    const db = getDb();
    const row = db.query('SELECT COUNT(*) as count FROM trades').get() as { count: number };
    return row.count;
  }

  getTotalPnl(): number {
    const db = getDb();
    const row = db.query('SELECT COALESCE(SUM(pnl), 0) as total FROM trades').get() as { total: number };
    return row.total;
  }

  private mapRow(row: Record<string, unknown>): TradeResult {
    return {
      id: row.id as string,
      mint: row.mint as string,
      entryPrice: row.entry_price as number,
      exitPrice: row.exit_price as number,
      quantity: row.quantity as number,
      entryTime: row.entry_time as number,
      exitTime: row.exit_time as number,
      pnl: row.pnl as number,
      pnlPercent: row.pnl_percent as number,
      exitReason: row.exit_reason as TradeResult['exitReason'],
      fees: row.fees as number,
    };
  }
}
