/**
 * Console Notification Channel — logs events to stdout.
 * Always active as a fallback. Useful for CLI-only users.
 */

import type { NotificationChannel } from './index.js';
import type { NotificationEvent } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('notify:console');

export class ConsoleNotificationChannel implements NotificationChannel {
  name = 'console';

  isAvailable(): boolean {
    return true; // Always available
  }

  async send(event: NotificationEvent): Promise<void> {
    switch (event.type) {
      case 'goal_complete':
        log.info(`[${event.project}] Goal completed: ${event.title}${event.costUsd ? ` ($${event.costUsd.toFixed(2)})` : ''}`);
        break;
      case 'goal_rejected':
        log.info(`[${event.project}] Goal rejected: ${event.title} — ${event.reason.slice(0, 200)}`);
        break;
      case 'goal_blocked':
        log.info(`[${event.project}] Goal blocked: ${event.title} — ${event.reason.slice(0, 200)}`);
        break;
      case 'goal_received':
        log.info(`[${event.project}] New goal: ${event.title} (${event.goalId})`);
        break;
      case 'review_concern':
        log.info(`[${event.project}] Review concern: ${event.title} — ${event.issues.length} issue(s)`);
        break;
      case 'test_command_failure':
        log.info(`[${event.project}] TEST_COMMANDS failed: ${event.title}`);
        break;
      case 'system_alert':
        log.info(`[SYSTEM ${event.severity}] ${event.message.slice(0, 300)}`);
        break;
      case 'budget_alert':
        log.info(`[BUDGET] ${event.message.slice(0, 300)}`);
        break;
      case 'digest':
        log.info(`[DIGEST] ${event.message.slice(0, 500)}`);
        break;
    }
  }
}
