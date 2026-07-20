import { ENV } from '../config/env.ts';
import type { ReplayHour } from '../types/replay.ts';

export function buildReplayUrl(hour: ReplayHour): string {
  const y = String(hour.year);
  const m = String(hour.month).padStart(2, '0');
  const d = String(hour.day).padStart(2, '0');
  const h = String(hour.hour).padStart(2, '0');
  return `${ENV.REPLAY_BASE_URL}/${y}/${m}/${d}/${h}.jsonl.zst`;
}

export interface DownloadProgress {
  received: number;
  total: number;
  percent: number;
}

export async function fetchReplayHour(
  hour: ReplayHour,
  allowGaps = false,
  onProgress?: (p: DownloadProgress) => void,
): Promise<Uint8Array | null> {
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

  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body?.getReader();
  if (!reader) {
    return new Uint8Array(await res.arrayBuffer());
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;

    if (onProgress && total) {
      onProgress({ received, total, percent: Math.round((received / total) * 100) });
    }
  }

  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  if (onProgress && total) {
    onProgress({ received, total, percent: 100 });
  }

  return result;
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
