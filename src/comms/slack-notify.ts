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

// Read env vars lazily (not at import time) so dotenv has a chance to load first
function getConfig() {
  return {
    clientPath: process.env.DREAMTEAM_SLACK_CLIENT_PATH || '',
    channel: process.env.DREAMTEAM_SLACK_CHANNEL || 'development',
    agentName: process.env.DREAMTEAM_SLACK_AGENT || 'dreamdevteam',
    enabled: process.env.DREAMTEAM_SLACK_NOTIFY !== '0',
  };
}

function isAvailable(): boolean {
  const cfg = getConfig();
  const available = cfg.enabled && existsSync(cfg.clientPath);
  if (!available) {
    console.log(`[slack-notify] Slack notifications disabled (client=${cfg.clientPath ? 'found' : 'not found'}, enabled=${cfg.enabled})`);
  }
  return available;
}

/**
 * Post a message to the configured Slack channel as DreamTeam.
 * Fails silently — Slack notifications are best-effort.
 */
export function sendSlackNotification(message: string, channel?: string): void {
  if (!isAvailable()) return;

  try {
    const cfg = getConfig();
    const ch = channel || cfg.channel;
    // Escape message for shell
    const escaped = message.replace(/'/g, "'\\''");
    execSync(
      `python3 '${cfg.clientPath}' post ${cfg.agentName} ${ch} '${escaped}'`,
      { timeout: 10_000, stdio: 'pipe' }
    );
  } catch (e) {
    // Best-effort — don't crash the supervisor for Slack
    console.error(`[slack-notify] Failed to post to Slack: ${e}`);
  }
}

export interface SlackCompletionInfo {
  tunnelUrl?: string;
  jamId?: string;
  model?: string;
  durationMin?: number;
  whatChanged?: string;
}

/**
 * Notify Slack about a completed goal with rich context.
 * Includes tunnel URL for testing, Jam link for bug-sourced goals,
 * and a call-to-action for feedback.
 */
export function notifyGoalComplete(
  project: string,
  title: string,
  goalId: string,
  costUsd?: number,
  info?: SlackCompletionInfo,
): void {
  const cost = costUsd ? ` ($${costUsd.toFixed(2)})` : '';
  const lines: string[] = [];
  lines.push(`✅ *[${project}]* Goal completed${cost}`);
  lines.push(title);

  if (info?.whatChanged) {
    lines.push(`\n📝 ${info.whatChanged}`);
  }

  if (info?.tunnelUrl) {
    lines.push(`\n🔗 *Test it:* ${info.tunnelUrl}`);
  }

  if (info?.jamId) {
    lines.push(`🎬 *Original Jam:* https://jam.dev/c/${info.jamId}`);
  }

  if (info?.tunnelUrl || info?.jamId) {
    lines.push('\nIf broken → record a Jam and post it here. Sable and the team will break down the feedback.');
  }

  sendSlackNotification(lines.join('\n'));
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

/**
 * Notify Slack about a newly received goal — for founder acceptance.
 * Tags founders and Morgan so they can review before execution begins.
 * Goal stays pending until a founder says "override acceptance" or approves.
 */
export function notifyGoalReceived(
  project: string,
  title: string,
  goalId: string,
  description?: string,
): void {
  const lines: string[] = [];
  lines.push(`📋 *[${project}]* New goal received — awaiting acceptance`);
  lines.push(`*${title}*`);
  if (description) {
    lines.push(`\n${description.slice(0, 500)}`);
  }
  lines.push(`\nID: \`${goalId}\``);
  lines.push(`\n<@U0ALHQ6KZA7> <@U0AL8NFQ2JK> <@U0ALMD19NN9> — review and :thumbsup: to approve, or reply with clarifications.`);
  lines.push(`Say "override acceptance" to skip review and let DreamTeam run immediately.`);
  sendSlackNotification(lines.join('\n'));
}
