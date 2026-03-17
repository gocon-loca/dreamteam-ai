/**
 * Telegram Notification Channel
 *
 * Wraps the existing supervisor-telegram.ts sendTelegram() function
 * as a NotificationChannel. Formats events with emoji and Telegram-friendly text.
 */

import type { NotificationChannel } from './index.js';
import type { NotificationEvent } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('notify:telegram');

export class TelegramNotificationChannel implements NotificationChannel {
  name = 'telegram';
  private _sendFn: ((msg: string) => Promise<number | undefined>) | null = null;
  private _initialized = false;

  isAvailable(): boolean {
    return this._initialized && this._sendFn !== null;
  }

  async init(): Promise<void> {
    try {
      const { initTelegram, sendTelegram } = await import('../daemon/supervisor-telegram.js');
      await initTelegram();
      this._sendFn = sendTelegram;
      this._initialized = true;
      log.info('Telegram notification channel initialized');
    } catch (err) {
      log.info(`Telegram not available: ${err}`);
    }
  }

  async send(event: NotificationEvent): Promise<void> {
    if (!this._sendFn) return;
    const message = formatForTelegram(event);
    if (message) {
      await this._sendFn(message);
    }
  }

  async sendRaw(message: string): Promise<number | undefined> {
    if (!this._sendFn) return undefined;
    return this._sendFn(message);
  }
}

function formatForTelegram(event: NotificationEvent): string | null {
  switch (event.type) {
    case 'goal_complete': {
      const lines = [`✅ [${event.project}] ${event.title} — DONE`];
      if (event.durationMin || event.model) {
        const parts = [];
        if (event.durationMin) parts.push(`${event.durationMin} min`);
        if (event.model) parts.push(event.model);
        lines.push(`⏱ ${parts.join(', ')}`);
      }
      if (event.whatChanged) lines.push(`\n📝 ${event.whatChanged}`);
      if (event.tunnelUrl) lines.push(`\n🔗 ${event.tunnelUrl}`);
      if (event.jamId) lines.push(`\n🎬 https://jam.dev/c/${event.jamId}`);
      if (event.checklist) lines.push(`\n📋 Manual test checklist:\n${event.checklist}`);
      lines.push(`\nReact 👍 to approve or 👎 to request changes`);
      return lines.join('\n');
    }

    case 'goal_rejected':
      return `🚫 [${event.project}] ${event.title}\nRejected (attempt ${event.attemptNumber || '?'}): ${event.reason.slice(0, 800)}`;

    case 'goal_blocked':
      return `⚠️ [${event.project}] ${event.title}\nBLOCKED: ${event.reason.slice(0, 200)}`;

    case 'goal_received':
      return `📋 [${event.project}] New goal: ${event.title}\nID: ${event.goalId}${event.description ? `\n${event.description.slice(0, 500)}` : ''}`;

    case 'review_concern': {
      const lines = [`⚠️ [${event.project}] Review concern: ${event.title}`];
      lines.push(event.feedback.slice(0, 500));
      if (event.issues.length > 0) {
        lines.push(`\n${event.issues.length} issue(s) found`);
      }
      return lines.join('\n');
    }

    case 'test_command_failure':
      return `❌ [${event.project}] TEST_COMMANDS failed: ${event.title}\n${event.failureMsg.slice(0, 500)}`;

    case 'system_alert':
      return event.message;

    case 'budget_alert':
      return event.message;

    case 'digest':
      return event.message;

    default:
      return null;
  }
}
