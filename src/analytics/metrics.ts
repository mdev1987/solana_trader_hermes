import type { TradeResult } from '../types/trade.ts';

export interface OutlierReport {
  label: string;
  removed: number;
  metrics: TradeMetrics;
}

export interface TradeMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  totalFees: number;
  averageGain: number;
  averageLoss: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  averageHoldingTimeMs: number;
  sharpe: number;
  bestTrade: TradeResult | null;
  worstTrade: TradeResult | null;
}

export function calculateMetrics(trades: TradeResult[]): TradeMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnl: 0,
      totalFees: 0,
      averageGain: 0,
      averageLoss: 0,
      profitFactor: 0,
      expectancy: 0,
      maxDrawdown: 0,
      averageHoldingTimeMs: 0,
      sharpe: 0,
      bestTrade: null,
      worstTrade: null,
    };
  }

  const winning = trades.filter((t) => t.pnl > 0);
  const losing = trades.filter((t) => t.pnl <= 0);

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);

  const totalGains = winning.reduce((sum, t) => sum + t.pnl, 0);
  const totalLosses = Math.abs(losing.reduce((sum, t) => sum + t.pnl, 0));

  const avgGain = winning.length > 0 ? totalGains / winning.length : 0;
  const avgLoss = losing.length > 0 ? totalLosses / losing.length : 0;

  const avgHoldingTime = trades.reduce((sum, t) => sum + (t.exitTime - t.entryTime), 0) / trades.length;

  const returns = trades.map((t) => t.pnlPercent);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  let peak = 0;
  let maxDd = 0;
  let runningPnl = 0;
  for (const t of trades) {
    runningPnl += t.pnl;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDd) maxDd = dd;
  }

  const best = trades.reduce((max, t) => (t.pnl > max.pnl ? t : max), trades[0]!);
  const worst = trades.reduce((min, t) => (t.pnl < min.pnl ? t : min), trades[0]!);

  return {
    totalTrades: trades.length,
    winningTrades: winning.length,
    losingTrades: losing.length,
    winRate: trades.length > 0 ? winning.length / trades.length : 0,
    totalPnl,
    totalFees,
    averageGain: avgGain,
    averageLoss: avgLoss,
    profitFactor: totalLosses > 0 ? totalGains / totalLosses : totalGains > 0 ? Infinity : 0,
    expectancy: trades.length > 0 ? totalPnl / trades.length : 0,
    maxDrawdown: maxDd,
    averageHoldingTimeMs: avgHoldingTime,
    sharpe: stdDev > 0 ? meanReturn / stdDev * Math.sqrt(365) : 0,
    bestTrade: best,
    worstTrade: worst,
  };
}

export function outlierReports(trades: TradeResult[]): OutlierReport[] {
  if (trades.length < 3) return [];

  const sorted = [...trades].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

  const top1 = sorted.slice(1);
  const top5pct = sorted.slice(Math.max(1, Math.ceil(trades.length * 0.05)));

  return [
    { label: 'All trades', removed: 0, metrics: calculateMetrics(trades) },
    { label: 'Excl. top 1', removed: trades.length - top1.length, metrics: calculateMetrics(top1) },
    { label: 'Excl. top 5%', removed: trades.length - top5pct.length, metrics: calculateMetrics(top5pct) },
  ];
}
