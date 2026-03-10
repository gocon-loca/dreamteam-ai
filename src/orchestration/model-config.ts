/**
 * Model Configuration — Composable model hierarchy for any foundation model provider.
 *
 * Instead of hardcoding 'haiku', 'sonnet', 'opus', DreamTeam uses a 3-tier hierarchy:
 *
 *   PRIMARY   — Most capable model. Used for complex goals, auth-sensitive work, final escalation.
 *   SECONDARY — Balanced model. Used for retries after primary-tier failure, code review.
 *   ANCILLARY — Cheapest/fastest model. Used for routine goals, triage decisions, first attempts.
 *
 * Users configure this in config/models.yaml (or env vars). The defaults map to Claude:
 *   ancillary: haiku  →  secondary: sonnet  →  primary: opus
 *
 * But you can swap in any model your CLI backend supports:
 *   ancillary: gpt-4o-mini  →  secondary: gpt-4o  →  primary: o1
 *   ancillary: llama-3.1-8b →  secondary: llama-3.1-70b → primary: claude-opus
 *
 * The CLI backend is configured separately.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Abstract model tier — used throughout the codebase */
export type ModelTier = 'primary' | 'secondary' | 'ancillary';

/** Concrete model configuration */
export interface ModelConfig {
  /** CLI model flag for the primary (most capable) tier */
  primary: string;
  /** CLI model flag for the secondary (balanced) tier */
  secondary: string;
  /** CLI model flag for the ancillary (cheapest) tier */
  ancillary: string;

  /** CLI command to execute (default: 'claude') */
  cliCommand: string;
  /** Additional CLI flags applied to all invocations */
  cliFlags: string[];

  /** Escalation ladder for routine goals: ancillary → secondary → primary */
  routineLadder: ModelTier[];
  /** Escalation ladder for complex goals: primary → primary → primary */
  complexLadder: ModelTier[];
  /** Escalation ladder for auth/security-sensitive goals */
  authLadder: ModelTier[];

  /** Approximate cost per invocation by tier (USD, for budget tracking) */
  estimatedCost: Record<ModelTier, number>;
}

// ---------------------------------------------------------------------------
// Defaults (Claude via Claude Code CLI)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ModelConfig = {
  primary: 'opus',
  secondary: 'sonnet',
  ancillary: 'haiku',

  cliCommand: 'claude',
  cliFlags: ['--print'],

  routineLadder: ['ancillary', 'secondary', 'primary'],
  complexLadder: ['primary', 'primary', 'primary'],
  authLadder: ['primary', 'primary', 'primary'],

  estimatedCost: {
    primary: 0.79,
    secondary: 0.25,
    ancillary: 0.05,
  },
};

// ---------------------------------------------------------------------------
// Configuration loading
// ---------------------------------------------------------------------------

let _config: ModelConfig | null = null;

/**
 * Load model configuration from config/models.yaml, env vars, or defaults.
 *
 * Priority (highest first):
 * 1. Environment variables: DREAMTEAM_MODEL_PRIMARY, DREAMTEAM_MODEL_SECONDARY, etc.
 * 2. config/models.yaml file
 * 3. Built-in defaults (Claude: haiku → sonnet → opus)
 */
export function getModelConfig(): ModelConfig {
  if (_config) return _config;

  // Start with defaults
  const config = { ...DEFAULT_CONFIG, estimatedCost: { ...DEFAULT_CONFIG.estimatedCost } };

  // Try loading from config/models.yaml
  const configPath = join(__dirname, '../../config/models.yaml');
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = parseModelsYaml(content);
      if (parsed.primary) config.primary = parsed.primary;
      if (parsed.secondary) config.secondary = parsed.secondary;
      if (parsed.ancillary) config.ancillary = parsed.ancillary;
      if (parsed.cliCommand) config.cliCommand = parsed.cliCommand;
      if (parsed.cliFlags) config.cliFlags = parsed.cliFlags;
      if (parsed.routineLadder) config.routineLadder = parsed.routineLadder as ModelTier[];
      if (parsed.complexLadder) config.complexLadder = parsed.complexLadder as ModelTier[];
      if (parsed.authLadder) config.authLadder = parsed.authLadder as ModelTier[];
      if (parsed.estimatedCost) {
        if (parsed.estimatedCost.primary != null) config.estimatedCost.primary = parsed.estimatedCost.primary;
        if (parsed.estimatedCost.secondary != null) config.estimatedCost.secondary = parsed.estimatedCost.secondary;
        if (parsed.estimatedCost.ancillary != null) config.estimatedCost.ancillary = parsed.estimatedCost.ancillary;
      }
    } catch (err) {
      console.error(`[model-config] Failed to parse ${configPath}:`, err);
    }
  }

  // Environment variable overrides (highest priority)
  if (process.env.DREAMTEAM_MODEL_PRIMARY) config.primary = process.env.DREAMTEAM_MODEL_PRIMARY;
  if (process.env.DREAMTEAM_MODEL_SECONDARY) config.secondary = process.env.DREAMTEAM_MODEL_SECONDARY;
  if (process.env.DREAMTEAM_MODEL_ANCILLARY) config.ancillary = process.env.DREAMTEAM_MODEL_ANCILLARY;
  if (process.env.DREAMTEAM_CLI_COMMAND) config.cliCommand = process.env.DREAMTEAM_CLI_COMMAND;

  _config = config;
  return config;
}

