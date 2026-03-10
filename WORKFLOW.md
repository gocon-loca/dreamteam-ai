---
rules:
  - Always run pnpm build after code changes to verify compilation
  - Never modify goals.json directly — use goal-manager functions
  - Keep Telegram notifications minimal — log instead of notify for routine events
  - Test with node -e for quick validation before deploying
  - Circuit breaker and session limit state live in SQLite — JSON files are fallback only

completionChecklist:
  - pnpm build passes with zero errors
  - New functions have at least one inline test or node -e verification
  - No secrets or PII in committed code
  - Supervisor restart tested if daemon code changed

contextFiles:
  - CLAUDE.md
  - src/db/index.ts
  - src/daemon/supervisor.ts
---

## DreamTeam Agent Guidelines

This is a multi-process system with a supervisor, workers, and a Telegram bot. Changes to daemon code require a PM2 restart to take effect.

### Database
- All state flows through SQLite (better-sqlite3). WAL mode for concurrent reads.
- Schema migrations are in `src/db/index.ts` — bump version and add migration block.
- Never use `require()` for DB in ESM modules — use dynamic `import()` or pass db as parameter.

### Testing Changes
- Build: `pnpm build`
- Quick test: `node -e "const x = require('./dist/...'); ..."`
- Restart daemon: `pm2 restart supervisor worker-1 worker-2 worker-3`
