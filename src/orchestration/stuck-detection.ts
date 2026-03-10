/**
 * Stuck Detection — Behavioral loop detection for Claude Code agents
 *
 * Inspired by OpenHands' stuck detection. The existing system (supervisor.ts)
 * only detects stale agents by time/output-size. This module adds content-based
 * pattern recognition to catch agents that are producing output but looping,
 * oscillating, or monologuing without progress.
 *
 * 5 detection patterns:
 * 1. Identical action-observation repeated 4x        → kill
 * 2. Same error repeated 3x                          → triage
 * 3. Monologue without progress (no tool calls)       → triage
 * 4. Alternating two-action pattern (A,B,A,B,A,B)    → kill
 * 5. Repeated "I'll try a different approach" phrases → warning
 */

// ── Types ──────────────────────────────────────────────────

export interface StuckPattern {
  name: string;
  description: string;
  severity: 'warning' | 'kill' | 'triage'; // warning = log, kill = terminate, triage = send to AI
}

export interface StuckDetectionResult {
  isStuck: boolean;
  pattern?: StuckPattern;
  evidence?: string; // brief description of what was detected
}

// ── Pattern definitions ────────────────────────────────────

const PATTERNS: Record<string, StuckPattern> = {
  identicalAction: {
    name: 'identical_action_loop',
    description: 'Agent repeating the exact same action-observation cycle 4+ times',
    severity: 'kill',
  },
  repeatedError: {
    name: 'repeated_error',
    description: 'Same error message appearing 3+ times in output',
    severity: 'triage',
  },
  monologue: {
    name: 'monologue_without_progress',
    description: 'Agent producing text but no tool calls or file changes for 3+ chunks',
    severity: 'triage',
  },
  alternating: {
    name: 'alternating_pattern',
    description: 'Agent oscillating between two approaches (A,B,A,B,A,B)',
    severity: 'kill',
  },
  retryRhetoric: {
    name: 'retry_rhetoric',
    description: 'Agent repeatedly saying it will try a different approach without actual change',
    severity: 'warning',
  },
};

// ── Configuration ──────────────────────────────────────────

const CHUNK_SIZE = 500; // characters per sliding window chunk
const IDENTICAL_THRESHOLD = 4; // 4 identical consecutive chunks → kill
const ERROR_REPEAT_THRESHOLD = 3; // 3 identical errors → triage
const MONOLOGUE_CHUNK_COUNT = 3; // 3 chunks without tool calls → triage
const ALTERNATING_CYCLES = 3; // 3 full A-B cycles (6 chunks) → kill
const RETRY_PHRASE_THRESHOLD = 4; // 4 "try different approach" phrases → warning

// Minimum output length before we start checking (agents need ramp-up time)
const MIN_OUTPUT_LENGTH = 3000;

// ── Per-goal tracking (for incremental analysis) ───────────

interface GoalTracking {
  lastAnalyzedLength: number;
}

const goalTracking = new Map<string, GoalTracking>();

// ── Utility functions ──────────────────────────────────────

/**
 * Simple string hash — djb2 algorithm. Fast enough for chunk comparison,
 * no need for crypto.
 */
function hashChunk(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0; // hash * 33 + char
  }
  return hash;
}

/**
 * Normalize text for comparison: collapse whitespace, lowercase, strip
 * timestamps and line numbers that change between otherwise-identical actions.
 */
function normalize(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, '') // timestamps
    .replace(/:\d+:\d+/g, '') // line:col references
    .replace(/\b0x[0-9a-f]+\b/gi, '') // hex addresses
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim()
    .toLowerCase();
}

/**
 * Split output into chunks of approximately CHUNK_SIZE characters,
 * breaking on newlines when possible.
 */
function chunkOutput(output: string): string[] {
  const chunks: string[] = [];
  let remaining = output;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }

    // Try to break on a newline near the chunk boundary
    let breakPoint = remaining.lastIndexOf('\n', CHUNK_SIZE);
    if (breakPoint < CHUNK_SIZE * 0.3) {
      // No good newline break — just use the raw size
      breakPoint = CHUNK_SIZE;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint);
  }

  return chunks;
}

// ── Tool/progress indicators ───────────────────────────────

/**
 * Patterns that indicate the agent is actually doing something (tool calls,
 * file operations, git activity). Absence of these = monologue.
 */
