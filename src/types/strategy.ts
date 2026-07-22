export type Decision = 'BUY' | 'SKIP';

export interface StrategyConfig {
  minScore: number;
  minLiquidity: number;
  maxLiquidity: number;
  minSignalAgeMs: number;
  maxSignalAgeMs: number;
  minWalletCount: number;
  maxDeadHoldMs: number;
  maxWallets: number;
  minActivityScore: number;
  maxHolders: number;
  minSmartWallets: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopActivatePercent: number;
  trailingStopDistance: number;
  breakEvenActivatePercent: number;
  positionTtlMs: number;
  executionDelayMs: number;
  slippagePercent: number;
}

export interface ScoredToken {
  mint: string;
  score: number;
  reason: string;
}
