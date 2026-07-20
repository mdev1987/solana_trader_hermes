import { readFileSync } from 'node:fs';
import { Downloader } from './downloader.ts';
import { Parser } from './parser.ts';
import { VirtualClock } from './virtual_clock.ts';
import { getRecentHours, buildReplayCachePath } from '../api/replay_api.ts';
import { ReplayRepository } from '../storage/replay_repository.ts';
import type { ReplayEvent, ReplayHour } from '../types/replay.ts';

export type EventHandler = (event: ReplayEvent) => void | Promise<void>;

export class Player {
  private downloader: Downloader;
  private parser: Parser;
  private clock: VirtualClock;
  private handlers: EventHandler[] = [];
  private replayRepo: ReplayRepository;

  constructor(startTime?: number) {
    this.downloader = new Downloader(true);
    this.parser = new Parser();
    this.clock = new VirtualClock(startTime ?? Date.now());
    this.replayRepo = new ReplayRepository();
  }

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  get clockTime(): number {
    return this.clock.time;
  }

  set noCache(v: boolean) {
    this.downloader.noCache = v;
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
      if (this.replayRepo.isProcessed(hour)) {
        const cachePath = buildReplayCachePath(hour);
        console.log(`${prefix}Cached ${cachePath} (already processed)`);
        continue;
      }

      const cachePath = buildReplayCachePath(hour);
      process.stdout.write(`${prefix}${cachePath}`);

      this.downloader.onProgress = (p) => {
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
        const bar = '█'.repeat(Math.floor(p.percent / 5)) + '░'.repeat(20 - Math.floor(p.percent / 5));
        const mb = (p.received / 1_048_576).toFixed(1);
        const totalMb = (p.total / 1_048_576).toFixed(1);
        process.stdout.write(`${prefix}${bar} ${p.percent}% (${mb}MB / ${totalMb}MB)`);
      };

      const result = await this.downloader.download(hour);
      process.stdout.write('\n');
      if (!result) continue;

      const { data } = result;

      const totalLines = await this.parser.countLines(data);

      const hourCount = await this.parser.parseStream(data, async (event) => {
        this.clock.setTime(event.timestamp);
        await this.emit(event);
      }, totalLines, (parsed, total) => {
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
        const pct = total > 0 ? ((parsed / total) * 100).toFixed(1) : '0.0';
        process.stdout.write(`${prefix}${parsed}/${total} (${pct}%)`);
      });
      process.stdout.write('\n');

      count += hourCount;
      this.replayRepo.markProcessed(hour, hourCount);
    }

    return count;
  }

  async replayRecent(hoursCount: number): Promise<number> {
    const hours = getRecentHours(hoursCount);
    return this.replayHours(hours, `${hoursCount}h`);
  }

  async replayFile(filePath: string): Promise<number> {
    const prefix = '[file] ';
    console.log(`${prefix}${filePath}`);
    const data = readFileSync(filePath);

    const totalLines = await this.parser.countLines(data);

    const count = await this.parser.parseStream(data, async (event) => {
      this.clock.setTime(event.timestamp);
      await this.emit(event);
    }, totalLines, (parsed, total) => {
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      const pct = total > 0 ? ((parsed / total) * 100).toFixed(1) : '0.0';
      process.stdout.write(`${prefix}${parsed}/${total} (${pct}%)`);
    });
    process.stdout.write('\n');

    return count;
  }
}