const TOOL_INDICATORS = [
  /\b(?:Read|Edit|Write|Bash|Grep|Glob|ToolSearch|WebFetch|WebSearch)\b/, // Claude Code tools
  /\bgit (?:add|commit|push|checkout|diff|merge|rebase|stash)\b/,        // git operations
  /\b(?:npm|pnpm|yarn|node|npx|tsc|tsx)\b/,                              // build tools
  /\b(?:cat|ls|mkdir|cp|mv|rm|sed|awk|grep|find)\b/,                     // shell commands
  /\b(?:python|pip|pytest|uvicorn)\b/,                                    // python tools
  /\bcd \/[^\s]+/,                                                        // cd to absolute path
  /^[+\-]{3} [ab]\//m,                                                    // diff headers
  /^\+[^+]/m,                                                             // diff additions (after first 3 lines)
  /GOAL_COMPLETE/,                                                        // completion signal
  /BLOCKED:/,                                                             // blocked signal
  /ESCALATE:/,                                                            // escalation signal
];

function hasToolActivity(text: string): boolean {
  return TOOL_INDICATORS.some(pattern => pattern.test(text));
}

// ── Error extraction ───────────────────────────────────────

/**
 * Common error patterns in agent output. We extract and normalize them
 * to detect repeated identical errors.
 */
const ERROR_PATTERNS = [
  /(?:Error|ERROR): .+/g,
  /(?:FAILED|FAIL): .+/g,
  /(?:command failed|exited with code \d+).*/gi,
  /(?:TypeError|ReferenceError|SyntaxError|RangeError): .+/g,
  /(?:ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT): .+/g,
  /Traceback \(most recent call last\)[\s\S]*?(?:Error|Exception): .+/g,
  /^\s*at .+\(.+:\d+:\d+\)/gm, // stack trace lines (used as group)
];

/**
 * Extract normalized error strings from output.
 */
function extractErrors(text: string): string[] {
  const errors: string[] = [];
  for (const pattern of ERROR_PATTERNS) {
    // Reset lastIndex for global regexps
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        errors.push(normalize(match));
      }
    }
  }
  return errors;
}

// ── "Try different approach" phrases ───────────────────────