/** Resolve an abstract tier to a concrete model name */
export function resolveModel(tier: ModelTier): string {
  const config = getModelConfig();
  return config[tier];
}

/** Get the escalation ladder for a goal type */
export function getLadder(type: 'routine' | 'complex' | 'auth'): ModelTier[] {
  const config = getModelConfig();
  switch (type) {
    case 'routine': return [...config.routineLadder];
    case 'complex': return [...config.complexLadder];
    case 'auth': return [...config.authLadder];
  }
}

/** Get the estimated cost for a tier */
export function getEstimatedCost(tier: ModelTier): number {
  return getModelConfig().estimatedCost[tier];
}

/** Get CLI command and base flags */
export function getCliConfig(): { command: string; flags: string[] } {
  const config = getModelConfig();
  return { command: config.cliCommand, flags: [...config.cliFlags] };
}

/** Reset cached config (for testing) */
export function resetModelConfig(): void {
  _config = null;
}

// ---------------------------------------------------------------------------
// Backend configuration
// ---------------------------------------------------------------------------

export interface BackendConfig {
  models: {
    primary: string;
    secondary: string;
    ancillary: string;
  };
  estimatedCost: {
    primary: number;
    secondary: number;
    ancillary: number;
  };
}

export interface BackendsConfig {
  backends: Record<string, BackendConfig>;
  defaultBackend: string;
  /** Goal-type → backend routing rules (e.g., 'backend-feature': 'codex') */
  backendRouting: Record<string, string>;
}

let _backendsConfig: BackendsConfig | null = null;

/**
 * Load backend configuration from config/models.yaml or defaults.
 * Backend config is optional — if not present, only 'claude' is available.
 */
export function getBackendsConfig(): BackendsConfig {
  if (_backendsConfig) return _backendsConfig;

  const config = getModelConfig();

  // Default: single Claude backend derived from existing model config
  const defaultConfig: BackendsConfig = {
    backends: {
      claude: {
        models: {
          primary: config.primary,
          secondary: config.secondary,
          ancillary: config.ancillary,
        },
        estimatedCost: { ...config.estimatedCost },
      },
    },
    defaultBackend: process.env.DREAMTEAM_DEFAULT_BACKEND || 'claude',
    backendRouting: {},
  };

  // Try loading backends section from config/models.yaml
  const configPath = join(__dirname, '../../config/models.yaml');
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = parseBackendsYaml(content);
      if (parsed) {
        if (parsed.backends && Object.keys(parsed.backends).length > 0) {
          defaultConfig.backends = { ...defaultConfig.backends, ...parsed.backends };
        }
        if (parsed.defaultBackend) {
          defaultConfig.defaultBackend = parsed.defaultBackend;
        }
        if (parsed.backendRouting) {
          defaultConfig.backendRouting = parsed.backendRouting;
        }
      }
    } catch (err) {
      console.error(`[model-config] Failed to parse backends config:`, err);
    }
  }

  // Environment variable overrides
  if (process.env.DREAMTEAM_DEFAULT_BACKEND) {
    defaultConfig.defaultBackend = process.env.DREAMTEAM_DEFAULT_BACKEND;
  }

  _backendsConfig = defaultConfig;
  return _backendsConfig;
}

/** Resolve a model tier to a concrete model name for a specific backend */
export function resolveBackendModel(backendName: string, tier: ModelTier): string {
  const config = getBackendsConfig();
  const backend = config.backends[backendName];
  if (!backend) {
    // Fall back to default Claude config
    return resolveModel(tier);
  }
  return backend.models[tier];
}

/** Get estimated cost for a tier on a specific backend */
export function getBackendEstimatedCost(backendName: string, tier: ModelTier): number {
  const config = getBackendsConfig();
  const backend = config.backends[backendName];
  if (!backend) return getEstimatedCost(tier);
  return backend.estimatedCost[tier];
}

/**
 * Simple parser for backends section in models.yaml.
 * Looks for 'backends:', 'defaultBackend:', and 'backendRouting:' top-level keys.
 */
