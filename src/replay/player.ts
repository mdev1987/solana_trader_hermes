import { Downloader } from './downloader.ts';
import { Parser } from './parser.ts';
import { VirtualClock } from './virtual_clock.ts';
import { getRecentHours } from '../api/replay_api.ts';
import type { ReplayEvent, ReplayHour } from '../types/replay.ts';

export type EventHandler = (event: ReplayEvent) => void | Promise<void>;

export class Player {
  private downloader: Downloader;
  private parser: Parser;
  private clock: VirtualClock;
  private handlers: EventHandler[] = [];

  constructor(startTime?: number) {
    this.downloader = new Downloader(true);
    this.parser = new Parser();
    this.clock = new VirtualClock(startTime ?? Date.now());
  }

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  get clockTime(): number {
    return this.clock.time;
  }

  private async emit(event: ReplayEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }

  async replayHours(hours: ReplayHour[], label = ''): Promise<number> {
    let count = 0;
    const prefix = label ? `[${label}] ` : '';
    for (const hour of hours) {
      const url = `${String(hour.year)}/${String(hour.month).padStart(2, '0')}/${String(hour.day).padStart(2, '0')}/${String(hour.hour).padStart(2, '0')}.jsonl.zst`;
      process.stdout.write(`${prefix}Downloading ${url} ... 0%`);

      this.downloader.onProgress = (p) => {
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
        const bar = '█'.repeat(Math.floor(p.percent / 5)) + '░'.repeat(20 - Math.floor(p.percent / 5));
        const mb = (p.received / 1_048_576).toFixed(1);
        const totalMb = (p.total / 1_048_576).toFixed(1);
        process.stdout.write(`${prefix}${bar} ${p.percent}% (${mb}MB / ${totalMb}MB)`);
      };

      const compressed = await this.downloader.download(hour);
      process.stdout.write('\n');
      if (!compressed) continue;

      const events = await this.parser.parse(compressed);
      events.sort((a, b) => a.timestamp - b.timestamp);

      for (const event of events) {
        this.clock.setTime(event.timestamp);
        await this.emit(event);
        count++;
      }
    }
    return count;
  }

  async replayRecent(hoursCount: number): Promise<number> {
    const hours = getRecentHours(hoursCount);
    return this.replayHours(hours, `${hoursCount}h`);
  }
}
