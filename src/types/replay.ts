export interface ReplayEvent {
  type: 'create' | 'trade' | 'complete';
  mint: string;
  timestamp: number;
  localTimestamp?: number;
  price: number;
  marketCap: number;
  volume: number;
  wallet?: string;
  symbol?: string;
  name?: string;
  uri?: string;
}

export interface ReplayHour {
  year: number;
  month: number;
  day: number;
  hour: number;
}
