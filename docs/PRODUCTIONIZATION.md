# DreamTeam Productionization Plan

## Overview

DreamTeam is an autonomous coding system that controls multiple projects simultaneously. This plan covers making it a clean, generic, open-source product that anyone can set up and use with their choice of Telegram or Slack (or both) as the control interface.

---

## Phase 1: Scrub Private References (IMMEDIATE)

Remove all hardcoded project names, user IDs, paths, and company-specific references from tracked files.

### Files to fix:
- `src/comms/slack-notify.ts` — remove agent persona names ("Sable", "Morgan"), replace "founders" with "reviewers"
- `src/orchestration/backends/codex-backend.ts` — remove hardcoded `/Users/remote/homebrew/bin/codex` path
- `src/cli/goal.ts` — change private project name in help text example
- `src/scheduler/prompt-builder.ts` — remove private project name in comment
- `src/orchestration/goal-crud.ts`, `goal-lifecycle.ts` — replace "founders" with "reviewers" in comments
- `README.md`, `package.json`, `docs/SETUP.md`, `docs/QUICKSTART.md`, `scripts/bootstrap.sh`, `scripts/setup-ui/index.html` — replace org-specific GitHub URLs
- Remove project-specific `.mjs` debug scripts from tracking

---

## Phase 2: Notification Adapter Pattern

Replace the current split (Telegram deeply integrated, Slack bolted on via Python) with a clean `NotificationChannel` interface.

### Architecture:
```
src/notifications/
  types.ts         — Event interfaces (GoalComplete, ReviewConcern, etc.)
  index.ts         — NotificationChannel interface + registry
  telegram.ts      — Wraps existing supervisor-telegram.ts
  slack.ts         — Native @slack/web-api (replaces Python script shelling)
  console.ts       — CLI-only fallback (always active)
  persona-router.ts — Routes notifications to different Slack identities
```

### Interface:
```typescript
interface NotificationChannel {
  name: string;
  isAvailable(): boolean;
  onGoalComplete(event: GoalCompleteEvent): Promise<void>;
  onGoalRejected(event: GoalRejectedEvent): Promise<void>;
  onGoalBlocked(event: GoalBlockedEvent): Promise<void>;
  onReviewConcern(event: ReviewConcernEvent): Promise<void>;
  onTestCommandFailure(event: TestCommandFailureEvent): Promise<void>;
  onSystemAlert(event: SystemAlertEvent): Promise<void>;
  onDigest(event: DigestEvent): Promise<void>;
}
```

### Key decisions:
- Telegram bot commands stay Telegram-specific (not abstracted)
- Slack command input comes from external agent system, not DreamTeam
- All notification calls are best-effort (failures don't block)
- Configure via: `DREAMTEAM_NOTIFICATIONS=telegram,slack`

---

## Phase 3: Setup Wizard

Extend the existing setup wizards (CLI + web) with:

```
Step 1/7: Prerequisites        (unchanged)
Step 2/7: AI Provider          (unchanged)
Step 3/7: Messaging            (NEW — Telegram, Slack, both, or CLI-only)
Step 4/7: Telegram Setup       (if selected)
Step 5/7: Slack Setup          (if selected — bot token, channel, reviewer IDs)
Step 6/7: Projects             (unchanged)
Step 7/7: Integrations         (unchanged)
```

---

## Phase 4: Agent Persona Template System

Let users define a team of Slack agent personas via YAML config:

```yaml
# config/agent-personas.yaml (gitignored)
personas:
  default:
    name: dreamteam
    displayName: "DreamTeam"
    emoji: ":robot:"
    handles: [goal_complete, goal_rejected, goal_blocked]

  pm:
    name: pm-agent
    displayName: "PM Agent"
    emoji: ":clipboard:"
    handles: [review_concern, test_command_failure, goal_received]

  ops:
    name: ops-agent
    displayName: "Operations"
    emoji: ":gear:"
    handles: [system_alert, digest, circuit_breaker]
```

### Integration points for external agent systems:
1. **Outgoing webhook** — `DREAMTEAM_WEBHOOK_URL` POSTs JSON events
2. **Incoming command API** — `POST /api/command` on supervisor health server
3. **Agent persona config** — maps DreamTeam events to Slack identities

---

## Phase 5: Documentation

### Rewrite:
- `README.md` — generic URLs, clean examples
- `ROADMAP.md` — open-source project priorities

### Create:
- `docs/NOTIFICATIONS.md` — notification channel system, setup for each
- `docs/AGENT-PERSONAS.md` — persona config, integration patterns
- `docs/CLI.md` — CLI interface documentation
- `config/agent-personas.example.yaml` — tracked template

---

## Phase 6: CI/Release (can ship without)

- CI step: `git grep` for private reference patterns (preventive)
- npm publishing or release automation
- Docker deployment option
- `dreamteam init` CLI for headless environments
