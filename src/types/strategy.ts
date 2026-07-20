export type Decision = 'BUY' | 'SKIP';

export interface StrategyConfig {
  minScore: number;
  minLiquidity: number;
  minActivityScore: number;
  maxHolders: number;
  minSmartWallets: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopActivatePercent: number;
  trailingStopDistance: number;
  positionTtlMs: number;
}

export interface ScoredToken {
  mint: string;
  score: number;
  reason: string;
}
