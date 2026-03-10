/**
 * Named failure modes for agent anti-pattern detection.
 *
 * Instead of generic surrender detection (regex matching on "unfixable", "impossible"),
 * this module defines specific, named anti-patterns that agents should avoid AND that
 * post-completion review can detect. Each failure mode carries retry guidance so the
 * next attempt gets actionable coaching.
 */

export interface FailureMode {
  name: string;
  description: string;
  /** Patterns in agent output that indicate this failure mode */
  detectionPatterns: RegExp[];
  /** Severity: reject = reject the goal, warn = flag but allow, info = log only */
  severity: 'reject' | 'warn' | 'info';
  /** Guidance text added to retry prompt when detected */
  retryGuidance: string;
}

export interface FailureModeMatch {
  mode: FailureMode;
  matchedPattern: string;
  /** Location in output where detected (char offset from start of scanned region) */
  offset: number;
}

// ---------------------------------------------------------------------------
// Built-in failure modes
// ---------------------------------------------------------------------------

const SCOPE_CREEP: FailureMode = {
  name: 'SCOPE_CREEP',
  description: 'Agent modifies files or adds features not requested',
  detectionPatterns: [
    /while I was at it/i,
    /I also noticed/i,
    /bonus:/i,
    /additionally,?\s+I/i,
    /I went ahead and/i,
  ],
  severity: 'warn',
  retryGuidance: 'Only modify what the goal specifically asks for. Do not fix, refactor, or improve anything outside the stated scope.',
};

const SILENT_FAILURE: FailureMode = {
  name: 'SILENT_FAILURE',
  description: 'Agent signals complete without testing or verifying',
  detectionPatterns: [
    /should work/i,
    /ought to fix/i,
    /this should resolve/i,
    /I believe this fixes/i,
    /that should take care of/i,
    /this will likely fix/i,
  ],
  severity: 'warn',
  retryGuidance: 'You must verify your changes work before signaling GOAL_COMPLETE. Run the code, check the output, confirm the fix.',
};

const UNFOUNDED_COMPLETION: FailureMode = {
  name: 'UNFOUNDED_COMPLETION',
  description: 'Agent declares done with partial work or surrenders disguised as completion',
  detectionPatterns: [
    // Existing surrender patterns from task-runner.ts / goal-manager.ts
    /unfixable/i,
    /impossible to (?:fix|resolve|repair|solve)/i,
    /cannot (?:be )?(?:fixed|resolved|repaired|solved)/i,
    /unable to (?:fix|resolve|repair|solve) (?:this|the|any)/i,
    /GOAL_COMPLETE\s*\(partial\)/i,
    /(?:this|the) (?:issue|bug|problem) (?:is |appears )?(?:in|with) the (?:framework|library|dependency|build tool)/i,
    /recommend(?:ation)?:?\s*(?:file a bug|report|downgrade|upgrade)/i,
  ],
  severity: 'reject',
  retryGuidance: 'You cannot declare work impossible. Try at least 3 fundamentally different approaches before escalating.',
};

const CIRCULAR_REASONING: FailureMode = {
  name: 'CIRCULAR_REASONING',
  description: 'Agent going in circles, re-trying approaches that already failed',
  detectionPatterns: [
    /as I mentioned earlier/i,
    /going back to the original approach/i,
    /let me try the first approach again/i,
    /reverting to/i,
    /back to (?:the |my )?(?:original|initial|first|previous) (?:approach|solution|strategy|plan)/i,
    /let me go back to/i,
  ],
  severity: 'warn',
  retryGuidance: "You're repeating approaches that already failed. Try something fundamentally different. If you've exhausted 3+ distinct strategies, escalate with ESCALATE: describing what you tried.",
};

const DEPENDENCY_AVOIDANCE: FailureMode = {
  name: 'DEPENDENCY_AVOIDANCE',
  description: 'Agent removing features instead of fixing them',
  detectionPatterns: [
    /removed the/i,
    /deleted the/i,
    /commented out/i,
    /disabled the/i,
    /skipped the/i,
  ],
  severity: 'warn',
  retryGuidance: 'The goal asks to FIX, not remove. Re-implement the feature correctly. Deleting or disabling broken code is not a fix.',
};

const CONFIG_ONLY: FailureMode = {
  name: 'CONFIG_ONLY',
  description: 'Agent only changes config or comments without real code fixes',
  detectionPatterns: [
    /updated the config/i,
    /added a comment/i,
    /documented the issue/i,
    /updated the documentation/i,
    /added documentation/i,
  ],
  severity: 'info',
  retryGuidance: 'Config-only changes rarely fix bugs. Make actual code changes that address the root cause.',
};

