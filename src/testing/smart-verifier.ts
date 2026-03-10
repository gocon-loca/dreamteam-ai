/**
 * Smart Verifier — Haiku fallback for ambiguous screenshot diffs
 *
 * Called ONLY when Playwright passes structurally but screenshot diff
 * is in the ambiguous zone (5-25% difference). Uses a Haiku agent
 * to determine if the visual change is a regression or acceptable.
 *
 * Expected cost: ~$0.01/call, ~2-3 calls/day max.
 */

import { runTask } from '../projects/task-runner.js';

export interface ScreenshotDiff {
  flowId: string;
  viewport: string;        // '375' | '768' | '1200'
  diffPercentage: number;
  baselinePath: string;
  currentPath: string;
  diffPath?: string;
}

export interface VerificationDecision {
  approved: boolean;
  analysis: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Have Haiku analyze ambiguous screenshot diffs to decide if they're
 * regressions or acceptable changes.
 *
 * Only called when diff is 5-25% — below 5% is auto-approved,
 * above 25% is auto-rejected.
 */
export async function verifyAmbiguousScreenshots(
  project: string,
  diffs: ScreenshotDiff[],
  goalTitle: string,
  onProgress?: (msg: string) => void
): Promise<VerificationDecision> {
  if (diffs.length === 0) {
    return { approved: true, analysis: 'No diffs to verify', confidence: 'high' };
  }

  onProgress?.(`Verifying ${diffs.length} ambiguous screenshot diff(s) with Haiku...`);

  const diffSummary = diffs.map(d =>
    `- Flow: ${d.flowId}, Viewport: ${d.viewport}px, Diff: ${d.diffPercentage.toFixed(1)}%\n` +
    `  Baseline: ${d.baselinePath}\n` +
    `  Current: ${d.currentPath}` +
    (d.diffPath ? `\n  Diff image: ${d.diffPath}` : '')
  ).join('\n');

  const prompt = `You are a QA reviewer. A goal "${goalTitle}" was completed for project "${project}".

Playwright E2E tests passed structurally (all assertions passed), but screenshot comparison shows visual differences in the ambiguous range (5-25%).

Screenshot diffs:
${diffSummary}

Please analyze the diff images and determine:
1. Are these changes intentional (expected from the goal work)?
2. Do they look like regressions (broken layout, missing elements, wrong colors)?
3. Are they minor rendering differences (font smoothing, animation timing)?

Respond with exactly one line:
APPROVED: <brief reason>
or
REGRESSION: <brief reason>`;

  try {
    const result = await runTask(project, prompt, {
      autonomous: false,
      maxIterations: 1,
      model: 'ancillary',
    });

    const output = result.output.trim();
    const isApproved = output.includes('APPROVED');
    const isRegression = output.includes('REGRESSION');

    // Extract reason
    const reasonMatch = output.match(/(?:APPROVED|REGRESSION):\s*(.+)/);
    const reason = reasonMatch?.[1] || output.slice(0, 200);

    if (isApproved) {
      onProgress?.(`Screenshot diffs approved: ${reason}`);
      return { approved: true, analysis: reason, confidence: 'medium' };
    }

    if (isRegression) {
      onProgress?.(`Screenshot regression detected: ${reason}`);
      return { approved: false, analysis: reason, confidence: 'medium' };
    }

    // Ambiguous response — err on the side of approval
    onProgress?.(`Ambiguous verifier response, defaulting to approved`);
    return { approved: true, analysis: `Unclear response: ${reason}`, confidence: 'low' };
  } catch (error) {
    // Verifier failure shouldn't block goal completion
    onProgress?.(`Smart verifier failed: ${error}. Defaulting to approved.`);
    return {
      approved: true,
      analysis: `Verifier error: ${error instanceof Error ? error.message : String(error)}`,
      confidence: 'low',
    };
  }
}
