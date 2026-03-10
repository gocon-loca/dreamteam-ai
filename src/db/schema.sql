-- DreamTeam Observability Schema
-- Version 1: Foundation

-- Every agent run (one per Claude CLI invocation within a goal)
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  parent_run_id TEXT,
  project TEXT NOT NULL,
  model_assigned TEXT NOT NULL,
  model_promoted_from TEXT,
  promotion_reason TEXT,
  archetype TEXT,

  -- Context sent
  prompt_text TEXT,
  project_docs TEXT,
  specialized_context TEXT,
  mcp_servers TEXT,
  tools_enabled TEXT,
  hooks_active TEXT,
  knowledge_excerpts TEXT,

  -- Execution
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  iteration_count INTEGER,
  commands_run TEXT,
  files_touched TEXT,

  -- Cost (from --output-format json)
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd REAL,

  -- Sub-tasks
  subtask_descriptions TEXT,

  -- Outcome
  exit_signal TEXT,
  cross_check_result TEXT,
  cross_check_issues TEXT,
  tests_run INTEGER,
  tests_passed INTEGER,
  tests_failed INTEGER,
  screenshots TEXT,

  -- Analysis
  tags TEXT,
  quality_score INTEGER,

  -- Raw output
  output_text TEXT,
  debrief_json TEXT,

  -- JSON parse status
  json_parse_failed INTEGER DEFAULT 0,

  FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_runs_goal ON agent_runs(goal_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON agent_runs(project);
CREATE INDEX IF NOT EXISTS idx_runs_model ON agent_runs(model_assigned);
CREATE INDEX IF NOT EXISTS idx_runs_started ON agent_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_runs_exit_signal ON agent_runs(exit_signal);

-- Every Director interaction
CREATE TABLE IF NOT EXISTS director_interactions (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,

  -- Input
  user_input_raw TEXT,
  whisper_transcript TEXT,
  input_type TEXT,

  -- Response
  director_response TEXT,

  -- Goals proposed
  goals_proposed TEXT,
  clarifications_requested TEXT,

  -- Refinement
  user_refinements TEXT,
  goals_confirmed TEXT,
  goals_held TEXT,

  -- Conversation context
  exchange_message_count INTEGER,
  session_id TEXT,

  -- Cost
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL
);

CREATE INDEX IF NOT EXISTS idx_director_timestamp ON director_interactions(timestamp);
CREATE INDEX IF NOT EXISTS idx_director_session ON director_interactions(session_id);

-- Human feedback on completed goals
CREATE TABLE IF NOT EXISTS human_feedback (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  goal_id TEXT NOT NULL,
  type TEXT NOT NULL,
  comment TEXT,
  timestamp TEXT NOT NULL,
  redo_context TEXT,

  FOREIGN KEY (run_id) REFERENCES agent_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_goal ON human_feedback(goal_id);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON human_feedback(type);

-- Model-task performance memory (aggregated)
CREATE TABLE IF NOT EXISTS model_task_memory (
  id TEXT PRIMARY KEY,
  goal_type TEXT NOT NULL,
  archetype TEXT,
  model TEXT NOT NULL,
  tools_used TEXT,
  context_docs TEXT,

  total_runs INTEGER DEFAULT 0,
  successes INTEGER DEFAULT 0,
  failures INTEGER DEFAULT 0,
  promotions INTEGER DEFAULT 0,
  avg_cost_usd REAL,
  avg_duration_ms REAL,

  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_type_model ON model_task_memory(goal_type, model);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
