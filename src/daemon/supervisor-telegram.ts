/**
 * Supervisor Telegram — initialization and message sending.
 */

import { getSecrets } from '../bot/secrets.js';
import { log } from './supervisor-utils.js';

let telegramBot: any = null;
let telegramChatId: string | null = null;

export async function initTelegram(): Promise<void> {
  try {
    const secrets = await getSecrets();
    const { Telegraf } = await import('telegraf');
    telegramBot = new Telegraf(secrets.telegram.botToken);
    telegramChatId = secrets.telegram.allowedUsers[0];
    log('Telegram initialized');
  } catch (error) {
    log(`Telegram init failed: ${error}`, 'warn');
  }
}

export async function sendTelegram(message: string): Promise<number | undefined> {
  if (!telegramBot || !telegramChatId) return undefined;
  try {
    log(`[Telegram] Sending: ${message.slice(0, 200)}${message.length > 200 ? '...' : ''}`);
    const sent = await telegramBot.telegram.sendMessage(telegramChatId, message);
    return sent.message_id;
  } catch (error) {
    log(`Telegram send failed: ${error}`, 'error');
    return undefined;
  }
}

export function getTelegramBot(): any {
  return telegramBot;
}

export function getTelegramChatId(): string | null {
  return telegramChatId;
}
