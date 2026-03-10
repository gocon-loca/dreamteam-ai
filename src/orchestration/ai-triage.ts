/**
 * AI-Powered Triage for Stalled Agents
 *
 * Instead of killing stalled agents immediately, this module sends the last
 * portion of their output to Claude --print (haiku) for a quick assessment:
 * should the agent be retried, terminated, or given more time?
 *
 * Cost: ~$0.01 per triage call (haiku model).
 * Timeout: 30 seconds max.
 */

import { execSync } from 'child_process';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { resolveModel, getCliConfig } from './model-config.js';

export type TriageDecision = 'retry' | 'terminate' | 'extend';

export interface TriageResult {
  decision: TriageDecision;
  reason: string;
  suggestedGuidance?: string; // If retry, what to tell the agent
}

const MAX_ATTEMPTS = 3;

function buildTriagePrompt(
  goalTitle: string,
  project: string,
  recentOutput: string,
  elapsedMinutes: number,
  attemptNumber: number,
): string {
  return `You are triaging a stuck coding agent. The agent has been working on a goal but appears to have stalled (no new output for an extended period).

Goal: ${goalTitle} (${project})
Running for: ${elapsedMinutes} minutes (attempt ${attemptNumber}/${MAX_ATTEMPTS})

Last output from agent:
---
${recentOutput}
---

Based on the output, decide:
- RETRY: if the agent is stuck on something specific and could succeed with different guidance (e.g., wrong approach, fixable error, missing context)
- TERMINATE: if the agent is fundamentally stuck (e.g., circular logic, impossible task, repeated identical errors, surrendered)
- EXTEND: if the agent appears to be making genuine progress but is just slow (e.g., running tests, installing dependencies, large compilation)

Respond with EXACTLY one line in the format: DECISION: reason
Where DECISION is one of RETRY, TERMINATE, or EXTEND.

If RETRY, add a second line: GUIDANCE: specific advice for the next attempt`;
}

function parseTriageResponse(response: string): TriageResult {
  const trimmed = response.trim();
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    return { decision: 'terminate', reason: 'Empty triage response' };
  }

  const firstLine = lines[0];

  // Match RETRY: reason, TERMINATE: reason, or EXTEND: reason
  const match = firstLine.match(/^(RETRY|TERMINATE|EXTEND):\s*(.+)$/i);
  if (!match) {
    return {
      decision: 'terminate',
      reason: `Unparseable triage response: ${firstLine.slice(0, 200)}`,
    };
  }

  const rawDecision = match[1].toUpperCase() as 'RETRY' | 'TERMINATE' | 'EXTEND';
  const reason = match[2].trim();

  const decisionMap: Record<string, TriageDecision> = {
    RETRY: 'retry',
    TERMINATE: 'terminate',
    EXTEND: 'extend',
  };
  const decision = decisionMap[rawDecision];

  // Extract guidance if present (for RETRY decisions)
  let suggestedGuidance: string | undefined;
  if (decision === 'retry' && lines.length > 1) {
    const guidanceLine = lines.find((l) => /^GUIDANCE:\s*/i.test(l));
    if (guidanceLine) {
      suggestedGuidance = guidanceLine.replace(/^GUIDANCE:\s*/i, '').trim();
    }
  }

  return { decision, reason, suggestedGuidance };
}

/**
 * Send the tail of an agent's output to Claude for triage.
 * Uses claude --print with haiku model for cost efficiency (~$0.01 per triage).
 * Returns a decision within 30 seconds.
 */
export async function triageStuckAgent(
  goalId: string,
  project: string,
  goalTitle: string,
  recentOutput: string,
  elapsedMinutes: number,
  attemptNumber: number,
): Promise<TriageResult> {
  const prompt = buildTriagePrompt(
    goalTitle,
    project,
    recentOutput.slice(-2000), // Ensure we only send last ~2000 chars
    elapsedMinutes,
    attemptNumber,
  );

  try {
    const cli = getCliConfig();
    const model = resolveModel('ancillary');
    const result = execSync(
      `${cli.command} ${cli.flags.join(' ')} -m ${model} -p ${JSON.stringify(prompt)}`,
      {
        timeout: 30_000,
        env: cleanEnvForClaude(),
        stdio: ['pipe', 'pipe', 'pipe'], // Suppress stderr noise
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024, // 1MB
      },
    );

    return parseTriageResponse(result);
  } catch (err: unknown) {
    // Timeout, CLI error, or any other failure — default to terminate (fail-safe)
    const message =
      err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('ETIMEDOUT') || message.includes('timed out');

    return {
      decision: 'terminate',
      reason: isTimeout
        ? 'Triage call timed out (30s) — defaulting to terminate'
        : `Triage call failed: ${message.slice(0, 200)} — defaulting to terminate`,
    };
  }
}
