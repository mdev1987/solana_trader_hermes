import dotenv from '@dotenvx/dotenvx';
dotenv.config();

export const ENV = {
  REPLAY_BASE_URL: process.env.REPLAY_BASE_URL ?? 'https://replay.pumpapi.io',
  RANK_API_URL: process.env.RANK_API_URL ?? 'https://debot.ai/api/community/signal/channel/activity/rank',
  HEATMAP_API_URL: process.env.HEATMAP_API_URL ?? 'https://debot.ai/api/community/signal/channel/heatmap',
  DB_PATH: process.env.DB_PATH ?? './data/trader.db',
  PAPER_BALANCE: Number(process.env.PAPER_BALANCE ?? 1000),
  PAPER_SOL_AMOUNT: Number(process.env.PAPER_SOL_AMOUNT ?? 0.1),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? '',
  TELEGRAM_CHAT_ID: Number(process.env.TELEGRAM_CHAT_ID) || 0,
};
