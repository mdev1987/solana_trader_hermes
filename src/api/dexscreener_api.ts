export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
  fdv: number;
  pairCreatedAt: number;
}

export async function fetchTokenPairs(mint: string): Promise<DexScreenerPair[]> {
  const url = `https://api.dexscreener.com/token/v1/solana/${mint}`;
  const res = await fetch(url);

  if (!res.ok) {
    return [];
  }

  return res.json() as Promise<DexScreenerPair[]>;
}
