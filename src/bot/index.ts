/**
 * DreamTeam Telegram Bot - Main Entry Point
 * Multi-project orchestration from your phone
 *
 * Features:
 * - Director: Conversational AI that translates ideas into goals
 * - Voice notes: Transcribed and sent to Director
 * - Commands: Quick actions for common tasks
 */

import { Telegraf, Context } from 'telegraf';
import { getSecrets } from './secrets.js';
import { createAuthMiddleware } from './auth.js';
import { updateUserPresence } from '../orchestration/user-presence.js';
import { initLinearFromSecrets, isLinearEnabled } from '../integrations/linear.js';
import {
  initDirector,
  initTranscription,
} from '../director/index.js';
import { DIRECTOR_TIMEOUT_MS, startOutboxPolling } from './core.js';
import { registerGoalCommands } from './commands-goals.js';
import { registerSystemCommands } from './commands-system.js';
import { registerReviewCommands } from './commands-review.js';
import { registerAnalyticsCommands } from './commands-analytics.js';
import { registerTestingCommands } from './commands-testing.js';
import { registerDesignCommands } from './commands-design.js';
import { registerDevCommands } from './commands-dev.js';
import { registerMessageHandlers } from './handlers-messages.js';
import { registerCallbackHandlers, registerReactionHandler } from './handlers-callbacks.js';

let bot: Telegraf<Context>;

async function main() {
  console.log('Starting DreamTeam bot...');

  const secrets = await getSecrets();
  bot = new Telegraf(secrets.telegram.botToken, {
    handlerTimeout: DIRECTOR_TIMEOUT_MS, // 10 minutes for long Director responses
  });

  // Initialize Linear integration (optional - continues if not configured)
  await initLinearFromSecrets(secrets);
  if (isLinearEnabled()) {
    console.log('Linear integration enabled - goals will sync to kanban');
  }

  // Initialize Director for conversational AI
  initDirector();
  console.log('Director initialized - ready for conversation');

  // Initialize transcription for voice notes
  if (secrets.openai?.apiKey) {
    initTranscription(secrets.openai.apiKey);
    console.log('Voice transcription enabled (Whisper)');
  } else {
    console.log('Voice transcription disabled - no OpenAI key');
  }

  // Auth middleware - only allowed users
  bot.use(createAuthMiddleware());

  // Track user presence for interactive/autonomous mode detection
  bot.use((ctx, next) => {
    updateUserPresence();
    return next();
  });

  // Register all command groups
  registerGoalCommands(bot);
  registerSystemCommands(bot);
  registerReviewCommands(bot);
  registerAnalyticsCommands(bot);
  registerTestingCommands(bot);
  registerDesignCommands(bot);
  registerDevCommands(bot);

  // Register callback and reaction handlers
  registerCallbackHandlers(bot);
  registerReactionHandler(bot);

  // Register message handlers (must be last — catches all text/voice)
  registerMessageHandlers(bot, secrets.telegram.botToken);

  // Error handling — catch Telegraf-level errors (don't crash)
  bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    try {
      ctx.reply('An error occurred. Please try again.').catch(() => {});
    } catch { /* ignore reply failure */ }
  });

  // Catch unhandled promise rejections — log but don't crash
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Bot] Unhandled rejection:', reason);
  });

  // Graceful shutdown
  process.once('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    bot.stop('SIGINT');
    process.exit(0);
  });

  process.once('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    bot.stop('SIGTERM');
    process.exit(0);
  });

  // Launch bot
  console.log('Launching bot...');
  await bot.launch({
    dropPendingUpdates: true,
    allowedUpdates: ['message', 'callback_query', 'message_reaction'],
  });
  console.log('Bot is running!');

  // Start polling for orchestrator responses
  const userChatId: number = Number(secrets.telegram.allowedUsers[0]);
  startOutboxPolling(bot, userChatId);
  console.log('Outbox polling started');
}

main().catch(console.error);
