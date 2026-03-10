/**
 * Goal completion validation — Gate 0 sanity check.
 *
 * FREE (no LLM) — catches obvious failures before spending tokens
 * on review agent or smoke test.
 */

import { execSync } from 'child_process';
import { getProject } from '../projects/registry.js';
import { detectFailureModes, formatFailureContext } from './failure-modes.js';
import type { Goal } from './goal-types.js';

// Surrender patterns that indicate the agent gave up rather than completing.
// Only tested against the LAST 1000 chars of output (near the conclusion),
// not the entire output — agents commonly say "X was out of scope" or "partially
// completed Y before moving on" as legitimate progress descriptions early in output.
export const COMPLETION_SURRENDER_PATTERNS = [
  /unfixable/i,
  /impossible to (?:fix|resolve|repair|solve)/i,
  /cannot (?:be )?(?:fixed|resolved|repaired|solved)/i,
  /GOAL_COMPLETE\s*\(partial\)/i,
  /recommend(?:ation)?:?\s*(?:file a bug|report|downgrade|upgrade)/i,
  // Removed: "partially complete", "out of scope" — too many false positives
];

export interface CompletionValidation {
  valid: boolean;
  reasons: string[];
  /** Failure mode warnings (not hard rejections) to include in retry context */
  failureModeContext?: string;
}

/**
 * Validate that agent output actually meets the goal's acceptance criteria.
 * Returns { valid: true } if output looks legitimate, or { valid: false, reasons }
 * if the agent appears to have surrendered or left criteria unmet.
 *
 * These checks are FREE (no LLM) — catch obvious failures before spending
 * tokens on review agent or smoke test.
 */
