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

export function analyzeDb(csv = false): void {
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

  // ── Feature Importance (Correlation with PnL) ──
  console.log('\n─── Feature Importance (correlation with PnL) ───');
  const importanceFeatures = ['entryScore', 'activity', 'buyRatio', 'wallets', 'liquidity', 'entryDelayMs', 'signalAgeMs'];
  const getImportanceVal = (key: string, t: TradeResult): number => {
    const f = parseFeatures(t);
    if (key in f) return Number(f[key]) || 0;
    if (key === 'entryDelayMs') return t.entryDelayMs;
    if (key === 'signalAgeMs') return t.signalAgeMs;
    if (key === 'entryScore') return t.entryScore;
    return 0;
  };

  interface FeatImp { name: string; r: number; d: number; stars: string; }
  const impRows: FeatImp[] = [];
  for (const key of importanceFeatures) {
    const vals = trades.map(t => getImportanceVal(key, t));
    const outcomes = trades.map(t => t.pnl > 0 ? 1 : 0);
    const n = vals.length;

    const meanV = vals.reduce((s: number, v: number) => s + v, 0) / n;
    const meanO = outcomes.reduce((s: number, v: number) => s + v, 0) / n;
    let cov = 0, varV = 0, varO = 0;
    for (let i = 0; i < n; i++) {
      const dv = (vals[i] ?? 0) - meanV;
      const do_ = (outcomes[i] ?? 0) - meanO;
      cov += dv * do_;
      varV += dv * dv;
      varO += do_ * do_;
    }
    const r = varV > 0 && varO > 0 ? cov / Math.sqrt(varV * varO) : 0;

    const winVals = trades.filter(t => t.pnl > 0).map(t => getImportanceVal(key, t)) as number[];
    const loseVals = trades.filter(t => t.pnl <= 0).map(t => getImportanceVal(key, t)) as number[];
    let d = 0;
    if (winVals.length > 0 && loseVals.length > 0) {
      const wMean = winVals.reduce((s: number, v: number) => s + v, 0) / winVals.length;
      const lMean = loseVals.reduce((s: number, v: number) => s + v, 0) / loseVals.length;
      const wVar = winVals.reduce((s: number, v: number) => s + (v - wMean) ** 2, 0) / winVals.length;
      const lVar = loseVals.reduce((s: number, v: number) => s + (v - lMean) ** 2, 0) / loseVals.length;
      const pooled = Math.sqrt((wVar + lVar) / 2);
      d = pooled > 0 ? (wMean - lMean) / pooled : 0;
    }

    const absR = Math.abs(r);
    const stars = absR > 0.5 ? '⭐⭐⭐⭐⭐' : absR > 0.4 ? '⭐⭐⭐⭐' : absR > 0.3 ? '⭐⭐⭐' : absR > 0.2 ? '⭐⭐' : absR > 0.1 ? '⭐' : '—';
    impRows.push({ name: key, r, d, stars });
  }

  impRows.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  console.log(`  ${'Feature'.padEnd(16)} ${'r (corr)'.padStart(10)} ${"Cohen's d".padStart(10)} ${'Power'.padStart(8)}`);
  for (const row of impRows) {
    console.log(`  ${row.name.padEnd(16)} ${row.r.toFixed(4).padStart(10)} ${row.d.toFixed(4).padStart(10)} ${row.stars.padStart(8)}`);
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

  // ── Score Component Breakdown ──
  console.log('\n─── Score Component Breakdown ───');
  interface Components { activityScore: number; buyRatio: number; timeDecay: number; liquidity: number; walletCount: number; total: number; entryScore: number; }
  const computeComponents = (t: TradeResult): Components => {
    const f = parseFeatures(t);
    const activityScore = Number(f.activity) || 0;
    const buyRatio = Number(f.buyRatio) || 0;
    const walletCount = Number(f.wallets) || 0;
    const liquidity = Number(f.liquidity) || 0;
    const timeMs = t.signalAgeMs;

    const norm = (v: number, min: number, max: number) => max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;
    const normBuy = (r: number) => r < 0.3 ? 0 : Math.min(1, (r - 0.3) / 0.7);
    const decayTime = (ms: number) => ms < 0 ? 0 : Math.exp(-ms / 60_000);

    const raw = {
      activityScore: norm(activityScore, 0, 1),
      buyRatio: normBuy(buyRatio),
      timeDecay: decayTime(timeMs),
      liquidity: norm(Math.log10(liquidity + 1), 0, 6),
      walletCount: norm(walletCount, 0, 1000),
    };
    const weights = { activityScore: 0.20, buyRatio: 0.25, timeDecay: 0.25, liquidity: 0.15, walletCount: 0.15 };
    const weighted: Components = { ...raw, total: 0, entryScore: t.entryScore };
    weighted.total = 0;
    for (const k of Object.keys(raw) as (keyof typeof raw)[]) {
      const v = weighted[k];
      weighted[k] = v * weights[k] * 100;
      weighted.total += weighted[k];
    }
    return weighted;
  };

  const compKeys: (keyof Components)[] = ['activityScore', 'buyRatio', 'timeDecay', 'liquidity', 'walletCount'];
  if (winners.length > 0 && losers.length > 0) {
    const compRows: { name: string; winAvg: number; loseAvg: number; dir: string }[] = [];
    const wComps = winners.map(computeComponents);
    const lComps = losers.map(computeComponents);
    for (const key of compKeys) {
      const wAvg = wComps.reduce((s, c) => s + c[key], 0) / wComps.length;
      const lAvg = lComps.reduce((s, c) => s + c[key], 0) / lComps.length;
      const delta = wAvg - lAvg;
      let dir = '—';
      if (Math.abs(delta) > 0.01) dir = delta > 0 ? 'Higher → Better' : 'Lower → Better';
      compRows.push({ name: key, winAvg: wAvg, loseAvg: lAvg, dir });
    }
    const wTotal = wComps.reduce((s, c) => s + c.total, 0) / wComps.length;
    const lTotal = lComps.reduce((s, c) => s + c.total, 0) / lComps.length;
    console.log(`  ${'Component'.padEnd(16)} ${'Winner Avg'.padStart(10)} ${'Loser Avg'.padStart(10)} ${'Δ'.padStart(10)} Direction`);
    for (const r of compRows) {
      console.log(`  ${r.name.padEnd(16)} ${r.winAvg.toFixed(2).padStart(10)} ${r.loseAvg.toFixed(2).padStart(10)} ${(r.winAvg - r.loseAvg).toFixed(2).padStart(10)} ${r.dir}`);
    }
    console.log(`  ${'Total (weighted)'.padEnd(16)} ${wTotal.toFixed(2).padStart(10)} ${lTotal.toFixed(2).padStart(10)} ${(wTotal - lTotal).toFixed(2).padStart(10)}`);
  } else {
    console.log('  (need both winners and losers)');
  }

  // ── Failure Reasons ──
  console.log('\n─── Failure Reasons ───');
  const failures: Record<string, number> = {};
  for (const t of trades) {
    if (t.pnl > 0) continue;
    const gapPct = Math.abs(t.pnlPercent) - 0.30;
    if (t.maxPrice <= t.entryPrice) {
      failures['Never profitable'] = (failures['Never profitable'] ?? 0) + 1;
    } else if (gapPct > 0.10) {
      failures['Gap through stop (>10% below SL)'] = (failures['Gap through stop (>10% below SL)'] ?? 0) + 1;
    } else if (t.exitReason === 'trailing') {
      failures['Trailing reversal'] = (failures['Trailing reversal'] ?? 0) + 1;
    } else if (t.exitReason === 'ttl') {
      failures['Max hold time'] = (failures['Max hold time'] ?? 0) + 1;
    } else {
      failures['Hit SL (normal)'] = (failures['Hit SL (normal)'] ?? 0) + 1;
    }
  }
  const nLosses = losers.length;
  for (const [reason, count] of Object.entries(failures)) {
    const pct = (count / nLosses * 100).toFixed(0);
    console.log(`  ${reason.padEnd(36)} ${count.toString().padStart(3)}/${nLosses} (${pct}%)`);
  }

  // ── Liquidity Buckets ──
  console.log('\n─── Liquidity Buckets ───');
  const liqBuckets = [
    { label: '<10',       min: 0, max: 10 },
    { label: '10-100',    min: 10, max: 100 },
    { label: '100-500',   min: 100, max: 500 },
    { label: '500+',      min: 500, max: Infinity },
  ];
  console.log(`  ${'Liquidity'.padEnd(14)} ${'N'.padStart(3)} ${'Win%'.padStart(6)} ${'PnL'.padStart(12)} ${'PF'.padStart(6)} ${'AvgMFE'.padStart(9)}`);
  for (const b of liqBuckets) {
    const subset = trades.filter(t => {
      const f = parseFeatures(t);
      const liq = Number(f.liquidity) || 0;
      return liq >= b.min && liq < b.max;
    });
    if (subset.length === 0) continue;
    const sm = calculateMetrics(subset);
    const avgMfe = subset.reduce((s, t) => {
      const mfe = t.maxPrice > 0 ? (t.maxPrice - t.entryPrice) / t.entryPrice : 0;
      return s + mfe;
    }, 0) / subset.length * 100;
    console.log(`  ${b.label.padEnd(14)} ${subset.length.toString().padStart(3)} ${(sm.winRate*100).toFixed(0).padStart(5)}% ${fmtUsd(sm.totalPnl).padStart(12)} ${sm.profitFactor === Infinity ? '    ∞' : sm.profitFactor.toFixed(1).padStart(6)} ${avgMfe.toFixed(1).padStart(8)}%`);
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

  if (csv) {
    console.log('CSV:');
    const csvHdr = ['id','mint','entryPrice','exitPrice','maxPrice','entryDelayMs','signalAgeMs','holdSec','pnl','pnlPercent','entryScore','exitReason','decisionPrice'];
    console.log(csvHdr.join(','));
    for (const t of trades) {
      const hold = ((t.exitTime - t.entryTime) / 1000).toFixed(0);
      console.log([t.id, t.mint, t.entryPrice, t.exitPrice, t.maxPrice, t.entryDelayMs, t.signalAgeMs, hold, t.pnl.toFixed(6), (t.pnlPercent*100).toFixed(2), t.entryScore, t.exitReason, t.decisionPrice].join(','));
    }
  }
}
