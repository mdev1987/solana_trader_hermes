import { ENV } from '../config/env.ts';
import type { TokenRank } from '../types/rank.ts';

interface RankResponse {
  code: number;
  description: string;
  data: TokenRank[];
}

export async function fetchRankings(limit = 10, duration = '5m'): Promise<TokenRank[]> {
  const url = `${ENV.RANK_API_URL}?chain=solana&limit=${limit}&duration=${duration}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Rank API returned ${res.status}: ${res.statusText}`);
  }

  const body = await res.json() as RankResponse;

  if (body.code !== 0) {
    throw new Error(`Rank API error: ${body.description}`);
  }

  return body.data;
}
