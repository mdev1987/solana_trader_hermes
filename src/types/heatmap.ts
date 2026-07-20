export interface HeatmapResponse {
  code: number;
  description: string;
  data: HeatmapData;
}

export interface HeatmapData {
  meta: { signals: Record<string, SignalInfo> };
  heatmap: HeatmapEntry[];
}

export interface SignalInfo {
  signal_count: number;
  first_time: number;
  first_price: number;
  max_price: number;
  max_price_gain: number;
  signal_tags: string[];
  token_level: string;
}

export interface HeatmapEntry {
  time: number;
  wallet_count: number;
  trade_volume: number;
  tokens: string[];
}
