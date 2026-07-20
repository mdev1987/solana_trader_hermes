import { spawnSync } from 'bun';
import type { ReplayEvent } from '../types/replay.ts';

export class Parser {
  decompress(compressed: Uint8Array): string {
    const proc = spawnSync(['zstd', '-d'], {
      stdin: compressed,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (proc.exitCode !== 0) {
      const stderr = (proc.stderr || '').toString();
      throw new Error(`zstd decompression failed (exit ${proc.exitCode}): ${stderr}`);
    }

    return Buffer.from(proc.stdout).toString();
  }

  parseLines(text: string): ReplayEvent[] {
    const events: ReplayEvent[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as ReplayEvent;
        events.push(event);
      } catch {
        console.warn('[parser] skipping invalid JSON line');
      }
    }
    return events;
  }

  parse(compressed: Uint8Array): ReplayEvent[] {
    const text = this.decompress(compressed);
    return this.parseLines(text);
  }
}
