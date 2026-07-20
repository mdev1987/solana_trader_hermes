import { spawnSync } from 'bun';
import type { ReplayEvent } from '../types/replay.ts';

const NEWLINE = 0x0A;

export type ParseProgress = (parsed: number, total: number) => void;

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

  parseLines(buf: Buffer, onProgress?: ParseProgress): ReplayEvent[] {
    const events: ReplayEvent[] = [];
    let start = 0;
    const total = buf.length;
    let nextReport = 0;

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

      if (onProgress && start >= nextReport) {
        nextReport = start + Math.floor(total / 100);
        onProgress(start, total);
      }
    }

    if (onProgress) onProgress(total, total);
    return events;
  }

  parse(compressed: Uint8Array, onProgress?: ParseProgress): ReplayEvent[] {
    const buf = this.decompress(compressed);
    return this.parseLines(buf, onProgress);
  }
}
