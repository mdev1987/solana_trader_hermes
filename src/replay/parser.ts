import { spawnSync } from 'bun';
import type { ReplayEvent } from '../types/replay.ts';

const NEWLINE = 0x0A;

export class Parser {
  decompress(compressed: Uint8Array): Buffer {
    const proc = spawnSync(['zstd', '-d'], {
      stdin: compressed,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (proc.exitCode !== 0) {
      const stderr = (proc.stderr || '').toString();
      throw new Error(`zstd decompression failed (exit ${proc.exitCode}): ${stderr}`);
    }

    return proc.stdout as Buffer;
  }

  parseLines(buf: Buffer): ReplayEvent[] {
    const events: ReplayEvent[] = [];
    let start = 0;

    while (start < buf.length) {
      const end = buf.indexOf(NEWLINE, start);
      if (end === -1) break;

      if (end > start) {
        const line = buf.toString('utf-8', start, end).trim();
        if (line) {
          try {
            events.push(JSON.parse(line) as ReplayEvent);
          } catch {
            console.warn('[parser] skipping invalid JSON line');
          }
        }
      }

      start = end + 1;
    }

    return events;
  }

  parse(compressed: Uint8Array): ReplayEvent[] {
    const buf = this.decompress(compressed);
    return this.parseLines(buf);
  }
}
