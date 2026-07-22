import type { StrategyConfig } from '../types/strategy.ts';

export const DEFAULTS: StrategyConfig = {
  minScore: 45,
  minLiquidity: 500,
  maxLiquidity: 2000,
  minSignalAgeMs: 15_000,
  maxSignalAgeMs: 30_000,
  minWalletCount: 20,
  maxDeadHoldMs: 240_000,
  maxWallets: 2000,
  minActivityScore: 0,
  maxHolders: 100_000,
  minSmartWallets: 0,
  stopLossPercent: -0.30,
  takeProfitPercent: 0.50,
  trailingStopActivatePercent: 0.25,
  trailingStopDistance: 0.12,
  breakEvenActivatePercent: 0.10,
  positionTtlMs: 24 * 60 * 60 * 1000,
  executionDelayMs: 800,
  slippagePercent: 0.5,
};

export function createConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return { ...DEFAULTS, ...overrides };
}
