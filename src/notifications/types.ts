/**
 * Notification event types for the DreamTeam notification system.
 *
 * All notification channels receive the same structured events.
 * Each channel formats them appropriately for its platform.
 */

// --- Goal Lifecycle Events ---

export interface GoalCompleteEvent {
  type: 'goal_complete';
  project: string;
  title: string;
  goalId: string;
  costUsd?: number;
  durationMin?: number;
  model?: string;
  tunnelUrl?: string;
  whatChanged?: string;
  jamId?: string;
  checklist?: string;
}

export interface GoalRejectedEvent {
  type: 'goal_rejected';
  project: string;
  title: string;
  goalId: string;
  reason: string;
  attemptNumber?: number;
}

export interface GoalBlockedEvent {
  type: 'goal_blocked';
  project: string;
  title: string;
  goalId: string;
  reason: string;
}

export interface GoalReceivedEvent {
  type: 'goal_received';
  project: string;
  title: string;
  goalId: string;
  description?: string;
}

export interface ReviewConcernEvent {
  type: 'review_concern';
  project: string;
  title: string;
  goalId: string;
  feedback: string;
  issues: Array<{
    severity: string;
    type: string;
    detail: string;
    file?: string;
    line?: number;
  }>;
}

export interface TestCommandFailureEvent {
  type: 'test_command_failure';
  project: string;
  title: string;
  goalId: string;
  failureMsg: string;
}

// --- System Events ---

export interface SystemAlertEvent {
  type: 'system_alert';
  severity: 'info' | 'warn' | 'error' | 'fatal';
  message: string;
}

export interface BudgetAlertEvent {
  type: 'budget_alert';
  message: string;
}

export interface DigestEvent {
  type: 'digest';
  message: string;
}

// --- Union type for all events ---

export type NotificationEvent =
  | GoalCompleteEvent
  | GoalRejectedEvent
  | GoalBlockedEvent
  | GoalReceivedEvent
  | ReviewConcernEvent
  | TestCommandFailureEvent
  | SystemAlertEvent
  | BudgetAlertEvent
  | DigestEvent;