function parseBackendsYaml(content: string): Partial<BackendsConfig> | null {
  const result: Partial<BackendsConfig> = {};
  const lines = content.split('\n');
  let section = '';
  let currentBackend = '';
  let subSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    // Top-level keys (indent 0)
    if (indent === 0) {
      const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)/);
      if (kvMatch) {
        section = kvMatch[1];
        const value = kvMatch[2].trim();
        if (section === 'defaultBackend' && value) {
          result.defaultBackend = value.replace(/^["']|["']$/g, '');
        }
        if (section === 'backends' && !value) {
          result.backends = {};
        }
        if (section === 'backendRouting' && !value) {
          result.backendRouting = {};
        }
        currentBackend = '';
        subSection = '';
      }
      continue;
    }

    // Inside backends section
    if (section === 'backends' && result.backends) {
      if (indent === 2) {
        const nameMatch = trimmed.match(/^(\w[\w-]*):\s*$/);
        if (nameMatch) {
          currentBackend = nameMatch[1];
          result.backends[currentBackend] = {
            models: { primary: '', secondary: '', ancillary: '' },
            estimatedCost: { primary: 0, secondary: 0, ancillary: 0 },
          };
          subSection = '';
          continue;
        }
      }
      if (indent === 4 && currentBackend) {
        const subMatch = trimmed.match(/^(\w[\w-]*):\s*$/);
        if (subMatch) {
          subSection = subMatch[1];
          continue;
        }
      }
      if (indent === 6 && currentBackend) {
        const kvMatch = trimmed.match(/^(\w+):\s*(.+)/);
        if (kvMatch) {
          const key = kvMatch[1] as 'primary' | 'secondary' | 'ancillary';
          const value = kvMatch[2].trim().replace(/^["']|["']$/g, '');
          if (subSection === 'models' && result.backends[currentBackend]) {
            result.backends[currentBackend].models[key] = value;
          }
          if (subSection === 'estimatedCost' && result.backends[currentBackend]) {
            const num = parseFloat(value);
            if (!isNaN(num)) result.backends[currentBackend].estimatedCost[key] = num;
          }
        }
      }
    }

    // Inside backendRouting section
    if (section === 'backendRouting' && result.backendRouting && indent === 2) {
      const kvMatch = trimmed.match(/^([\w-]+):\s*(.+)/);
      if (kvMatch) {
        result.backendRouting[kvMatch[1]] = kvMatch[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Simple YAML parser for models.yaml (no external dependency)
// ---------------------------------------------------------------------------

interface ParsedModelsYaml {
  primary?: string;
  secondary?: string;
  ancillary?: string;
  cliCommand?: string;
  cliFlags?: string[];
  routineLadder?: string[];
  complexLadder?: string[];
  authLadder?: string[];
  estimatedCost?: { primary?: number; secondary?: number; ancillary?: number };
}

function parseModelsYaml(content: string): ParsedModelsYaml {
  const result: ParsedModelsYaml = {};
  const lines = content.split('\n');
  let currentKey = '';
  let currentArray: string[] | null = null;
  let inEstimatedCost = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.+)/);
    if (kvMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      // Flush array
      if (currentKey && currentArray) {
        (result as Record<string, unknown>)[currentKey] = currentArray;
        currentArray = null;
      }
      inEstimatedCost = false;

      const key = kvMatch[1];
      const value = kvMatch[2].trim().replace(/^["']|["']$/g, '');
      if (['primary', 'secondary', 'ancillary', 'cliCommand'].includes(key)) {
        (result as Record<string, string>)[key] = value;
      }
      currentKey = key;
      continue;
    }

    // Top-level key with no value (array or object follows)
    const blockMatch = trimmed.match(/^(\w[\w-]*):\s*$/);
    if (blockMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (currentKey && currentArray) {
        (result as Record<string, unknown>)[currentKey] = currentArray;
        currentArray = null;
      }
      currentKey = blockMatch[1];
      if (currentKey === 'estimatedCost') {
        inEstimatedCost = true;
        result.estimatedCost = {};
      } else {
        currentArray = [];
        inEstimatedCost = false;
      }
      continue;
    }

    // Array item
    const arrayMatch = trimmed.match(/^-\s+(.+)/);
    if (arrayMatch && currentArray) {
      currentArray.push(arrayMatch[1].replace(/^["']|["']$/g, ''));
      continue;
    }

    // Nested key: value (inside estimatedCost)
    const nestedMatch = trimmed.match(/^(\w+):\s*(.+)/);
    if (nestedMatch && inEstimatedCost && result.estimatedCost) {
      const val = parseFloat(nestedMatch[2]);
      if (!isNaN(val)) {
        (result.estimatedCost as Record<string, number>)[nestedMatch[1]] = val;
      }
    }
  }

  // Flush final array
  if (currentKey && currentArray) {
    (result as Record<string, unknown>)[currentKey] = currentArray;
  }

  return result;
}
