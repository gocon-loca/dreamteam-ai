/**
 * SQLite Database Layer for DreamTeam Observability
 *
 * Single connection with WAL mode for concurrent reads.
 * All writes come from the overnight daemon (single Node process).
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'dreamteam.db');
// Schema lives in src/db/schema.sql — resolve from project root since
// at runtime __dirname is dist/db/ (tsc doesn't copy .sql files)
const SCHEMA_PATH = existsSync(join(__dirname, 'schema.sql'))
  ? join(__dirname, 'schema.sql')
  : join(PROJECT_ROOT, 'src/db/schema.sql');

let db: Database.Database | null = null;

/**
 * Get or create the database connection.
 * Uses WAL mode for concurrent reads with single-writer safety.
 */
export function getDb(): Database.Database {
  if (db) return db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);

  // WAL mode: concurrent reads, serialized writes
  db.pragma('journal_mode = WAL');
  // Reasonable busy timeout for concurrent access
  db.pragma('busy_timeout = 5000');
  // Foreign key enforcement
  db.pragma('foreign_keys = ON');

  // Run migrations
  migrateSchema(db);

  return db;
}

/**
 * Apply schema migrations. Idempotent — safe to call on every startup.
 */
function migrateSchema(database: Database.Database): void {
  const currentVersion = getCurrentVersion(database);

  if (currentVersion < 1) {
    // Initial schema
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    database.exec(schema);
    setVersion(database, 1);
  }

  if (currentVersion < 2) {
    // Sub-tasks table
    database.exec(`
      CREATE TABLE IF NOT EXISTS subtasks (
        id TEXT PRIMARY KEY,
        parent_goal_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        acceptance_criteria TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        linear_id TEXT,
        run_id TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,

        FOREIGN KEY (run_id) REFERENCES agent_runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_subtasks_parent ON subtasks(parent_goal_id);
      CREATE INDEX IF NOT EXISTS idx_subtasks_status ON subtasks(status);
    `);
    setVersion(database, 2);
  }

  if (currentVersion < 3) {
    // Supervisor + Worker architecture: work queue and structured events
    database.exec(`
      CREATE TABLE IF NOT EXISTS work_queue (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        project TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        worker_pid INTEGER,
        prompt TEXT,
        model TEXT,
        archetype TEXT,
        cost_usd REAL DEFAULT 0,
        cost_limit_usd REAL DEFAULT 2.0,
        last_progress_at TEXT,
        attempt_number INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        exit_signal TEXT,
        result_output TEXT,
        run_id TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_wq_status ON work_queue(status);
      CREATE INDEX IF NOT EXISTS idx_wq_project ON work_queue(project);
      CREATE INDEX IF NOT EXISTS idx_wq_goal ON work_queue(goal_id);

      CREATE TABLE IF NOT EXISTS supervisor_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        event_type TEXT NOT NULL,
        goal_id TEXT,
        project TEXT,
        worker_pid INTEGER,
        details TEXT,
        cost_usd REAL
      );

      CREATE INDEX IF NOT EXISTS idx_se_timestamp ON supervisor_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_se_type ON supervisor_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_se_project ON supervisor_events(project);
    `);
    setVersion(database, 3);
  }

  if (currentVersion < 4) {
    // Stale detection: track output size growth for stuck agent detection
    try {
      database.exec(`ALTER TABLE work_queue ADD COLUMN last_output_size INTEGER DEFAULT 0`);
    } catch { /* column already exists */ }
    setVersion(database, 4);
  }

  if (currentVersion < 5) {
    // State consolidation: move circuit breaker + session limits into SQLite
    // so we have a single source of truth instead of multiple JSON files that drift
    database.exec(`
      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    setVersion(database, 5);
  }

  if (currentVersion < 6) {
    // Timeout race condition: flag work items where GOAL_COMPLETE was in buffer after timeout
    try {
      database.exec(`ALTER TABLE work_queue ADD COLUMN timed_out INTEGER DEFAULT 0`);
    } catch { /* column already exists */ }
    setVersion(database, 6);
  }

  if (currentVersion < 7) {
    // Execution checkpoints for crash-resilient goal resumption
    database.exec(`
      CREATE TABLE IF NOT EXISTS execution_checkpoints (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        run_id TEXT,
        project TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        commit_sha TEXT,
        output_so_far TEXT,
        cost_usd_so_far REAL DEFAULT 0,
        input_tokens_so_far INTEGER DEFAULT 0,
        output_tokens_so_far INTEGER DEFAULT 0,
        cache_read_tokens_so_far INTEGER DEFAULT 0,
        cache_creation_tokens_so_far INTEGER DEFAULT 0,
        exit_signal_so_far TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ckpt_goal ON execution_checkpoints(goal_id);
      CREATE INDEX IF NOT EXISTS idx_ckpt_work_item ON execution_checkpoints(work_item_id);
    `);
    setVersion(database, 7);
  }

  if (currentVersion < 8) {
    // CLI backend tracking — which backend (claude, codex) ran each goal
    try {
      database.exec(`ALTER TABLE agent_runs ADD COLUMN backend TEXT DEFAULT 'claude'`);
    } catch { /* column already exists */ }
    try {
      database.exec(`ALTER TABLE work_queue ADD COLUMN backend TEXT DEFAULT 'claude'`);
    } catch { /* column already exists */ }
    setVersion(database, 8);
  }
}

function getCurrentVersion(database: Database.Database): number {
  try {
    const row = database.prepare(
      'SELECT MAX(version) as version FROM schema_version'
    ).get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

function setVersion(database: Database.Database, version: number): void {
  database.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
  ).run(version, new Date().toISOString());
}

/**
 * Close the database connection. Call on process shutdown.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Generate a UUID v4 for record IDs.
 */
export function generateId(): string {
  return randomUUID();
}
