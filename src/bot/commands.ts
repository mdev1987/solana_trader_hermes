import type { Bot, Context } from 'grammy';
import { convert } from 'telegram-markdown-v2';
import { createConfig } from '../config/config.ts';
import { ENV } from '../config/env.ts';
import { fetchRankings } from '../api/rank_api.ts';
import { fetchHeatmap } from '../api/heatmap_api.ts';
import { TradeRepository } from '../storage/trade_repository.ts';
import { FeatureRepository } from '../storage/feature_repository.ts';
import { calculateMetrics } from '../analytics/metrics.ts';
import { Optimizer } from '../analytics/optimizer.ts';

function escapeMd(text: string): string {
  return convert(text);
}

function fmt(parts: TemplateStringsArray, ...values: unknown[]): string {
  let result = '';
  for (let i = 0; i < parts.length; i++) {
    result += parts[i]!;
    if (i < values.length) result += String(values[i] ?? '');
  }
  return result;
}

async function cmdStart(ctx: Context): Promise<void> {
  const msg = fmt`
    *Solana Trader Hermes Bot*

    Available commands:

    /start — Show this message
    /status — Bot status and trade summary
    /report — Full trade performance report
    /replay \`<hours>\` — Replay last N hours and trade
    /rank \`<limit>\` — Top ranked tokens (default 10)
    /heatmap — Current market heatmap
    /optimize — Run grid search on historical features
  `;

  await ctx.reply(escapeMd(msg), { parse_mode: 'MarkdownV2' });
}

async function cmdStatus(ctx: Context): Promise<void> {
  const tradeRepo = new TradeRepository();
  const trades = tradeRepo.getAll();
  const totalPnl = tradeRepo.getTotalPnl();

  const msg = fmt`
    *Bot Status*

    Trades: \`${trades.length}\`
    Total PnL: \`$${totalPnl.toFixed(2)}\`
    Paper Balance: \`$${ENV.PAPER_BALANCE}\`
    SOL per Trade: \`${ENV.PAPER_SOL_AMOUNT}\`
    DB: \`${ENV.DB_PATH}\`
  `;

  await ctx.reply(escapeMd(msg), { parse_mode: 'MarkdownV2' });
}

async function cmdReport(ctx: Context): Promise<void> {
  const tradeRepo = new TradeRepository();
  const trades = tradeRepo.getAll();

  if (trades.length === 0) {
    await ctx.reply('No trades yet. Run /replay first.');
    return;
  }

  const m = calculateMetrics(trades);

  const msg = fmt`
    *Trade Performance Report*

    Total Trades: \`${m.totalTrades}\`
    Win Rate: \`${(m.winRate * 100).toFixed(1)}%\`
    Total PnL: \`$${m.totalPnl.toFixed(2)}\`
    Total Fees: \`$${m.totalFees.toFixed(2)}\`
    Profit Factor: \`${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}\`
    Expectancy: \`$${m.expectancy.toFixed(4)}\`
    Max Drawdown: \`$${m.maxDrawdown.toFixed(2)}\`
    Avg Hold: \`${(m.averageHoldingTimeMs / 60000).toFixed(1)} min\`
    Sharpe: \`${m.sharpe.toFixed(2)}\`

    Avg Gain: \`$${m.averageGain.toFixed(4)}\`
    Avg Loss: \`$${m.averageLoss.toFixed(4)}\`
  `;

  await ctx.reply(escapeMd(msg), { parse_mode: 'MarkdownV2' });
}

