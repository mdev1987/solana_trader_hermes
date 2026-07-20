import { ENV } from '../config/env.ts';
import type { ReplayHour } from '../types/replay.ts';

export function buildReplayUrl(hour: ReplayHour): string {
  const y = String(hour.year);
  const m = String(hour.month).padStart(2, '0');
  const d = String(hour.day).padStart(2, '0');
  const h = String(hour.hour).padStart(2, '0');
  return `${ENV.REPLAY_BASE_URL}/${y}/${m}/${d}/${h}.jsonl.zst`;
}

export async function fetchReplayHour(hour: ReplayHour, allowGaps = false): Promise<Uint8Array | null> {
  const url = buildReplayUrl(hour);
  const res = await fetch(url);

  if (res.status === 404) {
    if (!allowGaps) {
      throw new Error(`Missing replay hour: ${url}`);
    }
    return null;
  }

  if (!res.ok) {
    throw new Error(`Replay API returned ${res.status}: ${url}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}

export function getRecentHours(count: number): ReplayHour[] {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);

  const hours: ReplayHour[] = [];
  for (let i = count; i > 0; i--) {
    const d = new Date(now.getTime() - i * 3600_000);
    hours.push({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
    });
  }
  return hours;
}
