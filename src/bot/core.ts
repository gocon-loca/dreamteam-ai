/**
 * Core bot helpers shared across command modules
 */

import { Context, Telegraf } from 'telegraf';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  getUnreadOutbox,
  markOutboxRead,
} from '../comms/message-queue.js';

// 10 minute timeout for Director responses (Opus can take time for complex reasoning)
export const DIRECTOR_TIMEOUT_MS = 10 * 60 * 1000;

const OUTBOX_POLL_INTERVAL = 5000; // 5 seconds

/**
 * Check supervisor status by looking for its process and control file.
 */
export function getSupervisorStatus(): { running: boolean; paused: boolean; pid: number | null } {
  let running = false;
  let pid: number | null = null;
  try {
    const { execSync } = require('child_process');
    const ps = execSync('pgrep -f "supervisor.js" 2>/dev/null || true', { encoding: 'utf8' });
    if (ps.trim()) {
      running = true;
      pid = parseInt(ps.trim().split('\n')[0]);
    }
  } catch { /* ignore */ }

  let paused = false;
  const controlFile = resolve(process.cwd(), 'data/supervisor-control.json');
  try {
    if (existsSync(controlFile)) {
      const ctrl = JSON.parse(readFileSync(controlFile, 'utf8'));
      paused = ctrl.paused === true;
    }
  } catch { /* ignore */ }

  return { running, paused, pid };
}

/**
 * Send a long message by splitting into 4000-char chunks.
 */
export async function sendLongMessage(ctx: Context, text: string) {
  const MAX_LENGTH = 4000;
  if (text.length <= MAX_LENGTH) {
    await ctx.reply(text);
    return;
  }

  // Split into chunks
  const chunks = text.match(/[\s\S]{1,4000}/g) || [];
  for (const chunk of chunks) {
    await ctx.reply(chunk);
    // Small delay between chunks
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * Poll the outbox for orchestrator responses and send to user.
 */
export async function checkOutboxAndRespond(bot: Telegraf<Context>, chatId: number) {
  const unread = getUnreadOutbox();
  if (unread.length > 0) {
    for (const msg of unread) {
      try {
        // Split long messages
        const content = msg.content;
        if (content.length > 4000) {
          const chunks = content.match(/[\s\S]{1,4000}/g) || [];
          for (const chunk of chunks) {
            await bot.telegram.sendMessage(chatId, chunk);
          }
        } else {
          await bot.telegram.sendMessage(chatId, `\u{1F916} ${content}`);
        }
      } catch (error) {
        console.error('Error sending outbox message:', error);
      }
    }
    markOutboxRead(unread.map(m => m.id));
  }
}

/**
 * Start periodic polling of the outbox.
 */
export function startOutboxPolling(bot: Telegraf<Context>, chatId: number): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      if (chatId) {
        await checkOutboxAndRespond(bot, chatId);
      }
    } catch (err) {
      console.error('[Bot] Outbox poll error:', err);
    }
  }, OUTBOX_POLL_INTERVAL);
}
