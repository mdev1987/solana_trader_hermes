import type { TradeMetrics, OutlierReport } from './metrics.ts';

function printOne(metrics: TradeMetrics, indent = ''): void {
  console.log(`${indent}  Trades: ${metrics.totalTrades}  Win: ${(metrics.winRate * 100).toFixed(1)}%  PnL: $${metrics.totalPnl.toFixed(2)}  PF: ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(1)}  Sharpe: ${metrics.sharpe.toFixed(2)}  DD: $${metrics.maxDrawdown.toFixed(2)}`);
  console.log(`${indent}  AvgGain: $${metrics.averageGain.toFixed(2)}  AvgLoss: $${metrics.averageLoss.toFixed(4)}  Hold: ${(metrics.averageHoldingTimeMs / 60000).toFixed(1)}m`);
  console.log(`${indent}  Best: ${metrics.bestTrade ? `${metrics.bestTrade.mint.slice(0, 8)}… (${(metrics.bestTrade.pnlPercent * 100).toFixed(1)}%)` : '-'}`);
}

export function printReport(metrics: TradeMetrics): void {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('          TRADING PERFORMANCE          ');
  console.log('═══════════════════════════════════════');
  printOne(metrics, '');
  console.log('═══════════════════════════════════════');
}

export function printOutlierReports(reports: OutlierReport[]): void {
  if (reports.length === 0) return;
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('          OUTLIER ANALYSIS             ');
  console.log('═══════════════════════════════════════');
  for (const r of reports) {
    const label = r.removed > 0 ? `${r.label} (-${r.removed})` : r.label;
    console.log(`  ${label}:`);
    printOne(r.metrics, '  ');
  }
  console.log('═══════════════════════════════════════');
}