const BLIND_RETRY: FailureMode = {
  name: 'BLIND_RETRY',
  description: 'Agent retrying the exact same failed command without changing approach',
  detectionPatterns: [
    /let me try again/i,
    /running (?:it )?again/i,
    /let me retry/i,
    /trying again/i,
    /let me run (?:it|that|this) again/i,
  ],
  severity: 'info',
  retryGuidance: "Don't retry the same command expecting different results. Diagnose WHY it failed and change your approach.",
};

const PLACEHOLDER_CODE: FailureMode = {
  name: 'PLACEHOLDER_CODE',
  description: 'Agent leaving TODO/placeholder implementations instead of completing the work',
  detectionPatterns: [
    /\/\/\s*TODO/,
    /\/\/\s*FIXME/,
    /\/\/\s*HACK/,
    /#\s*TODO/,
    /#\s*FIXME/,
    /#\s*HACK/,
    /throw new Error\(['"]not implemented['"]\)/i,
    /pass\s+#\s*TODO/i,
    /raise NotImplementedError/i,
  ],
  severity: 'warn',
  retryGuidance: 'Do not leave placeholder code (TODO, FIXME, HACK, NotImplementedError). Implement fully or escalate with ESCALATE: explaining what is blocking you.',
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const BUILTIN_FAILURE_MODES: FailureMode[] = [
  SCOPE_CREEP,
  SILENT_FAILURE,
  UNFOUNDED_COMPLETION,
  CIRCULAR_REASONING,
  DEPENDENCY_AVOIDANCE,
  CONFIG_ONLY,
  BLIND_RETRY,
  PLACEHOLDER_CODE,
];

/** Get all built-in failure modes */
export function getBuiltinFailureModes(): FailureMode[] {
  return [...BUILTIN_FAILURE_MODES];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Maximum chars to scan from the end of output (avoids scanning huge outputs) */
const SCAN_LIMIT = 5000;

/**
 * Check agent output against all failure modes. Returns matches.
 *
 * Only scans the last SCAN_LIMIT chars of output for efficiency and to avoid
 * false positives from early-output explanations (e.g., "I removed the old approach
 * and replaced it with..." early on is fine, but at the end may signal deletion).
 */
export function detectFailureModes(output: string): FailureModeMatch[] {
  const region = output.length > SCAN_LIMIT
    ? output.slice(-SCAN_LIMIT)
    : output;

  const matches: FailureModeMatch[] = [];

  for (const mode of BUILTIN_FAILURE_MODES) {
    for (const pattern of mode.detectionPatterns) {
      const match = pattern.exec(region);
      if (match) {
        matches.push({
          mode,
          matchedPattern: match[0],
          offset: match.index,
        });
        // One match per mode is enough — don't duplicate the same failure mode
        break;
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Formatting for retry context
// ---------------------------------------------------------------------------

/**
 * Format detected failure modes into a prompt-ready block for retry context.
 *
 * Example output:
 * ```
 * ## Previous Attempt Failure Analysis
 * Your last attempt was flagged for the following issues:
 *
 * ### SCOPE_CREEP (warning)
 * You modified files outside the goal scope: "I also noticed the header was misaligned"
 * GUIDANCE: Only modify what the goal specifically asks for.
 *
 * ### SILENT_FAILURE (warning)
 * You completed without verifying: "this should resolve the issue"
 * GUIDANCE: You must verify your changes work before signaling GOAL_COMPLETE.
 * ```
 */
export function formatFailureContext(matches: FailureModeMatch[]): string {
  if (matches.length === 0) {
    return '';
  }

  const severityLabel: Record<FailureMode['severity'], string> = {
    reject: 'rejection',
    warn: 'warning',
    info: 'info',
  };

  const lines: string[] = [
    '## Previous Attempt Failure Analysis',
    'Your last attempt was flagged for the following issues:',
    '',
  ];

  for (const match of matches) {
    const label = severityLabel[match.mode.severity];
    lines.push(`### ${match.mode.name} (${label})`);
    lines.push(`${match.mode.description}: "${match.matchedPattern}"`);
    lines.push(`GUIDANCE: ${match.mode.retryGuidance}`);
    lines.push('');
  }

  return lines.join('\n');
}
