import { Bot } from 'grammy';
import { registerCommands } from './commands.ts';
import { ENV } from '../config/env.ts';

export async function startBot(): Promise<void> {
  if (!ENV.TELEGRAM_BOT_TOKEN) {
    console.error('[bot] TELEGRAM_BOT_TOKEN not set in .env');
    process.exit(1);
  }

  const bot = new Bot(ENV.TELEGRAM_BOT_TOKEN);

  if (ENV.TELEGRAM_CHAT_ID) {
    bot.use((ctx, next) => {
      if (ctx.chat?.id !== ENV.TELEGRAM_CHAT_ID) {
        console.warn(`[bot] rejected chat ${ctx.chat?.id} (allowed: ${ENV.TELEGRAM_CHAT_ID})`);
        return;
      }
      return next();
    });
  }

  registerCommands(bot);

  bot.catch((err) => {
    console.error('[bot] error:', err);
  });

  bot.start();
  console.log('[bot] Telegram bot started');
}
