# DreamTeam Architecture Overview

> System for autonomous multi-project development, controlled from your phone

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              YOUR PHONE                                      │
│                         (Telegram App)                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Telegram API (HTTPS)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        DREAMTEAM (Node.js)                                  │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│  │ Telegraf Bot  │  │ Auth Layer   │  │ Director     │                      │
│  │ (index.ts)    │──│ (auth.ts)    │──│ (Opus AI)    │                      │
│  └──────────────┘  └──────────────┘  └──────────────┘                      │
│         │                                    │                              │
│         ▼                                    ▼                              │
│  ┌───────────────────────────────────────────────────────────┐             │
│  │              SUPERVISOR (supervisor.ts)                     │             │
│  │  - Dispatches goals to workers                              │             │
│  │  - Runs quality gates (validation, review, smoke test)      │             │
│  │  - Model routing (haiku → sonnet → opus)                    │             │
│  │  - Merges completed work to main                            │             │
│  └───────────────────────────────────────────────────────────┘             │
│         │                                                                   │
│         ▼                                                                   │
│  ┌───────────────────────────────────────────────────────────┐             │
│  │              WORKERS (worker.ts) × 3                        │             │
│  │  - Claims goals from work queue                             │             │
│  │  - Creates goal/{id} branch                                 │             │
│  │  - Spawns Claude CLI per goal                               │             │
│  │  - Continuation loop (up to 50 iterations)                  │             │
│  └───────────────────────────────────────────────────────────┘             │
│                              │                                              │
└──────────────────────────────┼──────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  PROJECT A      │  │  PROJECT B      │  │  PROJECT C      │
│                 │  │                 │  │                 │
│  Claude CLI ────┼──┼── Claude CLI ──┼──┼── Claude CLI    │
│  spawned per    │  │  spawned per   │  │  spawned per    │
│  goal           │  │  goal          │  │  goal           │
└─────────────────┘  └─────────────────┘  └─────────────────┘
          │                    │                    │
          └────────────────────┼────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  GIT REMOTES        │
                    │  (GitHub)           │
                    │                     │
                    │  All changes        │
                    │  committed & pushed │
                    └─────────────────────┘
```

---

## Component Details

### 1. Telegram Bot (`src/bot/index.ts`)
- **Purpose**: Command interface from your phone
- **Commands**: `/goal`, `/goals`, `/startwork`, `/status`, `/digest`, and 20+ more
- **Auth**: User ID allowlist (configured in `config/secrets.enc.yaml`)

### 2. Director (`src/director/director.ts`)
- **Purpose**: Strategic AI layer (Opus) that translates ideas into goals
- **Behavior**: Conversations, goal proposals, knowledge graph, app audits

### 3. Supervisor (`src/daemon/supervisor.ts`)
- **Purpose**: Main orchestration loop
- **Behavior**:
  - Dispatches pending goals to workers via SQLite work queue
  - Runs 4-stage quality gates on completed work
  - Manages model routing (3-tier escalation ladder)
  - Merges verified work to main and pushes
  - Sends Telegram notifications

### 4. Workers (`src/daemon/worker.ts`)
- **Purpose**: Execute goals via Claude CLI
- **Behavior**:
  - Claims items from work queue
  - Creates `goal/{goalId}` feature branch
  - Spawns Claude CLI with built prompt
  - Continuation loop (up to 50 iterations)
  - Detects GOAL_COMPLETE, BLOCKED, ESCALATE signals

### 5. Task Runner (`src/projects/task-runner.ts`)
- **Purpose**: Spawns and manages Claude CLI processes
- **Features**:
  - Timeout per iteration (configurable)
  - Parses structured output
  - Surrender/stuck pattern detection

### 6. Secrets Management (`src/bot/secrets.ts`)
- **Encryption**: SOPS + age (asymmetric encryption)
- **Contains**: Telegram token, test account credentials
- **Flow**: Decrypted at runtime, never stored in plaintext

---

## Quality Gates

Four gates run in sequence after an agent signals `GOAL_COMPLETE`:

1. **Sanity Check** — Surrender patterns, empty diff, short output (free, instant)
2. **TEST_COMMANDS** — Human-authored acceptance criteria run in worktree
3. **Review Agent** — Sonnet code review of the diff with smart truncation
4. **Smoke Test** — Playwright route crawl, regression detection

See `CLAUDE.md` for detailed documentation of each gate.

---

## Security Assessment

### What's Secure

| Component | Security Measure |
|-----------|------------------|
| **Credentials at rest** | SOPS + age encrypted (`secrets.enc.yaml`) |
| **Telegram access** | User ID allowlist |
| **Git secrets** | `.gitignore` excludes `.env`, `secrets.yaml`, `age-key.txt` |
| **Agent prompts** | Include security-first directives |
| **Process isolation** | Each Claude CLI runs as separate process |

### Risk Vectors

| Risk | Current State | Mitigation |
|------|---------------|------------|
| **Age key on disk** | `config/age-key.txt` is plaintext | Restrict file permissions (`chmod 600`) |
| **Claude CLI permissions** | Runs with `--dangerously-skip-permissions` | Necessary for autonomous work |
| **Test credentials in prompts** | Sent to Claude API | Use dedicated test accounts only |
| **No network isolation** | Bot listens on Telegram API | Consider firewall rules |
| **Daemon runs as your user** | Has full user permissions | Consider dedicated service account |

### Critical Risks

1. **`--dangerously-skip-permissions`**: Agents can execute any command. This is by design for autonomous work, but means a prompt injection could be destructive.

2. **Test credentials exposure**: Test account passwords are embedded in prompts sent to the Claude API. Use dedicated test accounts, never production credentials.

3. **No sandboxing**: Agents run with your full user permissions. Consider Docker sandboxing for higher isolation.

---

## Data Flow

```
1. You send /goal via Telegram (or Director creates goals autonomously)
         │
         ▼
2. Bot validates your user ID, Director triages goal
         │
         ▼
3. Goal saved to data/goals.json + SQLite work queue
         │
         ▼
4. Supervisor dispatches goal to available worker
         │
         ▼
5. Worker spawns: claude --print --model <tier> <prompt>
         │
         ▼
6. Claude CLI works autonomously on goal/{goalId} branch
         │
         ▼
7. Agent signals GOAL_COMPLETE with debrief
         │
         ▼
8. Supervisor runs quality gates (sanity → test → review → smoke)
         │
         ▼
9. On pass: merge to main, push, notify via Telegram
```

---

## Quick Commands

```bash
# Start everything (supervisor + workers)
bash scripts/start.sh

# Or start individually
node dist/daemon/supervisor.js
node dist/daemon/worker.js

# Start the Telegram bot
node dist/bot/index.js

# Check goals
cat data/goals.json | jq '.goals[] | {project, title, status}'
```

See `CLAUDE.md` for full Telegram command reference.
