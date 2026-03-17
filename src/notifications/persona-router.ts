/**
 * Agent Persona Router
 *
 * Routes notification events to different Slack agent identities
 * based on config/agent-personas.yaml. If no config exists, all
 * notifications use the default agent from DREAMTEAM_SLACK_AGENT env var.
 *
 * This enables multi-agent Slack workspaces where different bot tokens
 * post as different team members (PM, ops lead, dev lead, etc.).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const log = createLogger('persona-router');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Persona {
  name: string;
  displayName: string;
  emoji: string;
  postAs: string;
  handles: string[];
}

interface PersonaConfig {
  personas: Record<string, Persona>;
}

let _config: PersonaConfig | null = null;
let _loaded = false;

function loadConfig(): PersonaConfig | null {
  if (_loaded) return _config;
  _loaded = true;

  const configPath = join(__dirname, '../../config/agent-personas.yaml');
  if (!existsSync(configPath)) {
    log.debug('No agent-personas.yaml found — using default agent for all events');
    return null;
  }

  try {
    // Simple YAML parser for the persona config format
    // Avoids adding a yaml dependency — config is flat enough
    const raw = readFileSync(configPath, 'utf-8');
    const personas: Record<string, Persona> = {};

    let currentKey: string | null = null;
    let currentPersona: Partial<Persona> = {};

    for (const line of raw.split('\n')) {
      const trimmed = line.trimEnd();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Top-level "personas:" key
      if (trimmed === 'personas:') continue;

      // Persona key (2-space indent, ends with :)
      const personaMatch = trimmed.match(/^  (\w+):$/);
      if (personaMatch) {
        if (currentKey && currentPersona.name) {
          personas[currentKey] = currentPersona as Persona;
        }
        currentKey = personaMatch[1];
        currentPersona = { handles: [] };
        continue;
      }

      // Property (4-space indent)
      const propMatch = trimmed.match(/^    (\w+):\s*"?([^"]*)"?\s*$/);
      if (propMatch && currentKey) {
        const [, key, value] = propMatch;
        if (key === 'handles') continue; // handled by array items
        (currentPersona as any)[key] = value;
        continue;
      }

      // Array item (6-space indent, dash)
      const itemMatch = trimmed.match(/^      - (\S+)/);
      if (itemMatch && currentKey) {
        if (!currentPersona.handles) currentPersona.handles = [];
        currentPersona.handles.push(itemMatch[1]);
        continue;
      }
    }

    // Save last persona
    if (currentKey && currentPersona.name) {
      personas[currentKey] = currentPersona as Persona;
    }

    if (Object.keys(personas).length === 0) {
      log.debug('agent-personas.yaml has no personas defined');
      return null;
    }

    _config = { personas };
    log.info(`Loaded ${Object.keys(personas).length} persona(s): ${Object.keys(personas).join(', ')}`);
    return _config;
  } catch (err) {
    log.error('Failed to parse agent-personas.yaml', err);
    return null;
  }
}

/**
 * Get the agent name to post as for a given event type.
 * Returns the persona's postAs value, or the default agent name.
 */
export function getAgentForEvent(eventType: string): string {
  const config = loadConfig();
  if (!config) return process.env.DREAMTEAM_SLACK_AGENT || 'dreamteam';

  // Find persona that handles this event type
  for (const persona of Object.values(config.personas)) {
    if (persona.handles?.includes(eventType)) {
      return persona.postAs;
    }
  }

  // Fall back to default persona, then env var
  const defaultPersona = config.personas['default'];
  if (defaultPersona) return defaultPersona.postAs;

  return process.env.DREAMTEAM_SLACK_AGENT || 'dreamteam';
}

/**
 * Get all configured personas (for display/debugging).
 */
export function getPersonas(): Record<string, Persona> {
  const config = loadConfig();
  return config?.personas || {};
}
