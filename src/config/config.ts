import type { StrategyConfig } from '../types/strategy.ts';

export const DEFAULTS: StrategyConfig = {
  minScore: 50,
  minLiquidity: 0.1,
  minActivityScore: 0,
  maxHolders: 100_000,
  minSmartWallets: 0,
  stopLossPercent: -0.30,
  takeProfitPercent: 0.50,
  trailingStopActivatePercent: 0.25,
  trailingStopDistance: 0.12,
  positionTtlMs: 24 * 60 * 60 * 1000,
  executionDelayMs: 800,
  slippagePercent: 0.5,
};

export function createConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return { ...DEFAULTS, ...overrides };
}
