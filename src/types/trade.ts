export interface TradeResult {
  id: string;
  mint: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPercent: number;
  exitReason: 'tp' | 'sl' | 'trailing' | 'ttl' | 'manual';
  fees: number;
}

export interface OpenPosition {
  id: string;
  mint: string;
  entryPrice: number;
  quantity: number;
  entryTime: number;
  highestPrice: number;
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
