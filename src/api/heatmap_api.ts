import { ENV } from '../config/env.ts';
import type { HeatmapResponse } from '../types/heatmap.ts';

export async function fetchHeatmap(): Promise<HeatmapResponse> {
  const url = `${ENV.HEATMAP_API_URL}?chain=solana`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Heatmap API returned ${res.status}: ${res.statusText}`);
  }

  const body = await res.json() as HeatmapResponse;

  if (body.code !== 0) {
    throw new Error(`Heatmap API error: ${body.description}`);
  }

  return body;
}
