/**
 * Slack Notification Channel
 *
 * Posts notifications via an external Slack client script.
 * Supports project-specific channel routing and reviewer tagging
 * via environment variables.
 *
 * Environment variables:
 *   DREAMTEAM_SLACK_CLIENT_PATH — path to Slack client script (required)
 *   DREAMTEAM_SLACK_CHANNEL — default channel (default: "development")
 *   DREAMTEAM_SLACK_AGENT — agent name for posting (default: "dreamteam")
 *   DREAMTEAM_SLACK_NOTIFY — set to "0" to disable
 *   DREAMTEAM_SLACK_REVIEWER_IDS — comma-separated Slack user IDs to tag
 *   DREAMTEAM_SLACK_REVIEW_CHANNELS — project:channel mappings (e.g. "proj1:dev,proj2:ops")
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { NotificationChannel } from './index.js';
import type { NotificationEvent } from './types.js';
import { createLogger } from '../utils/logger.js';
import { getAgentForEvent } from './persona-router.js';

const log = createLogger('notify:slack');

function getSlackConfig() {
  return {
    clientPath: process.env.DREAMTEAM_SLACK_CLIENT_PATH || '',
    channel: process.env.DREAMTEAM_SLACK_CHANNEL || 'development',
    agentName: process.env.DREAMTEAM_SLACK_AGENT || 'dreamteam',
    enabled: process.env.DREAMTEAM_SLACK_NOTIFY !== '0',
    reviewerIds: process.env.DREAMTEAM_SLACK_REVIEWER_IDS || '',
  };
}

function getReviewChannel(project: string): string | undefined {
  const raw = process.env.DREAMTEAM_SLACK_REVIEW_CHANNELS || '';
  if (!raw) return undefined;
  for (const entry of raw.split(',')) {
    const [proj, channel] = entry.split(':').map(s => s.trim());
    if (proj === project && channel) return channel;
  }
  return undefined;
}

function getReviewerTags(): string {
  const cfg = getSlackConfig();
  if (!cfg.reviewerIds) return '';
  return cfg.reviewerIds.split(',').map(id => `<@${id.trim()}>`).join(' ');
}

function postToSlack(message: string, channel?: string, agentName?: string): void {
  const cfg = getSlackConfig();
  const ch = channel || cfg.channel;
  const agent = agentName || cfg.agentName;
  const escaped = message.replace(/'/g, "'\\''");
  execSync(
    `python3 '${cfg.clientPath}' post ${agent} ${ch} '${escaped}'`,
    { timeout: 10_000, stdio: 'pipe' }
  );
}

export class SlackNotificationChannel implements NotificationChannel {
  name = 'slack';

  isAvailable(): boolean {
    const cfg = getSlackConfig();
    return cfg.enabled && !!cfg.clientPath && existsSync(cfg.clientPath);
  }

  async send(event: NotificationEvent): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      const { message, channel } = formatForSlack(event);
      if (message) {
        // Use persona router to determine which agent posts this event
        const agent = getAgentForEvent(event.type);
        postToSlack(message, channel, agent);
      }
    } catch (err) {
      log.error(`Slack send failed for ${event.type}`, err);
    }
  }

  async sendRaw(message: string): Promise<number | undefined> {
    if (!this.isAvailable()) return undefined;
    try {
      postToSlack(message);
    } catch (err) {
      log.error('Slack raw send failed', err);
    }
    return undefined;
  }
}

function formatForSlack(event: NotificationEvent): { message: string | null; channel?: string } {
  const reviewers = getReviewerTags();

  switch (event.type) {
    case 'goal_complete': {
      const lines: string[] = [];
      lines.push(`:white_check_mark: *[${event.project}]* Goal completed${event.costUsd ? ` ($${event.costUsd.toFixed(2)})` : ''}`);
      lines.push(event.title);
      if (event.whatChanged) lines.push(`\n:memo: ${event.whatChanged}`);
      if (event.tunnelUrl) lines.push(`\n:link: *Test it:* ${event.tunnelUrl}`);
      if (event.jamId) lines.push(`:clapper: *Original Jam:* https://jam.dev/c/${event.jamId}`);
      if (event.tunnelUrl || event.jamId) {
        lines.push('\nIf broken → record a Jam and post it here for the team to review.');
      }
      return { message: lines.join('\n') };
    }

    case 'goal_rejected':
      return {
        message: `:no_entry_sign: *[${event.project}]* Goal rejected\n${event.title}\nReason: ${event.reason.slice(0, 200)}`,
      };

    case 'goal_blocked':
      return {
        message: `:warning: *[${event.project}]* Goal blocked\n${event.title}\nWhy: ${event.reason.slice(0, 200)}`,
      };

    case 'goal_received': {
      const lines: string[] = [];
      lines.push(`:clipboard: *[${event.project}]* New goal received — awaiting acceptance`);
      lines.push(`*${event.title}*`);
      if (event.description) lines.push(`\n${event.description.slice(0, 500)}`);
      lines.push(`\nID: \`${event.goalId}\``);
      if (reviewers) {
        lines.push(`\n${reviewers} — review and :thumbsup: to approve, or reply with clarifications.`);
      }
      lines.push(`Say "override acceptance" to skip review and let the system run immediately.`);
      return { message: lines.join('\n') };
    }

    case 'review_concern': {
      const channel = getReviewChannel(event.project);
      const lines: string[] = [];
      lines.push(`:warning: *[${event.project}]* Goal blocked by review — needs input`);
      lines.push(`*${event.title}*`);
      lines.push(`ID: \`${event.goalId}\``);
      lines.push(`\n*Review feedback:* ${event.feedback.slice(0, 500)}`);
      if (event.issues.length > 0) {
        lines.push(`\n*Issues found (${event.issues.length}):*`);
        for (const issue of event.issues.slice(0, 5)) {
          const loc = issue.file ? ` \`${issue.file}${issue.line ? `:${issue.line}` : ''}\`` : '';
          lines.push(`  • [${issue.severity}] ${issue.type}: ${issue.detail.slice(0, 150)}${loc}`);
        }
        if (event.issues.length > 5) {
          lines.push(`  _...and ${event.issues.length - 5} more_`);
        }
      }
      lines.push(`\nGoal is re-queued for retry. The next attempt will include this feedback.`);
      if (reviewers) lines.push(`${reviewers} — reply in thread if you want to adjust the spec.`);
      return { message: lines.join('\n'), channel };
    }

    case 'test_command_failure': {
      const channel = getReviewChannel(event.project);
      const lines: string[] = [];
      lines.push(`:x: *[${event.project}]* Goal failed acceptance tests`);
      lines.push(`*${event.title}*`);
      lines.push(`ID: \`${event.goalId}\``);
      lines.push(`\n*TEST_COMMANDS output:*`);
      lines.push(`\`\`\`${event.failureMsg.slice(0, 800)}\`\`\``);
      lines.push(`\nGoal is re-queued for retry with this failure context.`);
      return { message: lines.join('\n'), channel };
    }

    case 'system_alert':
      return { message: `:rotating_light: *System ${event.severity}:* ${event.message.slice(0, 300)}` };

    case 'budget_alert':
      return { message: `:money_with_wings: ${event.message.slice(0, 300)}` };

    case 'digest':
      return { message: event.message };

    default:
      return { message: null };
  }
}
