# CLAUDE.md — DreamTeam Build Spec

## Project Overview

**DreamTeam** is a multi-project autonomous coding system that:
- Controls multiple projects simultaneously from your phone via Telegram
- Runs Claude Code agents autonomously 24/7 via Supervisor + Worker daemon architecture
- Uses a Director (Claude Opus) as strategic layer for translating ideas into goals
- Employs a PM Agent that runs Playwright smoke tests on a 2-hour cycle
- Implements a 4-stage quality gate pipeline to catch broken completions
- Uses a 3-tier model ladder (haiku → sonnet → opus) with escalation on failure
- Stores state in SQLite (dreamteam.db, execution.db) and JSON (goals.json, director-knowledge.json)
- Generates morning digests, heartbeat updates, and real-time Telegram notifications

**Stack:** TypeScript, Node 22, Telegraf, Playwright, SQLite (better-sqlite3), SOPS + age

---

## Architecture

```
Phone (Telegram)
    │
    ▼
┌─── DREAMTEAM ────────────────────────────────────┐
│  Bot (Telegraf)        ← User commands + feedback │
│    │                                              │
│  Director (Claude)     ← Strategic reasoning      │
│    │                                              │
│  Supervisor (daemon)   ← Goal dispatch + QA       │
│    ├─ Quality Gates    (validation → test_commands │
│    │                    → smoke test → review)     │
│    ├─ Model Router     (haiku → sonnet → opus)    │
│    ├─ PM Agent         (Playwright smoke, 2h)     │
│    └─ Periodic Tasks   (heartbeat, meta-review,   │
│                         test sweep, digest)        │
│    │                                              │
│  Worker (daemon)       ← Executes goals via CLI   │
│    ├─ Branch per goal  (goal/{goalId})            │
│    ├─ Continuation loop (up to 50 iterations)     │
│    └─ Surrender detection                         │
│                                                   │
│  SQLite: dreamteam.db, execution.db               │
│  JSON: goals.json, director-knowledge.json        │
├───────────────────────────────────────────────────┤
│  PROJECTS: (configured in config/projects.yaml)   │
└───────────────────────────────────────────────────┘
```

---

## Goal Lifecycle

1. **Creation** — User sends text/voice to Telegram → Director translates into goal proposals → User approves (interactive) or Director auto-creates (autonomous mode). Goals can also be created by PM Agent sweeps, meta-review, or test sweep.
2. **Triage** — Goals are tagged with confidence (green/yellow) and complexity (routine/complex). Yellow goals are held for user approval.
3. **Dispatch** — Supervisor picks pending goals respecting: dependencies (`dependsOn`), circuit breaker state, per-project concurrency limits, rate limit pauses, and daily goal caps. Model selected via 3-tier ladder based on complexity and attempt count.
4. **Enqueue** — Goal is enqueued in `work_queue` (SQLite). Prompt is built by `prompt-builder.ts` with archetype-specific context, DESIGN.md, recent debriefs, and failure context for retries.
5. **Worker Claim** — Worker daemon claims item from queue, sets up `goal/{goalId}` branch, spawns Claude CLI process.
6. **Agent Execution** — Claude agent works autonomously with continuation loop (up to 50 iterations). Signals: `GOAL_COMPLETE`, `BLOCKED: <reason>`, `ESCALATE: <what tried>`, `ASSUMPTION: <what>`.
7. **Exit Signal** — Worker detects exit signal, records output, cost, tokens in `agent_runs` table, marks work item done/failed.
8. **Quality Gates** — Supervisor runs post-completion hooks (see Quality Gates section below). Goal may be rejected and re-queued.
9. **Merge/Push** — On pass: feature branch rebased onto main, merged, pushed to remote.
10. **Notification** — Rich Telegram message with: completion status, cost, debrief summary, tunnel URL, Jam link (for jam-sourced goals), acceptance checklist. User reacts 👍/👎 for feedback.

---

## Quality Gates

