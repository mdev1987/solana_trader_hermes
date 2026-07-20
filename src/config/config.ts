import type { StrategyConfig } from '../types/strategy.ts';

export const DEFAULTS: StrategyConfig = {
  minScore: 70,
  minLiquidity: 1000,
  minActivityScore: 0.1,
  maxHolders: 100_000,
  minSmartWallets: 1,
  stopLossPercent: -0.15,
  takeProfitPercent: 0.3,
  trailingStopActivatePercent: 0.15,
  trailingStopDistance: 0.08,
  positionTtlMs: 24 * 60 * 60 * 1000,
};

export function createConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return { ...DEFAULTS, ...overrides };
}
