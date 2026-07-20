import type { ReplayEvent } from '../types/replay.ts';

export class Parser {
  async parseStream(
    compressed: Uint8Array,
    onEvent: (event: ReplayEvent) => void,
    onProgress?: (parsedEvents: number) => void,
  ): Promise<number> {
    const proc = Bun.spawn(['zstd', '-d'], {
      stdin: compressed,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const reader = proc.stdout.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();

    let buffer = '';
    let count = 0;
    let nextReport = 10_000;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);

        if (line) {
          try {
            onEvent(JSON.parse(line) as ReplayEvent);
            count++;
          } catch {
            console.warn('[parser] skipping invalid JSON line');
          }
        }
      }

      if (onProgress && count >= nextReport) {
        nextReport = count + 10_000;
        onProgress(count);
      }
    }

    if (buffer.trim()) {
      try {
        onEvent(JSON.parse(buffer.trim()) as ReplayEvent);
        count++;
      } catch {
        console.warn('[parser] skipping trailing data');
      }
    }

    onProgress?.(count);
    return count;
  }
}
