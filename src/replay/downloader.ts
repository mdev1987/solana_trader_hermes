import { fetchReplayHour } from '../api/replay_api.ts';
import type { ReplayHour } from '../types/replay.ts';

export class Downloader {
  private allowGaps: boolean;

  constructor(allowGaps = false) {
    this.allowGaps = allowGaps;
  }

  async download(hour: ReplayHour): Promise<Uint8Array | null> {
    return fetchReplayHour(hour, this.allowGaps);
  }
}
