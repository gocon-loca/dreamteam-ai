/**
 * Telegram Message → Goal ID mapping
 *
 * Persists message_id → goal_id mapping so we can detect
 * when users swipe-reply to completion messages.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const MAP_FILE = join(DATA_DIR, 'telegram-message-goals.json');

interface GoalMapping {
  goalId: string;
  project: string;
  timestamp: string;
}

type MappingStore = Record<string, GoalMapping>;

function loadMappings(): MappingStore {
  if (!existsSync(MAP_FILE)) return {};
  try {
    return JSON.parse(readFileSync(MAP_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveMappings(mappings: MappingStore): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MAP_FILE, JSON.stringify(mappings, null, 2));
}

/**
 * Store a message_id → goal_id mapping.
 */
export function saveTelegramGoalMapping(messageId: number, goalId: string, project: string): void {
  const mappings = loadMappings();

  // Prune entries older than 7 days
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [key, val] of Object.entries(mappings)) {
    if (new Date(val.timestamp).getTime() < cutoff) {
      delete mappings[key];
    }
  }

  mappings[String(messageId)] = {
    goalId,
    project,
    timestamp: new Date().toISOString(),
  };

  saveMappings(mappings);
}

/**
 * Look up goal info for a Telegram message_id.
 */
export function getGoalForMessage(messageId: number): GoalMapping | null {
  const mappings = loadMappings();
  return mappings[String(messageId)] || null;
}

/**
 * Classify reply text as positive, negative, or neutral.
 */
export function classifyFeedback(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.trim().toLowerCase();

  // Positive patterns
  if (/^(\+|👍|🎉|✅|good|great|nice|looks? great|perfect|awesome|love it|lgtm|ship it)$/i.test(lower)) {
    return 'positive';
  }
  if (/\b(looks? good|well done|amazing|excellent|sweet|solid)\b/i.test(lower)) {
    return 'positive';
  }

  // Negative patterns
  if (/^(-|👎|❌|wrong|broken|fix|bad|nope|no)$/i.test(lower)) {
    return 'negative';
  }
  if (/\b(broken|wrong|bug|fix|doesn.?t work|not right|revert|redo|ugly|messed up|regression|failed)\b/i.test(lower)) {
    return 'negative';
  }

  return 'neutral';
}