async function cmdReplay(ctx: Context): Promise<void> {
  const text = ctx.msg?.text ?? '';
  const parts = text.split(/\s+/);
  const hoursCount = Math.min(Math.max(Number(parts[1] ?? 2), 1), 24);

  await ctx.reply(`Replaying last ${hoursCount} hours... (this may take a while)`);

  try {
    const { Player } = await import('../replay/player.ts');
    const { FeatureBuilder } = await import('../feature/builder.ts');
    const { FeatureStore } = await import('../feature/store.ts');
    const { Strategy } = await import('../strategy/strategy.ts');
    const { PaperExecutor } = await import('../execution/paper.ts');
    const { ExecutionRouter } = await import('../execution/router.ts');

    const config = createConfig();
    const player = new Player();
    const featureBuilder = new FeatureBuilder();
    const strategy = new Strategy(config);
    const executor = new PaperExecutor(config, ENV.PAPER_BALANCE, ENV.PAPER_SOL_AMOUNT);
    const router = new ExecutionRouter(executor);
    const tradeRepo = new TradeRepository();

    const recentlySold = new Map<string, number>();
    const COOLDOWN_MS = 300_000;
    const MAX_POSITIONS = 10;

    player.onEvent((event) => {
      if (!event.mint || !event.mint.endsWith('pump')) return;
      if (event.action !== 'buy' && event.action !== 'sell' && event.action !== 'create') return;
      const snapshot = featureBuilder.fromReplayEvent(event);
      if (!snapshot) return;
      const tokenAmount = event.tokenAmount ?? event.initialBuy ?? 0;
      const price = event.quoteAmount && tokenAmount ? event.quoteAmount / tokenAmount : 0;
      const { decision, score } = strategy.evaluate(snapshot);
      if (decision === 'BUY') {
        const soldAt = recentlySold.get(event.mint!);
        if (soldAt && event.timestamp - soldAt < COOLDOWN_MS) return;
        const positions = router.getPaper().getPositions();
        if (positions.has(event.mint!)) return;
        if (positions.size >= MAX_POSITIONS) return;
        router.execute(decision, snapshot, price);
      }
      const priceMap = new Map([[event.mint, price]]);
      const exited = router.updatePositions(priceMap, event.timestamp);
      for (const trade of exited) {
        recentlySold.set(trade.mint, event.timestamp);
        tradeRepo.save(trade);
      }
    });

    const count = await player.replayRecent(hoursCount);
    const trades = executor.getTrades();

    let reply = `Replay of last ${hoursCount}h complete.\nEvents: ${count}\nTrades: ${trades.length}`;
    if (trades.length > 0) {
      const m = calculateMetrics(trades);
      reply += `\nPnL: $${m.totalPnl.toFixed(2)} | Win: ${(m.winRate * 100).toFixed(1)}% | PF: ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}`;
    }

    await ctx.reply(escapeMd(reply), { parse_mode: 'MarkdownV2' });
  } catch (err) {
    await ctx.reply(`Replay failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdRank(ctx: Context): Promise<void> {
  const text = ctx.msg?.text ?? '';
  const parts = text.split(/\s+/);
  const limit = Math.min(Math.max(Number(parts[1] ?? 10), 1), 50);

  try {
    const rankings = await fetchRankings(limit);
    let msg = `*Top ${rankings.length} Tokens*\n\n`;
    for (const r of rankings) {
      msg += fmt`• *${escapeMd(r.symbol)}* — \`${(r.activity_score * 100).toFixed(1)}%\` liq=$${(r.pair_summary_info.liquidity / 1000).toFixed(0)}k wallets=${r.smart_wallet_total_count}\n`;
    }
    await ctx.reply(convert(msg), { parse_mode: 'MarkdownV2' });
  } catch (err) {
    await ctx.reply(`Rank API error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdHeatmap(ctx: Context): Promise<void> {
  try {
    const h = await fetchHeatmap();
    const entries = h.data.heatmap;
    const last = entries[entries.length - 1]!;
    const signals = Object.keys(h.data.meta.signals).length;

    const msg = fmt`
      *Market Heatmap*

      Timeframe: \`${entries.length} entries\`
      Active Signals: \`${signals}\`
      Latest: wallets=${last.wallet_count} vol=$${(last.trade_volume / 1e6).toFixed(1)}M
    `;

    await ctx.reply(escapeMd(msg), { parse_mode: 'MarkdownV2' });
  } catch (err) {
    await ctx.reply(`Heatmap API error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdOptimize(ctx: Context): Promise<void> {
  await ctx.reply('Running grid search on historical features...');

  try {
    const featureRepo = new FeatureRepository();
    const snapshots = featureRepo.getAll();
    if (snapshots.length === 0) {
      await ctx.reply('No features in database. Run /replay first.');
      return;
    }

    const base = createConfig();
    const optimizer = new Optimizer();
    const results = await optimizer.gridSearch(snapshots, base, {
      minScore: [60, 65, 70, 75, 80, 85, 90],
      minLiquidity: [500, 1000, 2000, 5000],
      minActivityScore: [0.05, 0.1, 0.2, 0.3],
      minSmartWallets: [0, 1, 2, 3],
    });

    let msg = '*Top 10 Param Combinations*\n\n';
    for (let i = 0; i < Math.min(10, results.length); i++) {
      const r = results[i]!;
      msg += fmt`${i + 1}\\. score≥${r.config.minScore} liq≥${r.config.minLiquidity} act≥${r.config.minActivityScore} wal≥${r.config.minSmartWallets} → *$${r.totalPnl.toFixed(2)}*\n`;
    }

    await ctx.reply(convert(msg), { parse_mode: 'MarkdownV2' });
  } catch (err) {
    await ctx.reply(`Optimization error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerCommands(bot: Bot): void {
  bot.command('start', cmdStart);
  bot.command('status', cmdStatus);
  bot.command('report', cmdReport);
  bot.command('replay', cmdReplay);
  bot.command('rank', cmdRank);
  bot.command('heatmap', cmdHeatmap);
  bot.command('optimize', cmdOptimize);
}
