import type { StrategyConfig } from '../types/strategy.ts';

export const DEFAULTS: StrategyConfig = {
  minScore: 50,
  minLiquidity: 100,
  minActivityScore: 0.01,
  maxHolders: 100_000,
  minSmartWallets: 0,
  stopLossPercent: -0.15,
  takeProfitPercent: 0.3,
  trailingStopActivatePercent: 0.15,
  trailingStopDistance: 0.08,
  positionTtlMs: 24 * 60 * 60 * 1000,
};

export function createConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return { ...DEFAULTS, ...overrides };
}
