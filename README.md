# DreamTeam

**Your ideas deserve momentum — even when you're not at a keyboard.**

DreamTeam is a system that lets you manage multiple coding projects from your phone. You describe what you want built, and AI agents go do the work — autonomously, overnight, while you sleep. You wake up to a summary of what got done.

It was built by someone who has a CS background and years of technical experience but doesn't want to spend weekends staring at a terminal. The ideas are the exciting part. The implementation should just... happen.

## What it actually does

You describe what you want — from your terminal, Claude Code, or Telegram on your phone:

```bash
pnpm goal add myapp "Add empty states to all the tabs — right now they just show blank white space"
```

DreamTeam's Director (an AI strategist) turns that into a structured goal with acceptance criteria. The Supervisor dispatches it to a worker agent. The agent creates a feature branch, writes code, runs tests, commits, and signals completion. A review agent checks the diff. A smoke test visits every route. If it all passes, the code gets merged and pushed.

You get a notification: here's what was done, here's the cost, here's a link to see it live.

If something fails, DreamTeam escalates the model (haiku → sonnet → opus), retries with coaching from the last attempt, and tells you if it's truly stuck.

## Who this is for

- **People with too many project ideas and not enough hours.** You have 3-5 side projects and want all of them to make progress, not just whichever one you had energy for last weekend.
- **People who think in product, not in code.** You know what the app should do. You can describe the UX. You just don't want to be the one writing the CSS.
- **People who've felt overwhelmed by developer tooling.** If you've ever opened a README full of `docker-compose` commands and thought "this is not for me" — keep reading. We have a [setup guide](docs/SETUP.md) written specifically for you.

## How it works

```
Your Computer (Claude Code / CLI)     Your Phone (Telegram)
              \                            /
               v                          v
              Director (strategic AI layer)
                        |
              Supervisor (dispatch + quality gates)
                        |
              +---------+---------+
              | Worker 1 | Worker 2 | Worker 3
              | (Claude) | (Claude) | (Claude)
              |          |          |
              Project A  Project B  Project C
```

**The key parts:**

| Component | What it does |
|-----------|-------------|
| **CLI** | Terminal interface. `pnpm goal add/list/status` — works with Claude Code, Codex, or plain terminal. |
| **Telegram Bot** | Optional phone interface. Send goals, check status, approve proposals. |
| **Director** | Claude Opus thinking strategically. Turns your ideas into structured goals. |
| **Supervisor** | The dispatcher. Picks goals, manages workers, runs quality gates, handles failures. |
| **Workers** | Up to 3 Claude Code agents running in parallel, one per project. |
| **Quality Gates** | 4-stage pipeline: sanity check → test commands → code review → smoke test. |
| **Model Ladder** | Starts cheap (Haiku), escalates on failure (Sonnet → Opus). |

## Features

- **Use it your way** — CLI from your terminal (`pnpm goal`), Claude Code on your laptop, or Telegram from your phone. Telegram is optional.
- **Multi-project** — Manages multiple codebases simultaneously. Round-robin dispatch prevents any one project from starving.
- **Quality gates** — Every completion goes through validation, test commands, AI code review, and Playwright smoke testing before merging.
- **Smart retries** — Failed goals get retried with a bigger model and coaching from the last attempt's debrief.
- **Morning digests** — Daily summary of overnight work: what completed, what failed, costs, and next steps.
- **Circuit breakers** — If a project keeps failing, DreamTeam pauses it instead of burning through your budget.
- **Per-project WORKFLOW.md** — Each project can define its own rules, failure modes, and completion checklists that agents follow.
- **Cost tracking** — Budget limits, per-goal cost caps, and analytics on model efficiency.
- **Dependency chains** — Goals can depend on other goals. Blocked goals auto-unblock when dependencies complete.

## Quick start

**First, open a terminal on your computer:**

| System | How to open it |
|--------|---------------|
| **Mac** | Press **Cmd + Space**, type **Terminal**, hit **Enter** |
| **Windows** | Press **Win + R**, type **wt** (or **cmd**), hit **Enter** |
| **Linux** | Press **Ctrl + Alt + T** |

A window with a dark background and a blinking cursor should appear. That's where you paste the commands below.

**Then paste this command and hit Enter:**

```bash
curl -fsSL https://raw.githubusercontent.com/gocon-loca/dreamteam-ai/main/scripts/bootstrap.sh | bash
```

That's it. The script installs everything you need (Node.js, pnpm, Claude CLI), downloads DreamTeam, and launches the setup wizard in your browser.

> **Already have Node 22+ and pnpm?** Here's the manual path:
> ```bash
> git clone https://github.com/gocon-loca/dreamteam-ai.git
> cd dreamteam-ai
> pnpm install
> pnpm run setup:web
> ```

Or run `pnpm run setup:web` after cloning to launch the interactive setup wizard locally.

See the **[Setup Guide](docs/SETUP.md)** for detailed instructions at three levels (gentle, streamlined, or developer-fast).

## What you'll need

- **A computer that stays on** (or a cloud VM / always-on server)
- **Node.js 22+** and **pnpm**
- **A Claude API key** (from [console.anthropic.com](https://console.anthropic.com)) — or use Claude Pro/Max with Claude Code CLI
- **One or more git repos** you want DreamTeam to work on
- **A Telegram account** (optional — for phone-based control)

See [docs/COSTS.md](docs/COSTS.md) for a breakdown of what this costs and how to keep it affordable.

## The commands you'll actually use

**CLI (terminal / Claude Code / Codex):**
```bash
pnpm goal add <project> <title>   # Tell DreamTeam what to build
pnpm goal list                    # See what's in progress
pnpm goal status                  # Check system health
```

**Telegram (optional, from your phone):**
```
/goal <project> <title>   — Send a goal
/goals                    — See progress
/status                   — System health
/digest                   — Summary of recent work
```

There are [25+ Telegram commands](CLAUDE.md#telegram-commands) for power users.

## Project structure

```
dreamteam/
├── src/
│   ├── bot/           # Telegram bot (your phone interface)
│   ├── daemon/        # Supervisor + Worker processes
│   ├── orchestration/ # Goal management, quality gates, model routing
│   ├── scheduler/     # Prompt building, periodic tasks
│   ├── director/      # Strategic AI layer
│   ├── pm/            # Automated smoke testing
│   ├── projects/      # Project registry, dev servers, tunnels
│   ├── db/            # SQLite schema + queries
│   └── analytics/     # Cost tracking, efficiency reports
├── config/
│   ├── projects.yaml         # Example project registry (template)
│   ├── projects.local.yaml   # Your actual projects (gitignored)
│   ├── secrets.template.yaml # Template for encrypted secrets
│   └── .sops.yaml            # Encryption config
├── templates/                # Prompt templates
├── docs/                     # Setup guides, cost info
├── CLAUDE.md                 # Full system documentation
├── ARCHITECTURE.md           # Detailed architecture
└── WORKFLOW.md               # DreamTeam's own agent rules
```

## How much does it cost?

See [docs/COSTS.md](docs/COSTS.md) for details, but the short version:

- **Routine goals** (small fixes, config changes): ~$0.05–0.30 each (starts with Haiku)
- **Complex goals** (new features, multi-file changes): ~$0.50–2.00 each (uses Opus)
- **Daily budget default**: $25/day with per-goal caps
- **Overnight run** (typical): $5–15 for 10–20 goals across multiple projects

DreamTeam starts with the cheapest model and only escalates when needed. Circuit breakers prevent runaway spending on goals that keep failing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on contributing to DreamTeam.

## License

MIT — see [LICENSE](LICENSE) for details.
