import { decompress } from 'simple-zstd';
import type { ReplayEvent } from '../types/replay.ts';

function readChunks(stream: NodeJS.ReadableStream): ReadableStream<Buffer> {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer) => controller.enqueue(chunk));
      stream.on('end', () => controller.close());
      stream.on('error', (err) => controller.error(err));
    },
  });
}

export class Parser {
  async countLines(compressed: Uint8Array): Promise<number> {
    const d = await decompress();
    const reader = readChunks(d).getReader();
    d.write(Buffer.from(compressed));
    d.end();

    let lines = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) {
        if (byte === 0x0a) lines++;
      }
    }
    return lines;
  }

  async parseStream(
    compressed: Uint8Array,
    onEvent: (event: ReplayEvent) => void,
    totalLines?: number,
    onProgress?: (parsed: number, total: number, percent: number) => void,
  ): Promise<number> {
    const d = await decompress();
    const reader = readChunks(d).getReader();
    d.write(Buffer.from(compressed));
    d.end();

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
        onProgress(count, totalLines ?? count, 0);
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

    onProgress?.(count, totalLines ?? count, 100);
    return count;
  }
}