Four gates run in sequence after a goal's agent signals `GOAL_COMPLETE`. If any gate rejects, the goal is set back to `pending` with a `lastRejectionReason` and the next attempt gets failure context.

### Gate 0: Sanity Check (`goal-manager.ts`)
- Checks for surrender patterns in last 1000 chars ("unfixable", "impossible to fix", etc.)
- Rejects empty diff (no files changed on branch)
- Rejects suspiciously short output (<80 chars) with no commits
- **Free, instant — catches obvious failures before spending tokens.**

### Gate 0.5: TEST_COMMANDS (`test-commands.ts`)
- Parses `TEST_COMMANDS:` block from goal description
- Runs each shell command in a git worktree of the goal branch
- Checks exit codes — any non-zero fails the gate
- **Purpose:** Human-authored acceptance criteria that can verify backend/CLI/DB work the smoke test can't see.

### Gate 1: Review Agent (`review-agent.ts`)
- Sonnet single-shot code review of the git diff + goal context
- Returns verdict: `approve`, `reject`, or `concern`
- Structured issues with severity, type, file, line
- Runs before smoke test (faster, catches code quality issues)
- **Known gap:** 4000 char diff limit — large diffs get truncated. Defaults to approve on parse failure.

### Gate 2: Smoke Test (`smoke-test.ts`)
- Playwright-based: crawls all routes, checks HTTP status, detects JS errors
- Regression detection: compares against pre-goal snapshot
- **Only hard-fails on newly broken routes** — placeholder/empty page detection is warning-only
- Only runs for projects with dev servers
- **Known gap:** Cannot verify backend-only, CLI, or database work. Only tests what's visible in the browser.

---

## Model Routing

3-tier ladder with escalation on failure:

| Attempt | Routine Goals | Complex Goals | Auth/RLS Goals |
|---------|--------------|---------------|----------------|
| 1st     | haiku        | opus          | opus           |
| 2nd     | sonnet       | opus          | opus           |
| 3rd     | opus         | opus          | opus           |

- Historical success rates tracked in `model_task_memory` table
- Budget pressure can downgrade model selection
- `model-router.ts` handles selection logic with `classifyGoalType()` and `selectModel()`

---

## Known Weaknesses

| Issue | Impact | Detection | Mitigation |
|-------|--------|-----------|------------|
| Smoke test can't verify backend work | Backend bugs pass quality gates | TEST_COMMANDS + review agent | Static TEST_COMMANDS for known goals; review agent catches issues in code diff |
| Review agent has 4K char diff limit | Large changes get cursory review | Monitor truncation logs | Split large goals |
| Review agent defaults to approve on parse failure | Broken review = auto-pass | Log parse failures | Monitor review agent error rate |
| Timeout kill + GOAL_COMPLETE in buffer | Timed-out work marked complete | `timedOut` flag check | Reject GOAL_COMPLETE from timed-out iterations |
| Silent generic failure retries | User doesn't know goals are failing | Telegram notifications | Send retry notifications |
| PM sweep findings only logged | Critical issues not surfaced to user | Telegram for critical/high | Send PM findings to Telegram |
| Supervisor crash = no notification | System down with no alert | Crash handler Telegram | Send crash notification before exit |

---

## Telegram Commands

