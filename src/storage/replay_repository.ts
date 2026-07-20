import type { ReplayHour } from '../types/replay.ts';
import { getDb } from './database.ts';

export interface ReplayState {
  id: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  processedAt: number;
  eventCount: number;
}

export class ReplayRepository {
  isProcessed(hour: ReplayHour): boolean {
    const db = getDb();
    const row = db.query(
      'SELECT id FROM replay_state WHERE year = ? AND month = ? AND day = ? AND hour = ?',
    ).get(hour.year, hour.month, hour.day, hour.hour);
    return row !== null;
  }

  markProcessed(hour: ReplayHour, eventCount: number): void {
    const db = getDb();
    db.run(
      'INSERT INTO replay_state (year, month, day, hour, processed_at, event_count) VALUES (?, ?, ?, ?, ?, ?)',
      [hour.year, hour.month, hour.day, hour.hour, Date.now(), eventCount],
    );
  }

  getProcessedHours(): ReplayState[] {
    const db = getDb();
    return db.query('SELECT * FROM replay_state ORDER BY year, month, day, hour').all() as ReplayState[];
  }

  getLastProcessed(): ReplayState | null {
    const db = getDb();
    const row = db.query('SELECT * FROM replay_state ORDER BY id DESC LIMIT 1').get() as ReplayState | null;
    return row ?? null;
  }
}
