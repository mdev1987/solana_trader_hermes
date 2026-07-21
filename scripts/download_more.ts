import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

async function download(url: string, path: string): Promise<boolean> {
  if (existsSync(path)) {
    const data = readFileSync(path);
    try {
      const ok = await tryDecompress(data);
      if (ok) { console.log(`  OK (cached)`); return true; }
      console.log(`  Cached file corrupt, re-downloading...`);
    } catch { }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) { console.log(`  HTTP ${res.status}`); return false; }
      const data = new Uint8Array(await res.arrayBuffer());
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
      console.log(`  OK (${(data.length / 1024 / 1024).toFixed(0)}MB)`);
      return true;
    } catch (e) {
      console.log(`  Attempt ${attempt}/3 failed: ${e}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return false;
}

async function tryDecompress(data: Uint8Array): Promise<boolean> {
  const { Decompress } = await import('bun');
  const ds = new Decompress('zstd');
  ds.push(data);
  // if it doesn't throw, it's valid
  return true;
}

async function main() {
  const baseUrl = 'https://replay.pumpapi.io';
  const baseDir = '/home/mdev/Programming/Solana Main Project/solana_trader_hermes/data/replay/2026/07/20';
  mkdirSync(baseDir, { recursive: true });

  for (let h = 14; h <= 20; h++) {
    const hh = String(h).padStart(2, '0');
    const url = `${baseUrl}/2026/07/20/${hh}.jsonl.zst`;
    const path = `${baseDir}/${hh}.jsonl.zst`;
    console.log(`Downloading hour ${h}...`);
    const ok = await download(url, path);
    if (!ok) console.log(`  FAILED`);
  }
}

main();
