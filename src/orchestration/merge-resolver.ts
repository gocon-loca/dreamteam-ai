/**
 * Merge Resolver — 4-tier merge conflict resolution system
 *
 * Inspired by Overstory's approach to progressive escalation.
 * Each tier is tried in order; if it fails, the merge is aborted and the next tier tried.
 *
 * Tier 1: Clean merge (git merge --no-ff)
 * Tier 2: Auto-resolve (git merge -X theirs — keeps feature branch changes on conflict)
 * Tier 3: AI-resolve (Sonnet resolves conflict markers per-file)
 * Tier 4: Reimagine (fallback to cherry-pick — logs that full reimagine was needed)
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { resolveModel, getCliConfig } from './model-config.js';

// ── Types ──────────────────────────────────────────────────

export interface MergeResult {
  success: boolean;
  tier: 'clean' | 'auto-resolve' | 'ai-resolve' | 'reimagine';
  filesResolved?: string[];
  error?: string;
}

// ── Guards ─────────────────────────────────────────────────

/** Prose starters that indicate the model returned an explanation instead of file content. */
const PROSE_PREFIXES = [
  'I ',
  'Here\'s',
  'Here is',
  'The ',
  'This ',
  'Sure',
  'Certainly',
  'Of course',
  'Below',
  'Let me',
];

/**
 * Check if text looks like conversational prose rather than file content.
 * Used to validate AI-resolve output — we need raw file content, not an explanation.
 */
