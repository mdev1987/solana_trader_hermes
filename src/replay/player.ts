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

  async replayHours(hours: ReplayHour[]): Promise<number> {
    let count = 0;
    for (const hour of hours) {
      const compressed = await this.downloader.download(hour);
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
    return this.replayHours(hours);
  }
}
