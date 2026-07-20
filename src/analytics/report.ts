import type { TradeMetrics } from './metrics.ts';

export function printReport(metrics: TradeMetrics): void {
  console.log('═══════════════════════════════════════');
  console.log('          TRADING PERFORMANCE');
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log(`  Total Trades:    ${metrics.totalTrades}`);
  console.log(`  Winning Trades:  ${metrics.winningTrades}`);
  console.log(`  Losing Trades:   ${metrics.losingTrades}`);
  console.log(`  Win Rate:        ${(metrics.winRate * 100).toFixed(2)}%`);
  console.log('');
  console.log(`  Total PnL:       $${metrics.totalPnl.toFixed(2)}`);
  console.log(`  Total Fees:      $${metrics.totalFees.toFixed(2)}`);
  console.log(`  Expectancy:      $${metrics.expectancy.toFixed(4)}`);
  console.log(`  Profit Factor:   ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}`);
  console.log('');
  console.log(`  Avg Gain:        $${metrics.averageGain.toFixed(4)}`);
  console.log(`  Avg Loss:        $${metrics.averageLoss.toFixed(4)}`);
  console.log(`  Max Drawdown:    $${metrics.maxDrawdown.toFixed(2)}`);
  console.log(`  Avg Hold Time:   ${(metrics.averageHoldingTimeMs / 60000).toFixed(1)} min`);
  console.log(`  Sharpe (365d):   ${metrics.sharpe.toFixed(2)}`);
  console.log('');

  if (metrics.bestTrade) {
    console.log(`  Best Trade:      ${metrics.bestTrade.mint} (${(metrics.bestTrade.pnlPercent * 100).toFixed(2)}%)`);
  }
  if (metrics.worstTrade) {
    console.log(`  Worst Trade:     ${metrics.worstTrade.mint} (${(metrics.worstTrade.pnlPercent * 100).toFixed(2)}%)`);
  }
  console.log('');
  console.log('═══════════════════════════════════════');
}
