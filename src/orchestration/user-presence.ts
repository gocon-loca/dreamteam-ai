/**
 * User Presence Tracking
 *
 * Tracks when the user last interacted via Telegram.
 * Used to determine interactive vs autonomous mode.
 *
 * - Interactive: user active within 30 minutes
 * - Autonomous: user inactive for 30+ minutes
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const PRESENCE_FILE = join(DATA_DIR, 'user-presence.json');

const INTERACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

interface PresenceData {
  lastUserMessageAt: string;
}

/**
 * Record that the user sent a message (text or voice).
 * Call this on every user interaction in the Telegram bot.
 */
export function updateUserPresence(): void {
  try {
    writeFileSync(PRESENCE_FILE, JSON.stringify({
      lastUserMessageAt: new Date().toISOString(),
    }));
  } catch {
    // Non-fatal
  }
}

/**
 * Get the current user mode based on last interaction time.
 */
export function getUserMode(): 'interactive' | 'autonomous' {
  // Always interactive — autonomous gate disabled until architecture rework
  return 'interactive';
}

/**
 * Get human-readable time since last user message.
 */
export function getTimeSinceLastMessage(): string {
  try {
    if (!existsSync(PRESENCE_FILE)) return 'never';
    const data: PresenceData = JSON.parse(readFileSync(PRESENCE_FILE, 'utf-8'));
    const elapsed = Date.now() - new Date(data.lastUserMessageAt).getTime();
    if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    return `${Math.floor(elapsed / 3_600_000)}h ago`;
  } catch {
    return 'unknown';
  }
}
