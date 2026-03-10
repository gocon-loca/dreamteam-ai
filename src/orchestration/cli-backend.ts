/**
 * CLI Backend Abstraction — Pluggable execution backends for DreamTeam.
 *
 * Each backend (Claude, Codex, etc.) implements the CliBackend interface,
 * providing binary resolution, argument construction, output parsing, and
 * environment setup.
 *
 * This allows DreamTeam to dispatch goals to different AI coding tools
 * while keeping the task-runner, supervisor, and quality gates unchanged.
 */

// ── Types ──────────────────────────────────────────────────

export interface CliInvocationOptions {
  model: string;
  cwd: string;
  prompt?: string;
  continueMode?: boolean;
  goalId?: string;
  project?: string;
  allowedTools?: string[];
}

export interface ParsedCliOutput {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  jsonParseFailed: boolean;
}

export interface CliBackend {
  /** Human-readable backend name (e.g., 'claude', 'codex') */
  name: string;

  /** Resolve the full path to the CLI binary */
  resolveBinaryPath(): string;

  /** Build command-line arguments for a fresh invocation */
  buildArgs(opts: CliInvocationOptions): string[];

  /** Whether this backend supports session continuation */
  supportsContinuation: boolean;

  /** Build args for continuing a previous session (if supported) */
  buildContinuationArgs?(opts: CliInvocationOptions): string[];

  /** Parse stdout + exit code into structured output */
  parseOutput(stdout: string, exitCode: number): ParsedCliOutput;

  /** Build environment variables for the subprocess */
  buildEnv(base: Record<string, string>): Record<string, string | undefined>;
}

// ── Registry ──────────────────────────────────────────────

const backends = new Map<string, CliBackend>();

/**
 * Register a CLI backend. Called at module load time by each backend module.
 */
export function registerBackend(backend: CliBackend): void {
  backends.set(backend.name, backend);
}

/**
 * Get a registered CLI backend by name.
 * Throws if the backend is not registered.
 */
export function getBackend(name: string): CliBackend {
  const backend = backends.get(name);
  if (!backend) {
    throw new Error(
      `CLI backend "${name}" not registered. Available: ${[...backends.keys()].join(', ') || 'none'}`
    );
  }
  return backend;
}

/**
 * Get all registered backend names.
 */
export function listBackends(): string[] {
  return [...backends.keys()];
}

/**
 * Get the default backend name ('claude' unless overridden).
 */
export function getDefaultBackendName(): string {
  return process.env.DREAMTEAM_DEFAULT_BACKEND || 'claude';
}
