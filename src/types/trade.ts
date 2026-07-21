export interface TradeResult {
  id: string;
  mint: string;
  entryPrice: number;
  exitPrice: number;
  maxPrice: number;
  minPrice: number;
  quantity: number;
  entryTime: number;
  exitTime: number;
  entryDelayMs: number;
  signalAgeMs: number;
  decisionPrice: number;
  entryScore: number;
  pnl: number;
  pnlPercent: number;
  exitReason: 'tp' | 'sl' | 'trailing' | 'ttl' | 'dead' | 'manual';
  fees: number;
  features?: string;
}

export interface OpenPosition {
  id: string;
  mint: string;
  entryPrice: number;
  quantity: number;
  entryTime: number;
  highestPrice: number;
  lowestPrice: number;
  entryDelayMs: number;
  signalAgeMs: number;
  decisionPrice: number;
  entryScore: number;
  stopLoss: number;
  takeProfit: number;
  trailingStopDistance: number;
  trailingStopActivated: boolean;
  ttl: number;
}

export interface PaperAccount {
  balance: number;
  positions: Map<string, OpenPosition>;
  trades: TradeResult[];
}