export function looksLikeProse(text: string): boolean {
  const trimmed = text.trimStart();
  return PROSE_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

// ── Helpers ────────────────────────────────────────────────

function sanitizeTitle(title: string): string {
  return title.replace(/"/g, '\\"').slice(0, 60);
}

function abortMerge(cwd: string): void {
  try {
    execSync('git merge --abort', { cwd, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { /* merge may not be in progress — safe to ignore */ }
}

function getConflictedFiles(cwd: string): string[] {
  try {
    const output = execSync('git diff --name-only --diff-filter=U', {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Invoke the CLI with the secondary tier model to resolve conflicts.
 * Uses clean env to avoid nested-session detection.
 */
function claudeResolve(prompt: string, timeoutMs: number): string {
  const cli = getCliConfig();
  const model = resolveModel('secondary');
  const escaped = prompt.replace(/'/g, "'\\''");
  return execSync(
    `echo '${escaped}' | ${cli.command} ${cli.flags.join(' ')} -m ${model}`,
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: cleanEnvForClaude(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
}

// ── Tier 1: Clean Merge ────────────────────────────────────

function tryCleanMerge(cwd: string, featureBranch: string, title: string): MergeResult | null {
  try {
    execSync(
      `git merge ${featureBranch} --no-ff -m "merge: ${sanitizeTitle(title)}"`,
      { cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    console.log(`[MergeResolver] Tier 1 (clean merge) succeeded for ${featureBranch}`);
    return { success: true, tier: 'clean' };
  } catch {
    abortMerge(cwd);
    console.log(`[MergeResolver] Tier 1 (clean merge) failed for ${featureBranch} — escalating`);
    return null;
  }
}

// ── Tier 2: Auto-resolve (-X theirs) ──────────────────────

function tryAutoResolve(cwd: string, featureBranch: string, title: string): MergeResult | null {
  try {
    execSync(
      `git merge ${featureBranch} --no-ff -m "merge: ${sanitizeTitle(title)}" -X theirs`,
      { cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    console.log(`[MergeResolver] Tier 2 (auto-resolve -X theirs) succeeded for ${featureBranch}`);
    return { success: true, tier: 'auto-resolve' };
  } catch {
    abortMerge(cwd);
    console.log(`[MergeResolver] Tier 2 (auto-resolve) failed for ${featureBranch} — escalating`);
    return null;
  }
}

// ── Tier 3: AI-resolve ─────────────────────────────────────

function tryAiResolve(cwd: string, featureBranch: string, title: string): MergeResult | null {
  // Start merge without auto-committing so we can inspect and resolve conflicts
  try {
    execSync(
      `git merge ${featureBranch} --no-ff --no-commit`,
      { cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // If this succeeds without error, there are no conflicts — commit and done
    execSync(
      `git commit -m "merge: ${sanitizeTitle(title)}"`,
      { cwd, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    console.log(`[MergeResolver] Tier 3 (ai-resolve) — no conflicts after --no-commit, committed`);
    return { success: true, tier: 'ai-resolve', filesResolved: [] };
  } catch {
    // Expected — conflicts exist, proceed with resolution
  }

  const conflicted = getConflictedFiles(cwd);
  if (conflicted.length === 0) {
    // No conflicts detected but merge command failed — unexpected state, bail out
    abortMerge(cwd);
    console.log(`[MergeResolver] Tier 3 — merge failed but no conflicted files found, aborting`);
    return null;
  }

  console.log(`[MergeResolver] Tier 3 — resolving ${conflicted.length} conflicted file(s) with AI: ${conflicted.join(', ')}`);

  const resolved: string[] = [];

  for (const file of conflicted) {
    const filePath = join(cwd, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      console.log(`[MergeResolver] Tier 3 — cannot read ${file}, aborting AI-resolve`);
      abortMerge(cwd);
      return null;
    }

    // Only process files that actually have conflict markers
    if (!content.includes('<<<<<<<') || !content.includes('>>>>>>>')) {
      // File is flagged as conflicted but has no markers — just git add it
      try {
        execSync(`git add "${file}"`, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
        resolved.push(file);
      } catch {
        abortMerge(cwd);
        return null;
      }
      continue;
    }

    const prompt = `Resolve this git merge conflict. Keep the feature branch changes (between ======= and >>>>>>>). Output ONLY the resolved file content, no explanations, no markdown fences.

${content}`;

    let resolvedContent: string;
    try {
      resolvedContent = claudeResolve(prompt, 60000);
    } catch (err) {
      console.log(`[MergeResolver] Tier 3 — AI resolve timed out or failed for ${file}: ${err}`);
      abortMerge(cwd);
      return null;
    }

    // Validate: must not be prose, must not contain conflict markers
    if (looksLikeProse(resolvedContent)) {
      console.log(`[MergeResolver] Tier 3 — AI returned prose instead of file content for ${file}, aborting`);
      abortMerge(cwd);
      return null;
    }

    if (resolvedContent.includes('<<<<<<<') || resolvedContent.includes('>>>>>>>')) {
      console.log(`[MergeResolver] Tier 3 — AI output still contains conflict markers for ${file}, aborting`);
      abortMerge(cwd);
      return null;
    }

    // Strip markdown code fences if present (model sometimes wraps output)
    resolvedContent = stripCodeFences(resolvedContent);

    // Write resolved content and stage
    try {
      writeFileSync(filePath, resolvedContent, 'utf8');
      execSync(`git add "${file}"`, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
      resolved.push(file);
      console.log(`[MergeResolver] Tier 3 — resolved ${file}`);
    } catch (err) {
      console.log(`[MergeResolver] Tier 3 — failed to write/stage ${file}: ${err}`);
      abortMerge(cwd);
      return null;
    }
  }

  // All files resolved — commit
  try {
    execSync(
      `git commit -m "merge: ${sanitizeTitle(title)} (AI-resolved conflicts)"`,
      { cwd, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    console.log(`[MergeResolver] Tier 3 (ai-resolve) succeeded — resolved ${resolved.length} file(s)`);
    return { success: true, tier: 'ai-resolve', filesResolved: resolved };
  } catch (err) {
    console.log(`[MergeResolver] Tier 3 — commit failed after resolving: ${err}`);
    abortMerge(cwd);
    return null;
  }
}

// ── Tier 4: Reimagine (cherry-pick fallback) ───────────────

function tryReimagine(cwd: string, featureBranch: string, title: string): MergeResult {
  // Tier 4 is the last resort. For now, fall back to the existing cherry-pick approach
  // which picks individual commits and skips any that conflict.
  // A full "reimagine" (sending diff to AI to reimplement on main) is logged as needed
  // but too expensive/complex for automated use today.

  console.log(`[MergeResolver] Tier 4 (reimagine) — falling back to cherry-pick for ${featureBranch}`);

  // Make sure any in-progress merge is aborted
  abortMerge(cwd);

  let branchCommits: string;
  try {
    branchCommits = execSync(
      `git log --oneline ${featureBranch} --not main`,
      { cwd, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return { success: false, tier: 'reimagine', error: 'Could not list branch commits' };
  }

  if (!branchCommits) {
    return { success: false, tier: 'reimagine', error: 'No commits on branch to cherry-pick' };
  }

  const hashes = branchCommits.split('\n').map(line => line.split(' ')[0]).reverse(); // oldest first
  const picked: string[] = [];
  const skipped: string[] = [];

  for (const hash of hashes) {
    try {
      execSync(`git cherry-pick ${hash}`, { cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      picked.push(hash);
    } catch {
      try {
        execSync('git cherry-pick --abort', { cwd, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { /* ignore */ }
      skipped.push(hash);
      console.log(`[MergeResolver] Tier 4 — skipped conflicting commit ${hash}`);
    }
  }

  console.log(`[MergeResolver] Tier 4 — cherry-picked ${picked.length}/${hashes.length} commits (${skipped.length} skipped)`);

  // Consider it a success if at least some commits were picked
  const success = picked.length > 0;
  return {
    success,
    tier: 'reimagine',
    filesResolved: picked,
    error: skipped.length > 0
      ? `Skipped ${skipped.length} conflicting commit(s): ${skipped.join(', ')}`
      : undefined,
  };
}

// ── Utility ────────────────────────────────────────────────

/**
 * Strip leading/trailing markdown code fences if the AI wrapped its output.
 * Handles ```lang\n...\n``` patterns.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // Match opening fence (``` or ```lang) and closing fence
  const fencePattern = /^```[^\n]*\n([\s\S]*?)\n```$/;
  const match = trimmed.match(fencePattern);
  return match ? match[1] : trimmed;
}

// ── Main Entry Point ───────────────────────────────────────

/**
 * Attempt to merge a feature branch into main using 4-tier escalation.
 * Each tier is tried in order; if it fails, the merge is aborted and the next tier tried.
 *
 * Assumes the working directory is already on the `main` branch with a clean tree.
 *
 * @param cwd - Project working directory
 * @param featureBranch - Branch name (e.g., "goal/goal-abc123")
 * @param goalTitle - Goal title for commit messages
 * @returns MergeResult with which tier succeeded (or failure)
 */
export async function smartMerge(
  cwd: string,
  featureBranch: string,
  goalTitle: string,
): Promise<MergeResult> {
  console.log(`[MergeResolver] Starting 4-tier merge: ${featureBranch} into main at ${cwd}`);

  // Tier 1: Clean merge
  const tier1 = tryCleanMerge(cwd, featureBranch, goalTitle);
  if (tier1) return tier1;

  // Tier 2: Auto-resolve with -X theirs
  const tier2 = tryAutoResolve(cwd, featureBranch, goalTitle);
  if (tier2) return tier2;

  // Tier 3: AI-resolve conflicted files individually
  const tier3 = tryAiResolve(cwd, featureBranch, goalTitle);
  if (tier3) return tier3;

  // Tier 4: Reimagine — cherry-pick fallback
  const tier4 = tryReimagine(cwd, featureBranch, goalTitle);
  return tier4;
}
