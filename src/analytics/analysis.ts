import { initDb, getDb } from '../storage/database.ts';
import { TradeRepository } from '../storage/trade_repository.ts';
import { calculateMetrics } from './metrics.ts';
import type { TradeResult } from '../types/trade.ts';

function parseFeatures(t: TradeResult): Record<string, unknown> {
  try { return t.features ? JSON.parse(t.features) : {}; } catch { return {}; }
}

function fmtPx(n: number): string {
  if (n === 0) return '0';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 1e-4) return n.toExponential(3);
  return n.toExponential(2);
}

function fmtPct(n: number): string {
  const s = (n * 100).toFixed(1);
  return n >= 0 ? `+${s}%` : `${s}%`;
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtHold(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

const SEP = '  ';

export function analyzeDb(): void {
  initDb();
  const repo = new TradeRepository();
  const trades = repo.getAll();

  if (trades.length === 0) {
    console.log('\nNo trades in database. Run replay first.\n');
    return;
  }

  const metrics = calculateMetrics(trades);

  // ── Header ──
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   TRADE DATABASE ANALYSIS                   ');
  console.log('═══════════════════════════════════════════════════════════════');

  const minTime = new Date(Math.min(...trades.map(t => t.entryTime))).toISOString().slice(11, 19);
  const maxTime = new Date(Math.max(...trades.map(t => t.exitTime))).toISOString().slice(11, 19);
  console.log(`\nTrades: ${trades.length}  Time range: ${minTime} - ${maxTime}\n`);

  // ── Trade Table ──
  console.log('─── Trade Table ───');
  const hdr = '#  mint          score   entryPx     exitPx      maxPx       delay   signalAge   hold    pnlPct       exit';
  console.log(hdr);
  const sorted = [...trades].sort((a, b) => b.entryTime - a.entryTime);
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const idx = (i + 1).toString().padStart(2);
    const mint = t.mint.slice(0, 10) + '…';
    const sc = t.entryScore.toFixed(1).padStart(6);
    const ep = fmtPx(t.entryPrice).padStart(11);
    const xp = fmtPx(t.exitPrice).padStart(11);
    const mp = fmtPx(t.maxPrice).padStart(11);
    const dly = t.entryDelayMs.toString().padStart(5);
    const age = fmtMs(t.signalAgeMs).padStart(9);
    const hold = fmtHold(t.exitTime - t.entryTime).padStart(6);
    const pct = fmtPct(t.pnlPercent).padStart(10);
    console.log(`${idx}  ${mint} ${sc} ${ep} ${xp} ${mp} ${dly} ${age} ${hold} ${pct}  ${t.exitReason}`);
  }

  // ── Summary by Exit Reason ──
  console.log('\n─── Summary by Exit Reason ───');
  const byExit = new Map<string, TradeResult[]>();
  for (const t of trades) {
    const arr = byExit.get(t.exitReason) ?? [];
    arr.push(t);
    byExit.set(t.exitReason, arr);
  }
  console.log(`  ${'Exit'.padEnd(12)} ${'N'.padStart(3)} ${'Win%'.padStart(6)} ${'PnL'.padStart(12)} ${'PF'.padStart(6)} ${'AvgGain'.padStart(10)} ${'AvgLoss'.padStart(10)} ${'AvgHold'.padStart(8)}`);
  const allLabel = 'ALL';
  const am = metrics;
  console.log(`  ${allLabel.padEnd(12)} ${am.totalTrades.toString().padStart(3)} ${(am.winRate*100).toFixed(1).padStart(5)}% ${fmtUsd(am.totalPnl).padStart(12)} ${am.profitFactor === Infinity ? '    ∞' : am.profitFactor.toFixed(1).padStart(6)} ${fmtUsd(am.averageGain).padStart(10)} ${fmtUsd(am.averageLoss).padStart(10)} ${fmtHold(am.averageHoldingTimeMs).padStart(8)}`);
  for (const [reason, ts] of byExit) {
    const m = calculateMetrics(ts);
    console.log(`  ${reason.padEnd(12)} ${m.totalTrades.toString().padStart(3)} ${(m.winRate*100).toFixed(1).padStart(5)}% ${fmtUsd(m.totalPnl).padStart(12)} ${m.profitFactor === Infinity ? '    ∞' : m.profitFactor.toFixed(1).padStart(6)} ${fmtUsd(m.averageGain).padStart(10)} ${fmtUsd(m.averageLoss).padStart(10)} ${fmtHold(m.averageHoldingTimeMs).padStart(8)}`);
  }

  // ── Outlier Analysis ──
  console.log('\n─── Outlier Analysis ───');
  const sortedByAbsPnl = [...trades].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  const top1 = sortedByAbsPnl.slice(1);
  const top5pct = sortedByAbsPnl.slice(Math.max(1, Math.ceil(trades.length * 0.05)));
  function outlierLine(label: string, subset: TradeResult[]): void {
    const m = calculateMetrics(subset);
    console.log(`  ${label.padEnd(18)} N=${subset.length}  Win=${(m.winRate*100).toFixed(1)}%  PnL=${fmtUsd(m.totalPnl)}  PF=${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(1)}  Sharpe=${m.sharpe.toFixed(2)}  DD=${fmtUsd(m.maxDrawdown)}`);
  }
  outlierLine('All trades', trades);
  outlierLine(`Excl. top 1 (-${trades.length - top1.length})`, top1);
  outlierLine(`Excl. top 5% (-${trades.length - top5pct.length})`, top5pct);

  // ── Feature Correlation ──
  const numericFeatures = ['entryScore', 'activity', 'buyRatio', 'wallets', 'liquidity', 'entryDelayMs', 'signalAgeMs', 'roi'];
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);

  console.log('\n─── Feature Correlation (Winner vs Loser) ───');
  if (winners.length > 0 && losers.length > 0) {
    const rows: { name: string; winAvg: number; loseAvg: number; dir: string }[] = [];
    for (const key of numericFeatures) {
      const getVal = (t: TradeResult): number => {
        const f = parseFeatures(t);
        if (key in f) return Number(f[key]) || 0;
        const val = (() => {
          if (key === 'entryDelayMs') return t.entryDelayMs;
          if (key === 'signalAgeMs') return t.signalAgeMs;
          if (key === 'entryScore') return t.entryScore;
          return undefined;
        })();
        if (typeof val === 'number') return val;
        return 0;
      };
      const wVals = winners.map(getVal).filter(v => v !== 0 || key === 'entryScore');
      const lVals = losers.map(getVal).filter(v => v !== 0 || key === 'entryScore');
      if (wVals.length === 0 || lVals.length === 0) continue;
      const wAvg = wVals.reduce((s: number, v: number) => s + v, 0) / wVals.length;
      const lAvg = lVals.reduce((s: number, v: number) => s + v, 0) / lVals.length;
      const delta = wAvg - lAvg;
      let dir = '—';
      if (Math.abs(delta) > 0.001) dir = delta > 0 ? 'Higher → Better' : 'Lower → Better';
      rows.push({ name: key, winAvg: wAvg, loseAvg: lAvg, dir });
    }
    console.log(`  ${'Feature'.padEnd(16)} ${'Winner Avg'.padStart(12)} ${'Loser Avg'.padStart(12)} ${'Δ'.padStart(12)} Direction`);
    for (const r of rows) {
      const wa = r.winAvg.toFixed(4);
      const la = r.loseAvg.toFixed(4);
      const d = (r.winAvg - r.loseAvg).toFixed(4);
      console.log(`  ${r.name.padEnd(16)} ${wa.padStart(12)} ${la.padStart(12)} ${d.padStart(12)} ${r.dir}`);
    }
  } else {
    console.log('  (not enough data — need both winners and losers)');
  }

  // ── Execution Analysis ──
  console.log('\n─── Execution Analysis ───');
  const delays = trades.map(t => t.entryDelayMs);
  const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
  const minDelay = Math.min(...delays);
  const maxDelay = Math.max(...delays);
  const delaysUnder = delays.filter(d => d <= 1300).length;
  console.log(`  Entry delay: avg=${avgDelay.toFixed(0)}ms  range=[${minDelay}, ${maxDelay}]ms  ≤1300ms: ${delaysUnder}/${delays.length} (${(delaysUnder/delays.length*100).toFixed(0)}%)`);
  const holdTimes = trades.map(t => t.exitTime - t.entryTime);
  const avgHold = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
  const maxHold = Math.max(...holdTimes);
  const holdUnder5m = holdTimes.filter(h => h < 300000).length;
  console.log(`  Hold time: avg=${fmtHold(avgHold)}  max=${fmtHold(maxHold)}  <5m: ${holdUnder5m}/${holdTimes.length} (${(holdUnder5m/holdTimes.length*100).toFixed(0)}%)`);
  const neverRecovered = trades.filter(t => t.maxPrice <= t.entryPrice).length;
  console.log(`  Never recovered (maxPx ≤ entryPx): ${neverRecovered}/${trades.length} (${(neverRecovered/trades.length*100).toFixed(0)}%)`);
  const slippageLosses = trades.filter(t => {
    const f = parseFeatures(t);
    return f.decisionPrice && f.entryPrice && f.decisionPrice !== f.entryPrice;
  }).length;
  console.log(`  Slippage-affected trades: ${slippageLosses}/${trades.length}`);

  // ── MFE / MAE Analysis ──
  console.log('\n─── MFE / MAE Analysis ───');
  const withMfe = trades.map(t => {
    const mfe = t.maxPrice > 0 ? (t.maxPrice - t.entryPrice) / t.entryPrice : 0;
    const mae = t.exitPrice < t.entryPrice ? (t.exitPrice - t.entryPrice) / t.entryPrice : 0;
    return { ...t, mfe, mae };
  });
  const loserMfe = withMfe.filter(t => t.pnl <= 0);
  const winnerMfe = withMfe.filter(t => t.pnl > 0);
  const mfeBins = [
    { label: 'never positive', fn: (t: typeof withMfe[0]) => t.maxPrice <= t.entryPrice },
    { label: '0-10%',          fn: (t: typeof withMfe[0]) => t.mfe > 0 && t.mfe <= 0.10 },
    { label: '10-25%',         fn: (t: typeof withMfe[0]) => t.mfe > 0.10 && t.mfe <= 0.25 },
    { label: '25-50%',         fn: (t: typeof withMfe[0]) => t.mfe > 0.25 && t.mfe <= 0.50 },
    { label: '50%+',           fn: (t: typeof withMfe[0]) => t.mfe > 0.50 },
  ];
  console.log('  MFE distribution (all trades):');
  for (const bin of mfeBins) {
    const n = withMfe.filter(bin.fn).length;
    const pct = (n / withMfe.length * 100).toFixed(0);
    console.log(`    ${bin.label.padEnd(18)} ${n.toString().padStart(3)} (${pct}%)`);
  }
  if (loserMfe.length > 0) {
    console.log('  MFE of losing trades (max gain before SL):');
    const mfeBinsNarrow = [
      { label: 'never positive', fn: (t: typeof withMfe[0]) => t.maxPrice <= t.entryPrice },
      { label: '0-5%',           fn: (t: typeof withMfe[0]) => t.mfe > 0 && t.mfe <= 0.05 },
      { label: '5-15%',          fn: (t: typeof withMfe[0]) => t.mfe > 0.05 && t.mfe <= 0.15 },
      { label: '15-30%',         fn: (t: typeof withMfe[0]) => t.mfe > 0.15 && t.mfe <= 0.30 },
      { label: '30%+',           fn: (t: typeof withMfe[0]) => t.mfe > 0.30 },
    ];
    for (const bin of mfeBinsNarrow) {
      const n = loserMfe.filter(bin.fn).length;
      const pct = (n / loserMfe.length * 100).toFixed(0);
      if (n > 0) console.log(`    ${bin.label.padEnd(18)} ${n.toString().padStart(3)}/${loserMfe.length} (${pct}%)`);
    }
    const avgMfe = loserMfe.reduce((s, t) => s + t.mfe, 0) / loserMfe.length * 100;
    console.log(`    Avg MFE of losers: ${avgMfe.toFixed(1)}%`);
  }

  // ── Score Buckets ──
  console.log('\n─── Score Buckets (by entryScore) ───');
  const scoreBuckets = [
    { label: '50-55', min: 50, max: 55 },
    { label: '55-60', min: 55, max: 60 },
    { label: '60-65', min: 60, max: 65 },
    { label: '65+',   min: 65, max: Infinity },
  ];
  console.log(`  ${'Bucket'.padEnd(10)} ${'N'.padStart(3)} ${'Win%'.padStart(6)} ${'PnL'.padStart(12)} ${'PF'.padStart(6)} ${'AvgMFE'.padStart(9)}`);
  for (const b of scoreBuckets) {
    const subset = trades.filter(t => t.entryScore >= b.min && t.entryScore < b.max);
    if (subset.length === 0) continue;
    const sm = calculateMetrics(subset);
    const avgMfe = subset.reduce((s, t) => {
      const mfe = t.maxPrice > 0 ? (t.maxPrice - t.entryPrice) / t.entryPrice : 0;
      return s + mfe;
    }, 0) / subset.length * 100;
    console.log(`  ${b.label.padEnd(10)} ${subset.length.toString().padStart(3)} ${(sm.winRate*100).toFixed(0).padStart(5)}% ${fmtUsd(sm.totalPnl).padStart(12)} ${sm.profitFactor === Infinity ? '    ∞' : sm.profitFactor.toFixed(1).padStart(6)} ${avgMfe.toFixed(1).padStart(8)}%`);
  }

  // ── Entry Delay Buckets ──
  console.log('\n─── Entry Delay Buckets ───');
  const delayBuckets = [
    { label: '≤900ms',  min: 0, max: 900 },
    { label: '900-1100', min: 900, max: 1100 },
    { label: '1100-1300', min: 1100, max: 1300 },
    { label: '>1300ms', min: 1300, max: Infinity },
  ];
  console.log(`  ${'Delay'.padEnd(12)} ${'N'.padStart(3)} ${'Win%'.padStart(6)} ${'PnL'.padStart(12)} ${'PF'.padStart(6)}`);
  for (const b of delayBuckets) {
    const subset = trades.filter(t => t.entryDelayMs >= b.min && t.entryDelayMs < b.max);
    if (subset.length === 0) continue;
    const sm = calculateMetrics(subset);
    console.log(`  ${b.label.padEnd(12)} ${subset.length.toString().padStart(3)} ${(sm.winRate*100).toFixed(0).padStart(5)}% ${fmtUsd(sm.totalPnl).padStart(12)} ${sm.profitFactor === Infinity ? '    ∞' : sm.profitFactor.toFixed(1).padStart(6)}`);
  }

  // ── Time Analysis ──
  console.log('\n─── Time Analysis ───');
  const slTrades = trades.filter(t => t.exitReason === 'sl');
  const tpTrades = trades.filter(t => t.exitReason === 'tp');
  if (slTrades.length > 0) {
    const avgSlTime = slTrades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / slTrades.length;
    const minSlTime = Math.min(...slTrades.map(t => t.exitTime - t.entryTime));
    const maxSlTime = Math.max(...slTrades.map(t => t.exitTime - t.entryTime));
    console.log(`  Time to SL: avg=${fmtHold(avgSlTime)}  range=[${fmtHold(minSlTime)}, ${fmtHold(maxSlTime)}]`);
  }
  if (tpTrades.length > 0) {
    const avgTpTime = tpTrades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / tpTrades.length;
    const minTpTime = Math.min(...tpTrades.map(t => t.exitTime - t.entryTime));
    const maxTpTime = Math.max(...tpTrades.map(t => t.exitTime - t.entryTime));
    console.log(`  Time to TP: avg=${fmtHold(avgTpTime)}  range=[${fmtHold(minTpTime)}, ${fmtHold(maxTpTime)}]`);
  }
  const fastLosses = slTrades.filter(t => (t.exitTime - t.entryTime) < 60000).length;
  if (slTrades.length > 0) console.log(`  Losses <1m: ${fastLosses}/${slTrades.length} (${(fastLosses/slTrades.length*100).toFixed(0)}%)`);
  const earlyWins = tpTrades.filter(t => (t.exitTime - t.entryTime) < 120000).length;
  if (tpTrades.length > 0) console.log(`  Wins <2m: ${earlyWins}/${tpTrades.length} (${(earlyWins/tpTrades.length*100).toFixed(0)}%)`);

  // ── Equity Curve ──
  console.log('\n─── Equity Curve (by trade sequence) ───');
  const chrono = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cumPnl = 0;
  let peak = 0;
  let dd = 0;
  console.log(`  ${'#'.padStart(3)} ${'PnL'.padStart(12)} ${'Cumulative'.padStart(12)} ${'Drawdown'.padStart(10)}  Exit Reason`);
  for (let i = 0; i < chrono.length; i++) {
    const t = chrono[i]!;
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    dd = peak - cumPnl;
    console.log(`  ${(i+1).toString().padStart(3)} ${fmtUsd(t.pnl).padStart(12)} ${fmtUsd(cumPnl).padStart(12)} ${fmtUsd(dd).padStart(10)}  ${t.exitReason}`);
  }
  console.log(`\n  Final PnL: ${fmtUsd(cumPnl)}  Peak: ${fmtUsd(peak)}  Max DD: ${fmtUsd(metrics.maxDrawdown)}`);

  // ── Best / Worst Trades ──
  console.log('\n─── Best & Worst Trades ───');
  if (metrics.bestTrade) {
    const b = metrics.bestTrade;
    console.log(`  Best:  ${b.mint}  score=${b.entryScore.toFixed(1)}  PnL=${fmtUsd(b.pnl)} (${fmtPct(b.pnlPercent)})  hold=${fmtHold(b.exitTime-b.entryTime)}  exit=${b.exitReason}  entry=${fmtPx(b.entryPrice)}  exit=${fmtPx(b.exitPrice)}  max=${fmtPx(b.maxPrice)}`);
  }
  if (metrics.worstTrade) {
    const w = metrics.worstTrade;
    console.log(`  Worst: ${w.mint}  score=${w.entryScore.toFixed(1)}  PnL=${fmtUsd(w.pnl)} (${fmtPct(w.pnlPercent)})  hold=${fmtHold(w.exitTime-w.entryTime)}  exit=${w.exitReason}  entry=${fmtPx(w.entryPrice)}  exit=${fmtPx(w.exitPrice)}  max=${fmtPx(w.maxPrice)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}
