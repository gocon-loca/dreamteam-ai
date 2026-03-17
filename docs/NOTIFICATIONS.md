# Notifications

DreamTeam sends lifecycle notifications (goal complete, rejected, blocked, review concerns) to one or more channels. Choose Telegram, Slack, or both.

## Configuration

Set `DREAMTEAM_NOTIFICATIONS` in your `.env`:

```bash
# Both channels
DREAMTEAM_NOTIFICATIONS=telegram,slack

# Telegram only (default if not set)
DREAMTEAM_NOTIFICATIONS=telegram

# Slack only
DREAMTEAM_NOTIFICATIONS=slack

# No notifications (console logging only)
DREAMTEAM_NOTIFICATIONS=
```

## Telegram Setup

Telegram provides both **notifications** and **commands** (25+ bot commands for controlling DreamTeam from your phone).

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Add the bot token to `config/secrets.yaml`:
   ```yaml
   telegram:
     botToken: "your-bot-token"
     allowedUsers:
       - "your-chat-id"
   ```
3. Encrypt: `sops --encrypt config/secrets.yaml > config/secrets.enc.yaml`

## Slack Setup

Slack provides **team-facing notifications** — goal completions, review concerns, and test failures posted to your channels.

```bash
# Required
DREAMTEAM_SLACK_CLIENT_PATH=/path/to/slack_client.py
DREAMTEAM_SLACK_CHANNEL=development

# Optional
DREAMTEAM_SLACK_AGENT=dreamteam
DREAMTEAM_SLACK_REVIEWER_IDS=U123,U456          # Users to @-mention on reviews
DREAMTEAM_SLACK_REVIEW_CHANNELS=myapp:dev,api:ops  # Project-specific channels
```

The Slack client script posts messages via the Slack API. Use any script that accepts: `post <agent> <channel> <message>`.

### Project-Specific Channels

Route review concerns and test failures to project-specific channels:

```bash
DREAMTEAM_SLACK_REVIEW_CHANNELS=frontend:dev,backend:ops,mobile:mobile-dev
```

When a goal for the `frontend` project has a review concern, it posts to `#dev` instead of the default channel.

## Agent Personas

For multi-agent Slack workspaces where different bot tokens post as different team members, create `config/agent-personas.yaml`:

```yaml
personas:
  default:
    name: dreamteam
    displayName: "DreamTeam"
    emoji: ":robot:"
    postAs: dreamteam
    handles: [goal_complete, goal_rejected, goal_blocked]

  pm:
    name: pm-agent
    displayName: "PM Agent"
    emoji: ":clipboard:"
    postAs: pm
    handles: [goal_received, review_concern, test_command_failure]

  ops:
    name: ops-agent
    displayName: "Operations"
    emoji: ":gear:"
    postAs: ops
    handles: [system_alert, budget_alert, digest]
```

See `config/agent-personas.example.yaml` for the full template.

## Event Types

| Event | When | Default Channel |
|-------|------|-----------------|
| `goal_complete` | Agent finished a goal, passed quality gates | Default |
| `goal_rejected` | Quality gate rejected the work | Default |
| `goal_blocked` | Agent signaled BLOCKED | Default |
| `goal_received` | New goal created, awaiting review | Default |
| `review_concern` | Code review found issues | Project-specific |
| `test_command_failure` | TEST_COMMANDS failed | Project-specific |
| `system_alert` | Crash, health check failure | Default |
| `budget_alert` | Rate limit or budget threshold | Default |
| `digest` | Morning summary, heartbeat | Default |

## Adding a Custom Channel

Implement the `NotificationChannel` interface in `src/notifications/`:

```typescript
import type { NotificationChannel } from './index.js';
import type { NotificationEvent } from './types.js';

export class MyChannel implements NotificationChannel {
  name = 'my-channel';

  isAvailable(): boolean {
    return !!process.env.MY_CHANNEL_TOKEN;
  }

  async send(event: NotificationEvent): Promise<void> {
    // Format and send the event to your platform
  }
}
```

Register it in `src/notifications/index.ts` → `autoRegisterChannels()`.
