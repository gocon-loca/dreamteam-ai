# Contributing to DreamTeam

Thanks for being interested! Here's how to contribute.

## Getting started

1. Fork the repo and clone it
2. Follow the [Setup Guide](docs/SETUP.md) to get DreamTeam running locally
3. Create a feature branch: `git checkout -b my-feature`
4. Make your changes
5. Run `pnpm build` to verify TypeScript compiles
6. Run `pnpm test` to validate core modules
7. Submit a pull request

## Development

```bash
pnpm install    # Install dependencies
pnpm build      # Build (TypeScript → dist/)
pnpm dev        # Build in watch mode
```

### Project structure

- `src/bot/` — Telegram bot interface
- `src/daemon/` — Supervisor + Worker processes
- `src/orchestration/` — Goal management, quality gates, model routing
- `src/scheduler/` — Prompt building, periodic tasks
- `src/director/` — Strategic AI layer
- `src/db/` — SQLite schema and queries
- `config/` — Project registry, secrets templates

### Key files to understand

Start here:
1. `CLAUDE.md` — Full system documentation (the source of truth)
2. `src/daemon/supervisor.ts` — The main dispatch loop
3. `src/daemon/worker.ts` — How goals get executed
4. `src/orchestration/goal-manager.ts` — Goal lifecycle and quality gates

## Code style

- TypeScript with strict mode
- No unnecessary abstractions — prefer simple, direct code
- Don't add error handling for scenarios that can't happen
- Don't add docstrings/comments to code you didn't change
- Test with `pnpm build` (TypeScript compiler catches most issues)

## What makes a good contribution

- Bug fixes with clear reproduction steps
- New quality gate types (like test-commands or review-agent improvements)
- Model provider support (if Claude Code CLI adds new backends)
- Documentation improvements (especially the setup guide — if something confused you, fix it!)
- New Telegram commands that fill a real gap

## What to avoid

- Don't add external services or dependencies without discussion
- Don't refactor working code just to match your preferences
- Don't add features that only work with a specific project structure
- Don't add web dashboards — Telegram is the interface by design

## Questions?

Open an issue. There are no dumb questions — especially about setup.
