import type { ReplayEvent } from '../types/replay.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let zstd: any = null;

async function getZstd() {
  if (!zstd) {
    const { ZstdInit } = await import('@oneidentity/zstd-js');
    zstd = await ZstdInit();
  }
  return zstd;
}

export class Parser {
  async decompress(compressed: Uint8Array): Promise<string> {
    const { ZstdSimple } = await getZstd();
    const decompressed = ZstdSimple.decompress(compressed);
    const decoder = new TextDecoder();
    return decoder.decode(decompressed);
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

  async parse(compressed: Uint8Array): Promise<ReplayEvent[]> {
    const text = await this.decompress(compressed);
    return this.parseLines(text);
  }
}
