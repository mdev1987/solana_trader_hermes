export type Decision = 'BUY' | 'SKIP';

export interface StrategyConfig {
  minScore: number;
  minLiquidity: number;
  maxLiquidity: number;
  maxSignalAgeMs: number;
  maxWallets: number;
  minActivityScore: number;
  maxHolders: number;
  minSmartWallets: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopActivatePercent: number;
  trailingStopDistance: number;
  positionTtlMs: number;
  executionDelayMs: number;
  slippagePercent: number;
}

export interface ScoredToken {
  mint: string;
  score: number;
  reason: string;
}
