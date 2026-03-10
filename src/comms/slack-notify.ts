/**
 * Slack notifications for DreamTeam goal lifecycle events.
 *
 * Uses a configurable Slack client script (e.g., slack_client.py) to post notifications.
 * Configure via environment variables:
 *   DREAMTEAM_SLACK_CLIENT_PATH — path to slack client script
 *   DREAMTEAM_SLACK_CHANNEL — channel to post to (default: product)
 *   DREAMTEAM_SLACK_AGENT — agent name for posting (default: dreamteam)
 *   DREAMTEAM_SLACK_NOTIFY — set to "0" to disable
 *
 * Falls back silently if client script is not available.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

const SLACK_CLIENT_PATH = process.env.DREAMTEAM_SLACK_CLIENT_PATH || '';
const SLACK_CHANNEL = process.env.DREAMTEAM_SLACK_CHANNEL || 'product';
const SLACK_AGENT_NAME = process.env.DREAMTEAM_SLACK_AGENT || 'dreamteam';
const ENABLED = process.env.DREAMTEAM_SLACK_NOTIFY !== '0';

let _available: boolean | null = null;

function isAvailable(): boolean {
  if (_available !== null) return _available;
  _available = ENABLED && existsSync(SLACK_CLIENT_PATH);
  if (!_available) {
    console.log('[slack-notify] Slack notifications disabled (client not found or DREAMTEAM_SLACK_NOTIFY=0)');
  }
  return _available;
}

/**
 * Post a message to the configured Slack channel as DreamTeam.
 * Fails silently — Slack notifications are best-effort.
 */
export function sendSlackNotification(message: string, channel?: string): void {
  if (!isAvailable()) return;

  try {
    const ch = channel || SLACK_CHANNEL;
    // Escape message for shell
    const escaped = message.replace(/'/g, "'\\''");
    execSync(
      `python3 '${SLACK_CLIENT_PATH}' post ${SLACK_AGENT_NAME} ${ch} '${escaped}'`,
      { timeout: 10_000, stdio: 'pipe' }
    );
  } catch (e) {
    // Best-effort — don't crash the supervisor for Slack
    console.error(`[slack-notify] Failed to post to Slack: ${e}`);
  }
}

/**
 * Notify Slack about a completed goal.
 */
export function notifyGoalComplete(project: string, title: string, goalId: string, costUsd?: number): void {
  const cost = costUsd ? ` ($${costUsd.toFixed(2)})` : '';
  sendSlackNotification(`✅ *[${project}]* Goal completed${cost}\n${title}\nID: \`${goalId}\``);
}

/**
 * Notify Slack about a rejected/failed goal.
 */
export function notifyGoalRejected(project: string, title: string, reason: string): void {
  sendSlackNotification(`🚫 *[${project}]* Goal rejected\n${title}\nReason: ${reason.slice(0, 200)}`);
}

/**
 * Notify Slack about a blocked goal.
 */
export function notifyGoalBlocked(project: string, title: string, reason: string): void {
  sendSlackNotification(`⚠️ *[${project}]* Goal blocked\n${title}\nWhy: ${reason.slice(0, 200)}`);
}
