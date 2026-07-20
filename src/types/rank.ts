export interface TokenRank {
  address: string;
  creator_address: string;
  symbol: string;
  name: string;
  decimals: number;
  total_supply: string;
  launchpad: string;
  creation_timestamp: number;
  chain: string;
  pair: string;
  dex: { dex_name: string; dex_index: number };
  base_token: {
    asset_type: string;
    chain: string;
    symbol: string;
    decimal: number;
    name: string;
    address: string;
    reserve: string;
  };
  market_info: MarketInfo;
  pair_summary_info: { liquidity: number };
  safe_info: { solana: { is_mint_abandoned: number; is_block_address: number } };
  social_info: Record<string, unknown>;
  tags: string[];
  from_launchpad: boolean;
  smart_wallet_online_count: number;
  smart_wallet_total_count: number;
  max_price_gain: number;
  token_tier: string;
  activity_score: number;
}

export interface MarketInfo {
  price: number;
  holders: number;
  fdv: number;
  mkt_cap: number;
  percent: number;
  percent_5m: number;
  percent_1h: number;
  percent_24h: number;
  buys: number;
  sells: number;
  swaps: number;
  buy_volume: number;
  sell_volume: number;
  volume: number;
  uniq_wallet_swaps: number;
  uniq_wallet_swaps_1h: number;
  last_update_time: number;
}