export function validateCompletion(goal: Goal, agentOutput: string): CompletionValidation {
  const reasons: string[] = [];
  const project = getProject(goal.project);

  // Check 1: Surrender patterns — only check the last 1000 chars (near conclusion)
  // Early mentions like "X was out of scope so I focused on Y" are legitimate.
  const tailOutput = agentOutput.slice(-1000);
  for (const pattern of COMPLETION_SURRENDER_PATTERNS) {
    if (pattern.test(tailOutput)) {
      reasons.push(`Surrender pattern detected: "${pattern}"`);
    }
  }

  // Check 2: Empty diff — agent said GOAL_COMPLETE but no code was committed.
  // Catches: "diff never applied", agent hallucinated changes, working tree reset.
  // This alone caught 6/17 review rejections on Mar 2 that previously cost a full
  // Sonnet review call each to detect.
  let branchDiffFiles: string[] = [];
  if (project?.path) {
    try {
      const nameOnly = execSync(
        `git diff main...goal/${goal.id} --name-only 2>/dev/null || true`,
        { cwd: project.path, encoding: 'utf8', timeout: 5000 }
      ).trim();
      branchDiffFiles = nameOnly ? nameOnly.split('\n').filter(Boolean) : [];
    } catch { /* can't check — skip */ }

    if (branchDiffFiles.length === 0 && agentOutput.length > 80) {
      // Agent produced substantial output but zero files changed on branch
      reasons.push('Agent signaled GOAL_COMPLETE but no files changed on branch (empty diff vs main)');
    }
  }

  // Check 3: Output too short for a completed goal (likely agent gave up early)
  // BUT: on retry attempts, the agent may see prior work already committed and
  // produce a short "already done" output. Check if the branch has real commits.
  if (agentOutput.length < 80 && !agentOutput.includes('ESCALATE:')) {
    if (branchDiffFiles.length === 0) {
      reasons.push(`Output suspiciously short (${agentOutput.length} chars) for a completed goal`);
    } else {
      console.log(`[Validation] Short output (${agentOutput.length} chars) but branch goal/${goal.id} has committed work — allowing`);
    }
  }

  // Check 4: Named failure modes — detect anti-patterns in output
  let failureModeContext: string | undefined;
  const failureModes = detectFailureModes(agentOutput);
  if (failureModes.length > 0) {
    const rejections = failureModes.filter(m => m.mode.severity === 'reject');
    const warnings = failureModes.filter(m => m.mode.severity !== 'reject');

    for (const fm of rejections) {
      reasons.push(`Failure mode ${fm.mode.name}: "${fm.matchedPattern}"`);
    }
    if (warnings.length > 0) {
      console.log(`[Validation] Failure mode warnings for "${goal.title}": ${warnings.map(w => w.mode.name).join(', ')}`);
    }
    // Store formatted context for retry prompt (includes both rejections and warnings)
    failureModeContext = formatFailureContext(failureModes);
  }

  // Check 5: Fabrication detection — agent claims to have created/modified files that
  // don't appear in the actual git diff. Catches agents that signal GOAL_COMPLETE and
  // describe work in their debrief but never actually committed the code.
  // This pattern cost $5.97 on a single goal (pane-manager: 5 runs, all fabricated).
  if (project?.path && branchDiffFiles.length >= 0) {
    // Extract filenames the agent claims to have created/modified from output.
    // Matches: backtick-quoted filenames, "filesModified" JSON arrays, and
    // prose patterns like "Created src/foo.ts" or "Added PaneManager.tsx"
    const claimedFiles = new Set<string>();

    // Pattern 1: JSON artifact format — "filesModified": ["file1.ts", "file2.tsx"]
    const artifactMatch = agentOutput.match(/"filesModified"\s*:\s*\[([^\]]*)\]/);
    if (artifactMatch) {
      for (const f of artifactMatch[1].split(',')) {
        const cleaned = f.replace(/["'\s]/g, '');
        if (cleaned.length > 0) claimedFiles.add(cleaned);
      }
    }

    // Pattern 2: Backtick-quoted filenames with code extensions in debrief
    const debriefSection = agentOutput.match(/---DEBRIEF---([\s\S]*?)---END_DEBRIEF---/)?.[1] || '';
    const backtickFiles = debriefSection.matchAll(/`([^`]*\.(?:ts|tsx|py|js|jsx|css|html|vue|svelte))`/g);
    for (const m of backtickFiles) {
      const name = m[1].replace(/^[`\s]+|[`\s]+$/g, '');
      if (name.length > 2 && name.length < 100 && !name.includes(' ')) claimedFiles.add(name);
    }

    // Only check if agent claimed multiple new files (single-file changes are fine)
    if (claimedFiles.size >= 3) {
      const diffBasenames = new Set(branchDiffFiles.map(f => f.split('/').pop()!.toLowerCase()));

      const missingFromDiff = [...claimedFiles].filter(f => {
        const basename = f.split('/').pop()!.toLowerCase();
        return !diffBasenames.has(basename);
      });

      // If most claimed files aren't in the diff, it's fabrication
      if (missingFromDiff.length >= 3 && missingFromDiff.length >= claimedFiles.size * 0.5) {
        reasons.push(
          `Fabrication detected: agent claims ${claimedFiles.size} files but ${missingFromDiff.length} are missing from git diff: ${missingFromDiff.slice(0, 5).join(', ')}`
        );
      }
    }
  }

  // Check 6: Verify claimed new files actually exist on the goal branch.
  // Even if files appear in the diff, verify they're real by checking git.
  // Catches agents that committed then reverted, or fabricated commit messages.
  if (project?.path && branchDiffFiles.length > 0) {
    const newFiles = branchDiffFiles.filter(f =>
      f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.py') ||
      f.endsWith('.js') || f.endsWith('.jsx')
    );

    // Only check a sample of new files (avoid slow git commands for large diffs)
    const filesToCheck = newFiles.slice(0, 10);
    const missingOnBranch: string[] = [];

    for (const f of filesToCheck) {
      try {
        execSync(`git show goal/${goal.id}:${f}`, {
          cwd: project.path, timeout: 3000, stdio: 'pipe',
        });
      } catch {
        // File is in diff but doesn't exist on branch — was added then deleted
        missingOnBranch.push(f);
      }
    }

    if (missingOnBranch.length >= 2 && missingOnBranch.length >= filesToCheck.length * 0.5) {
      reasons.push(
        `Files in diff but missing from branch: ${missingOnBranch.length} files were committed then apparently reverted: ${missingOnBranch.slice(0, 5).join(', ')}`
      );
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    failureModeContext,
  };
}
