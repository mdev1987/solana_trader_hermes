import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchReplayHour, buildReplayCachePath, type DownloadProgress } from '../api/replay_api.ts';
import type { ReplayHour } from '../types/replay.ts';

export class Downloader {
  private allowGaps: boolean;
  noCache = false;
  onProgress?: (p: DownloadProgress) => void;

  constructor(allowGaps = false) {
    this.allowGaps = allowGaps;
  }

  async download(hour: ReplayHour): Promise<{ data: Uint8Array; fromCache: boolean } | null> {
    const cachePath = buildReplayCachePath(hour);

    if (!this.noCache && existsSync(cachePath)) {
      const data = readFileSync(cachePath);
      return { data, fromCache: true };
    }

    const data = await fetchReplayHour(hour, this.allowGaps, this.onProgress);
    if (!data) return null;

    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, data);

    return { data, fromCache: false };
  }
}