const RETRY_PHRASES = [
  /let me try (?:a )?(?:different|another|new)/gi,
  /(?:different|alternative|another) approach/gi,
  /(?:try|attempt) (?:a )?(?:different|another|new) (?:approach|method|strategy|way|technique)/gi,
  /let me (?:reconsider|rethink|step back)/gi,
  /(?:i'll|i will|let me) (?:try|attempt) (?:something|this) (?:else|differently)/gi,
  /(?:instead|alternatively),? (?:let me|i'll|i will|i can)/gi,
];

function countRetryPhrases(text: string): number {
  let count = 0;
  for (const pattern of RETRY_PHRASES) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

// ── Detection functions ────────────────────────────────────

/**
 * Pattern 1: Identical action-observation repeated 4x
 *
 * Hash sliding windows of output and check for IDENTICAL_THRESHOLD+
 * consecutive identical hashes. This catches agents doing the exact same
 * read-edit-run cycle over and over.
 */
function detectIdenticalLoop(chunks: string[]): StuckDetectionResult {
  if (chunks.length < IDENTICAL_THRESHOLD) {
    return { isStuck: false };
  }

  const hashes = chunks.map(c => hashChunk(normalize(c)));

  let consecutiveCount = 1;
  for (let i = 1; i < hashes.length; i++) {
    if (hashes[i] === hashes[i - 1]) {
      consecutiveCount++;
      if (consecutiveCount >= IDENTICAL_THRESHOLD) {
        const sample = chunks[i].slice(0, 120).replace(/\n/g, ' ');
        return {
          isStuck: true,
          pattern: PATTERNS.identicalAction,
          evidence: `${consecutiveCount} consecutive identical chunks (~${CHUNK_SIZE} chars each). Sample: "${sample}..."`,
        };
      }
    } else {
      consecutiveCount = 1;
    }
  }

  return { isStuck: false };
}

/**
 * Pattern 2: Same error repeated 3x
 *
 * Extract error messages, normalize them, and check for 3+ identical ones.
 * This catches agents hitting the same build/test error and retrying
 * without meaningful changes.
 */
function detectRepeatedErrors(output: string): StuckDetectionResult {
  const errors = extractErrors(output);
  if (errors.length < ERROR_REPEAT_THRESHOLD) {
    return { isStuck: false };
  }

  // Count occurrences of each normalized error
  const counts = new Map<string, number>();
  for (const err of errors) {
    // Skip very short error strings (too generic to be meaningful)
    if (err.length < 15) continue;
    counts.set(err, (counts.get(err) || 0) + 1);
  }

  for (const [error, count] of counts) {
    if (count >= ERROR_REPEAT_THRESHOLD) {
      return {
        isStuck: true,
        pattern: PATTERNS.repeatedError,
        evidence: `Error appeared ${count} times: "${error.slice(0, 150)}"`,
      };
    }
  }

  return { isStuck: false };
}

/**
 * Pattern 3: Monologue without progress
 *
 * Agent producing text but no tool calls, file edits, or git activity
 * for 3+ consecutive chunks. This catches agents "thinking out loud"
 * without taking action.
 */
function detectMonologue(chunks: string[]): StuckDetectionResult {
  if (chunks.length < MONOLOGUE_CHUNK_COUNT) {
    return { isStuck: false };
  }

  // Check the most recent chunks — we care about current state, not history
  const recentChunks = chunks.slice(-MONOLOGUE_CHUNK_COUNT * 2);
  let consecutiveNoTool = 0;
  let maxConsecutiveNoTool = 0;

  for (const chunk of recentChunks) {
    if (hasToolActivity(chunk)) {
      consecutiveNoTool = 0;
    } else {
      consecutiveNoTool++;
      maxConsecutiveNoTool = Math.max(maxConsecutiveNoTool, consecutiveNoTool);
    }
  }

  if (maxConsecutiveNoTool >= MONOLOGUE_CHUNK_COUNT) {
    const textLength = recentChunks.slice(-MONOLOGUE_CHUNK_COUNT).join('').length;
    return {
      isStuck: true,
      pattern: PATTERNS.monologue,
      evidence: `${maxConsecutiveNoTool} consecutive chunks (~${textLength} chars) with no tool calls or file operations`,
    };
  }

  return { isStuck: false };
}

/**
 * Pattern 4: Alternating two-action pattern (A,B,A,B,A,B)
 *
 * Agent oscillating between two approaches. Hash chunks and check for
 * an alternating pattern over 3+ full cycles.
 */
function detectAlternating(chunks: string[]): StuckDetectionResult {
  const minChunks = ALTERNATING_CYCLES * 2; // Need 2 chunks per cycle
  if (chunks.length < minChunks) {
    return { isStuck: false };
  }

  const hashes = chunks.map(c => hashChunk(normalize(c)));

  // Slide through looking for A,B,A,B,A,B patterns
  for (let start = 0; start <= hashes.length - minChunks; start++) {
    const a = hashes[start];
    const b = hashes[start + 1];

    // A and B must be different (otherwise pattern 1 catches it)
    if (a === b) continue;

    let cycles = 1; // Already have one A,B pair
    for (let i = start + 2; i < hashes.length - 1; i += 2) {
      if (hashes[i] === a && hashes[i + 1] === b) {
        cycles++;
        if (cycles >= ALTERNATING_CYCLES) {
          return {
            isStuck: true,
            pattern: PATTERNS.alternating,
            evidence: `Alternating pattern detected: ${cycles} cycles of two distinct action sequences`,
          };
        }
      } else {
        break; // Pattern broken
      }
    }
  }

  return { isStuck: false };
}

/**
 * Pattern 5: Repeated "I'll try a different approach"
 *
 * Agent claiming it will try something new 4+ times — a soft signal
 * that it's running out of ideas but hasn't stopped.
 */
function detectRetryRhetoric(output: string): StuckDetectionResult {
  const count = countRetryPhrases(output);

  if (count >= RETRY_PHRASE_THRESHOLD) {
    return {
      isStuck: true,
      pattern: PATTERNS.retryRhetoric,
      evidence: `Found ${count} "try a different approach" phrases in output`,
    };
  }

  return { isStuck: false };
}

// ── Main detection function ────────────────────────────────

/**
 * Analyze output for stuck patterns. Takes the full accumulated output.
 *
 * Runs all 5 detection patterns in severity order (kill first, then triage,
 * then warning). Returns the first match found — higher severity patterns
 * take precedence.
 *
 * Patterns are ordered by severity so a `kill` pattern is returned over a
 * `triage` pattern if both match. Within the same severity, the first match
 * wins.
 */
export function detectStuckPatterns(output: string): StuckDetectionResult {
  // Don't analyze too-short output — agent needs time to ramp up
  if (output.length < MIN_OUTPUT_LENGTH) {
    return { isStuck: false };
  }

  const chunks = chunkOutput(output);

  // Run detections in severity order: kill → triage → warning
  // This ensures we return the most actionable result

  // Kill-severity patterns
  const identicalResult = detectIdenticalLoop(chunks);
  if (identicalResult.isStuck) return identicalResult;

  const alternatingResult = detectAlternating(chunks);
  if (alternatingResult.isStuck) return alternatingResult;

  // Triage-severity patterns
  const errorResult = detectRepeatedErrors(output);
  if (errorResult.isStuck) return errorResult;

  const monologueResult = detectMonologue(chunks);
  if (monologueResult.isStuck) return monologueResult;

  // Warning-severity patterns
  const retryResult = detectRetryRhetoric(output);
  if (retryResult.isStuck) return retryResult;

  return { isStuck: false };
}

/**
 * Reset tracking for a goal (call when goal completes or is killed).
 */
export function resetStuckTracking(goalId: string): void {
  goalTracking.delete(goalId);
}