```
# Director & Goals
/start              — Bot intro + help
/goal <proj> <title> — Add goal directly
/goals              — List all goals by status
/held               — Goals awaiting review (yellow confidence)
/approve <id> [ctx] — Promote yellow goal to green
/delete <id>        — Delete a goal
/clear              — Clear completed goals
/redo <id> [context] — Re-attempt a completed goal
/feedback <id> +/-  — Rate a goal's result

# System Control
/startwork          — Start supervisor + workers
/stopwork           — Stop supervisor
/pause              — Pause goal dispatch
/resume [project]   — Resume dispatch or project circuit breaker
/kill <id>          — Kill agent working on a goal
/budget [amount]    — Show or set daily budget

# Status & Monitoring
/status             — System overview (supervisor, workers, queue, budget)
/supervisor         — Detailed supervisor + worker status with events
/digest             — Generate morning summary
/review             — Goals awaiting visual review
/links              — Active tunnel URLs
/escalations        — Pending agent escalations
/checkpoints        — Recent system checkpoints

# Testing & QA
/autotest <proj>    — Run autonomous test suite
/smoketest <proj>   — Run Playwright smoke test
/retest <proj>      — Run cascade retest
/testhealth         — Test health summary
/discovertests <p>  — Discover test dependencies
/simulate <proj>    — Run user simulation (Haiku + Playwright)

# Analytics
/costs [day|week|month] — Cost breakdown
/efficiency         — Model performance report
/patterns           — Success patterns from history
/optimize [days]    — Optimization recommendations
/calibration        — Agent self-assessment accuracy

# Design & Research
/audit <proj>       — Run app audit
/design <proj>      — View DESIGN.md
/roadmap <proj>     — View ROADMAP.md
/research <proj>    — UX pattern research
/redesign <proj>    — Full redesign pipeline
/knowledge          — Director knowledge graph
/decisions          — Decision journal entries
/newchat            — Clear Director conversation
```

---

## File Structure

```
dreamteam/
├── CLAUDE.md                        # This file
├── ARCHITECTURE.md                  # Detailed architecture docs
├── ROADMAP.md                       # Project roadmap
├── config/
│   ├── projects.yaml                # Project registry (5 projects)
│   ├── secrets.enc.yaml             # SOPS-encrypted secrets
│   ├── age-key.txt                  # Age private key (gitignored)
│   └── .sops.yaml                   # SOPS config
├── src/
│   ├── bot/
│   │   ├── index.ts                 # Telegram bot (25+ commands)
│   │   ├── auth.ts                  # User authentication
│   │   ├── secrets.ts               # SOPS decryption
│   │   └── telegram-goals.ts        # Message → goal mapping for reactions
│   ├── daemon/
│   │   ├── supervisor.ts            # Main loop: dispatch, monitor, periodic tasks
│   │   ├── worker.ts                # Executes goals via Claude CLI
│   │   └── preflight.ts             # Startup checks (CLI, dev servers, auth)
│   ├── orchestration/
│   │   ├── goal-manager.ts          # Goal CRUD, validation, post-completion hooks
│   │   ├── smoke-test.ts            # Playwright route crawl + regression detection
│   │   ├── review-agent.ts          # Sonnet code review gate
│   │   ├── test-commands.ts         # TEST_COMMANDS verification gate
│   │   ├── archetypes.ts            # Agent archetype classification + self-verification
│   │   ├── model-router.ts          # 3-tier model selection
│   │   ├── digest.ts                # Morning summary generator
│   │   ├── checkpoint.ts            # State checkpointing
│   │   ├── cascade-retest.ts        # Cascade test runner
│   │   ├── circuit-breaker.ts       # Per-project failure circuit breaker
│   │   ├── subtask-manager.ts       # Goal decomposition tracking
│   │   ├── pending-proposals.ts     # Auto-generated goal proposals
│   │   ├── process-tracker.ts       # PID tracking for orphan recovery
│   │   ├── quality.ts               # Self-assessment + escalation
│   │   ├── user-presence.ts         # Interactive vs autonomous mode
│   │   ├── archetypes.ts            # Agent archetype classification
│   │   ├── budget.ts                # Budget tracking
│   │   ├── pending-proposals.ts     # Auto-generated goal proposals
│   │   ├── proposal-store.ts        # Proposal batch management
│   │   ├── goal-triage.ts           # Green/yellow confidence triage
│   │   └── roadmap.ts               # Roadmap file loader
│   ├── scheduler/
│   │   ├── prompt-builder.ts        # Goal → agent prompt with context
│   │   ├── meta-review.ts           # Hourly meta-review of work quality
│   │   └── test-sweep.ts            # Periodic test health check
│   ├── director/
│   │   ├── index.ts                 # Director conversation engine
│   │   ├── knowledge.ts             # Persistent knowledge graph
│   │   ├── decision-journal.ts      # Decision tracking
│   │   ├── feature-inventory.ts     # Feature tracking per project
│   │   ├── app-audit.ts             # App quality audit
│   │   ├── product-research.ts      # UX research
│   │   └── redesign.ts              # Redesign pipeline
│   ├── pm/
│   │   └── pm-agent.ts              # PM sweep: smoke tests + auto goal creation
│   ├── projects/
│   │   ├── registry.ts              # Project config loader
│   │   ├── task-runner.ts           # Claude CLI executor + continuation loop
│   │   ├── dev-server.ts            # Dev server lifecycle
│   │   ├── port-manager.ts          # Port assignment validation
│   │   └── tunnel-manager.ts        # Tailscale tunnel URLs
│   ├── db/
│   │   ├── index.ts                 # SQLite connection (better-sqlite3)
│   │   ├── execution-log.ts         # agent_runs table
│   │   ├── work-queue.ts            # work_queue table
│   │   ├── supervisor-events.ts     # Event log
│   │   └── feedback.ts              # User feedback storage
│   ├── analytics/
│   │   ├── patterns.ts              # Success patterns, cost reports
│   │   └── optimizer.ts             # Optimization recommendations
│   ├── integrations/
│   │   └── linear.ts                # Linear kanban sync
│   ├── comms/
│   │   └── message-queue.ts         # Bot ↔ orchestrator message queue
│   ├── testing/
│   │   ├── auto-test.ts             # Test prompt generator
│   │   ├── credentials.ts           # Test account manager
│   │   └── user-simulation.ts       # Haiku user simulation
│   ├── security/
│   │   └── rm-guard.ts              # Dangerous command protection
│   ├── types/                       # Shared TypeScript types
│   └── utils/
│       └── clean-env.ts             # Clean env for Claude CLI spawning
├── data/
│   ├── goals.json                   # Persistent goal state (source of truth)
│   ├── director-knowledge.json      # Director knowledge graph
│   ├── debriefs/                    # Structured debrief JSON per goal
│   ├── snapshots/                   # Pre/post-goal smoke test snapshots
│   ├── screenshots/                 # Smoke test screenshots per project
│   ├── inventory/                   # Feature inventories per project
│   └── adora/                       # User journey maps
├── scripts/
│   ├── start.sh                     # Start supervisor + workers
│   └── setup-web.ts                 # Web setup wizard
├── templates/                       # Prompt templates
├── tests/                           # Test files
└── tools/                           # CLI tools
```

