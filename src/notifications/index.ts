/**
 * Notification Channel Registry
 *
 * Unified notification system for DreamTeam. All lifecycle events
 * (goal complete, rejected, blocked, review concerns, system alerts)
 * are dispatched to all registered channels.
 *
 * Channels are best-effort — failures never block the supervisor.
 *
 * Configure via DREAMTEAM_NOTIFICATIONS env var:
 *   DREAMTEAM_NOTIFICATIONS=telegram,slack    # both channels
 *   DREAMTEAM_NOTIFICATIONS=telegram          # telegram only
 *   DREAMTEAM_NOTIFICATIONS=slack             # slack only
 *   (unset)                                   # console only
 */

import type { NotificationEvent } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('notifications');

/**
 * A notification channel that receives structured lifecycle events.
 * Implement this interface to add a new notification platform.
 */
export interface NotificationChannel {
  /** Channel identifier (e.g. 'telegram', 'slack', 'console') */
  name: string;

  /** Check if the channel is configured and available */
  isAvailable(): boolean;

  /** Initialize the channel (called once at startup) */
  init?(): Promise<void>;

  /**
   * Send a structured event to this channel.
   * Must not throw — all errors should be caught internally.
   */
  send(event: NotificationEvent): Promise<void>;

  /**
   * Send a raw text message (for backwards compatibility with
   * code that builds its own message strings).
   * Returns a message ID if the platform supports it.
   */
  sendRaw?(message: string): Promise<number | undefined>;
}

const channels: NotificationChannel[] = [];

/**
 * Register a notification channel. Called at startup.
 */
export function registerChannel(channel: NotificationChannel): void {
  channels.push(channel);
  log.info(`Registered notification channel: ${channel.name}`);
}

/**
 * Get a registered channel by name.
 */
export function getChannel(name: string): NotificationChannel | undefined {
  return channels.find(c => c.name === name);
}

/**
 * Initialize all registered channels.
 */
export async function initChannels(): Promise<void> {
  for (const ch of channels) {
    if (ch.init) {
      try {
        await ch.init();
      } catch (err) {
        log.error(`Failed to init channel ${ch.name}`, err);
      }
    }
  }
}

/**
 * Send a structured event to all available channels.
 * Best-effort — individual channel failures don't propagate.
 */
export async function notify(event: NotificationEvent): Promise<void> {
  for (const ch of channels) {
    if (!ch.isAvailable()) continue;
    try {
      await ch.send(event);
    } catch (err) {
      log.error(`Channel ${ch.name} failed for ${event.type}`, err);
    }
  }
}

/**
 * Send a raw text message to all channels that support it.
 * Returns the first message ID received (for Telegram reply tracking).
 */
export async function notifyRaw(message: string): Promise<number | undefined> {
  let messageId: number | undefined;
  for (const ch of channels) {
    if (!ch.isAvailable() || !ch.sendRaw) continue;
    try {
      const id = await ch.sendRaw(message);
      if (id !== undefined && messageId === undefined) {
        messageId = id;
      }
    } catch (err) {
      log.error(`Channel ${ch.name} raw send failed`, err);
    }
  }
  return messageId;
}

/**
 * Auto-register channels based on DREAMTEAM_NOTIFICATIONS env var.
 * Always registers console channel as fallback.
 */
export async function autoRegisterChannels(): Promise<void> {
  const configured = (process.env.DREAMTEAM_NOTIFICATIONS || '').split(',').map(s => s.trim()).filter(Boolean);

  // Console channel is always active
  const { ConsoleNotificationChannel } = await import('./console.js');
  registerChannel(new ConsoleNotificationChannel());

  if (configured.includes('telegram') || configured.length === 0) {
    // Telegram is default if nothing specified (backwards compat)
    try {
      const { TelegramNotificationChannel } = await import('./telegram.js');
      registerChannel(new TelegramNotificationChannel());
    } catch (err) {
      log.error('Failed to load Telegram channel', err);
    }
  }

  if (configured.includes('slack')) {
    try {
      const { SlackNotificationChannel } = await import('./slack.js');
      registerChannel(new SlackNotificationChannel());
    } catch (err) {
      log.error('Failed to load Slack channel', err);
    }
  }

  await initChannels();
  log.info(`Notification channels active: ${channels.filter(c => c.isAvailable()).map(c => c.name).join(', ')}`);
}
