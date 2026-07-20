import { Database } from 'bun:sqlite';
import { ENV } from '../config/env.ts';

let dbInstance: Database | null = null;

export function getDb(): Database {
  if (!dbInstance) {
    dbInstance = new Database(ENV.DB_PATH, { create: true });
    dbInstance.run('PRAGMA journal_mode = WAL');
    dbInstance.run('PRAGMA synchronous = NORMAL');
  }
  return dbInstance;
}

export function initDb(): void {
  const db = getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS features (
      mint TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      rank_score REAL DEFAULT 0,
      signal_count INTEGER DEFAULT 0,
      wallet_count INTEGER DEFAULT 0,
      trade_volume REAL DEFAULT 0,
      liquidity REAL DEFAULT 0,
      holders INTEGER DEFAULT 0,
      activity_score REAL DEFAULT 0,
      smart_wallets INTEGER DEFAULT 0,
      PRIMARY KEY (mint, timestamp)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      mint TEXT NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      quantity REAL NOT NULL,
      entry_time INTEGER NOT NULL,
      exit_time INTEGER NOT NULL,
      pnl REAL NOT NULL,
      pnl_percent REAL NOT NULL,
      exit_reason TEXT NOT NULL,
      fees REAL NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS replay_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      day INTEGER NOT NULL,
      hour INTEGER NOT NULL,
      processed_at INTEGER NOT NULL,
      event_count INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_features_mint ON features(mint)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_features_timestamp ON features(timestamp)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint)
  `);
}
