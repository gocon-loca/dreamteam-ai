/**
 * Authentication middleware for Telegram bot
 * Only allows messages from configured user IDs
 */

import type { Context, MiddlewareFn } from 'telegraf';
import { getSecrets } from './secrets.js';

export function createAuthMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const secrets = await getSecrets();
    const allowedUsers = secrets.telegram.allowedUsers.map(String);
    const userId = ctx.from?.id?.toString();

    if (!userId || !allowedUsers.includes(userId)) {
      console.warn(`Unauthorized access attempt from user: ${userId}`);
      await ctx.reply('⛔ Unauthorized. This bot is private.');
      return;
    }

    return next();
  };
}

export async function isAuthorized(userId: number | string): Promise<boolean> {
  const secrets = await getSecrets();
  const allowedUsers = secrets.telegram.allowedUsers.map(String);
  return allowedUsers.includes(String(userId));
}