---

## Development

```bash
# Install
pnpm install

# Build
pnpm build

# Run bot only
node dist/bot/index.js

# Run supervisor (starts main loop, dispatches goals to workers)
node dist/daemon/supervisor.js

# Run worker (claims and executes goals)
node dist/daemon/worker.js

# Start everything (supervisor + workers)
bash scripts/start.sh

# Dev mode (with watch)
pnpm dev

# Run tests
pnpm test
```

### Projects Configuration

Each project in `config/projects.yaml`:
- `path`: Filesystem path (~ expanded)
- `hasDevServer`: Whether to auto-start dev server
- `devCommand`: Command to start dev server
- `devPort`: Port for health checks
- `healthCheck`: URL to verify server is ready

Example projects (configure yours in `config/projects.yaml`):
- TypeScript web apps with `npm run dev`
- Python FastAPI/Flask services with `uvicorn`
- CLI tools and libraries (no dev server needed)
- DreamTeam itself (self-referential for meta-improvements)

### Security

All secrets encrypted at rest with SOPS + age:
```bash
# Decrypt to view
SOPS_AGE_KEY_FILE=./config/age-key.txt sops --decrypt config/secrets.enc.yaml

# Re-encrypt after changes
sops --encrypt config/secrets.yaml > config/secrets.enc.yaml
```
