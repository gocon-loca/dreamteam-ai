/**
 * Redesign Pipeline — Full audit → research → prototypes → consultation → goals
 *
 * Orchestrates the complete product intelligence pipeline:
 * 1. runAppAudit() — if stale
 * 2. runProductResearch() — if stale
 * 3. generatePrototypes() — always regenerated
 * 4. sendConsultation() — Telegram message with 3 options
 * 5. awaitUserChoice() — wait for reply
 * 6. generateFinalPrototype() — if hybrid requested
 * 7. decomposeIntoGoals() — create ux-consolidation goals
 *
 * Sessions stored at data/redesign-sessions/{project}.json
 */

import { spawn } from 'child_process';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { homedir } from 'os';
import { runAppAudit, isAuditStale, type AppAudit } from './app-audit.js';
import { runProductResearch, isResearchStale, type UxResearch } from './product-research.js';
import { generatePrototypes, generateFinalPrototype, getPrototypeBaseUrl, type PrototypeSet, type PrototypeOption } from './prototype-generator.js';
import { updateInventoryFromAudit } from './feature-inventory.js';
import { addGoal } from '../orchestration/goal-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const SESSIONS_DIR = join(DATA_DIR, 'redesign-sessions');

// ── Types ──────────────────────────────────────────────────

export interface RedesignSession {
  project: string;
  status: 'awaiting_choice' | 'generating_final' | 'awaiting_approval' | 'approved' | 'cancelled';
  audit: AppAudit;
  research: UxResearch;
  prototypes: PrototypeSet;
  userChoice?: string;
  finalPrototype?: string;
  approvedTabs?: string[];
  goals?: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Session Persistence ──────────────────────────────────────

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function saveSession(session: RedesignSession): void {
  ensureSessionsDir();
  session.updatedAt = new Date().toISOString();
  writeFileSync(
    join(SESSIONS_DIR, `${session.project}.json`),
    JSON.stringify(session, null, 2)
  );
}

export function getRedesignSession(project: string): RedesignSession | null {
  const filePath = join(SESSIONS_DIR, `${project}.json`);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function getActiveRedesignSession(projects: string[] | null): RedesignSession | null {
  const searchList = projects || [];
  for (const proj of searchList) {
    const session = getRedesignSession(proj);
    if (session && (session.status === 'awaiting_choice' || session.status === 'awaiting_approval')) {
      return session;
    }
  }
  return null;
}

// ── Main Pipeline ──────────────────────────────────────────

export async function runRedesignPipeline(
  projectName: string,
  sendTelegram: (msg: string) => Promise<void>,
): Promise<RedesignSession> {
  console.log(`[Redesign] Starting pipeline for ${projectName}`);

  // Step 1: Audit (if stale)
  let audit: AppAudit;
  if (isAuditStale(projectName)) {
    await sendTelegram(`Step 1/3: Running app audit...`);
    audit = await runAppAudit(projectName);
    updateInventoryFromAudit(projectName, audit);
  } else {
    const { getLatestAudit } = await import('./app-audit.js');
    audit = getLatestAudit(projectName)!;
    await sendTelegram(`Step 1/3: Using recent audit (${audit.pages.length} pages)`);
  }

  // Step 2: Research (if stale)
  let research: UxResearch;
  if (isResearchStale(projectName)) {
    await sendTelegram(`Step 2/3: Researching competitor apps...`);
    research = await runProductResearch(projectName);
  } else {
    const { getLatestResearch } = await import('./product-research.js');
    research = getLatestResearch(projectName)!;
    await sendTelegram(`Step 2/3: Using recent research (${research.competitors.length} competitors)`);
  }

  // Step 3: Generate prototypes (always fresh)
  await sendTelegram(`Step 3/3: Generating design prototypes...`);
  const prototypes = await generatePrototypes(projectName);

  // Create session
  const session: RedesignSession = {
    project: projectName,
    status: 'awaiting_choice',
    audit,
    research,
    prototypes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveSession(session);

  // Step 4: Send consultation message
  const consultationMsg = formatConsultation(projectName, prototypes, research);
  await sendTelegram(consultationMsg);

  return session;
}

// ── Consultation Message ──────────────────────────────────

function formatConsultation(
  projectName: string,
  prototypes: PrototypeSet,
  research: UxResearch,
): string {
  const lines: string[] = [];

  lines.push(`🎨 Redesign proposals for ${projectName}:`);
  lines.push('');

  for (const opt of prototypes.options) {
    const letter = opt.id.toUpperCase();
    const label = opt.label;
    lines.push(`Option ${letter} (${label}): ${opt.tabs.join(' | ')}`);
    lines.push(`→ ${opt.url}`);
    if (opt.inspiredBy.length > 0) {
      lines.push(`Inspired by ${opt.inspiredBy.join(', ')}.`);
    }
    lines.push('');
  }

  // Find the research-aligned option (B) for recommendation
  const optionB = prototypes.options.find(o => o.id === 'b');
  if (optionB) {
    lines.push(`💡 I recommend Option B because ${research.recommendation.rationale}`);
    lines.push('');
  }

  lines.push(`Reply with: A, B, C, or describe a hybrid (e.g. "mix A and B").`);
  lines.push(`Reply "cancel" to cancel.`);

  return lines.join('\n');
}

// ── User Choice Handling ──────────────────────────────────

export async function handleRedesignChoice(
  session: RedesignSession,
  userMessage: string,
  sendTelegram: (msg: string) => Promise<void>,
): Promise<string> {
  const choice = userMessage.trim().toLowerCase();

  if (choice === 'cancel') {
    session.status = 'cancelled';
    saveSession(session);
    return 'Redesign cancelled.';
  }

  // Direct option selection
  if (choice === 'a' || choice === 'b' || choice === 'c') {
    const selected = session.prototypes.options.find(o => o.id === choice);
    if (!selected) return 'Option not found. Try A, B, or C.';

    session.userChoice = choice;
    session.finalPrototype = selected.filePath;
    session.approvedTabs = selected.tabs;
    session.status = 'awaiting_approval';
    saveSession(session);

    return `Selected Option ${choice.toUpperCase()} (${selected.label}).\n\nTabs: ${selected.tabs.join(' | ')}\n→ ${selected.url}\n\nReply "approve" to generate implementation goals, or "cancel" to abort.`;
  }

  // Hybrid request — generate custom prototype
  session.status = 'generating_final';
  session.userChoice = userMessage;
  saveSession(session);

  await sendTelegram('Generating custom hybrid design...');

  try {
    const finalPath = await generateFinalPrototype(
      session.project,
      userMessage,
      session.prototypes.options,
    );

    session.finalPrototype = finalPath;
    session.status = 'awaiting_approval';
    saveSession(session);

    const url = `${getPrototypeBaseUrl()}/prototypes/${session.project}-final.html`;
    return `Here's your custom design: ${url}\n\nReply "approve" to generate implementation goals, or "cancel" to abort.`;
  } catch (err) {
    session.status = 'awaiting_choice';
    saveSession(session);
    return `Failed to generate hybrid: ${err instanceof Error ? err.message : 'Unknown error'}. Try picking A, B, or C instead.`;
  }
}

export async function handleRedesignApproval(
  session: RedesignSession,
  userMessage: string,
  sendTelegram: (msg: string) => Promise<void>,
): Promise<string> {
  const choice = userMessage.trim().toLowerCase();

  if (choice === 'cancel') {
    session.status = 'cancelled';
    saveSession(session);
    return 'Redesign cancelled.';
  }

  if (choice !== 'approve' && choice !== 'approved' && choice !== 'yes') {
    return 'Reply "approve" to generate goals, or "cancel" to abort.';
  }

  await sendTelegram('Decomposing design into implementation goals...');

  try {
    const goalIds = await decomposeIntoGoals(session);
    session.goals = goalIds;
    session.status = 'approved';
    saveSession(session);

    return `✅ Created ${goalIds.length} goals for ${session.project} redesign.\n\nThe agents will implement ${session.approvedTabs?.join(' | ') || 'the approved design'}. Each goal references the prototype as its design spec.`;
  } catch (err) {
    return `Failed to create goals: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
}

// ── Goal Decomposition ──────────────────────────────────────

async function decomposeIntoGoals(session: RedesignSession): Promise<string[]> {
  const audit = session.audit;
  const tabs = session.approvedTabs || [];
  const prototypePath = session.finalPrototype || '';

  const prompt = `You are decomposing a UX redesign into specific implementation goals.

## Project: ${session.project}
## Approved Design
Tabs: ${tabs.join(' | ')}
Prototype file: ${prototypePath}

## Current State (from audit)
Current pages: ${audit.pages.map(p => p.url).join(', ')}
Current nav: ${audit.navigation.type} with ${audit.navigation.totalItems} items
Features: ${audit.features.map(f => `${f.name} (${f.status})`).join(', ')}
UX Issues: ${audit.uxIssues.map(i => i.description).join('; ')}

## Task
Create 2-5 specific implementation goals that will transform the current app into the approved design.
Each goal should be actionable by an autonomous agent.

## Output Format
Respond with ONLY a JSON array (no markdown, no code fences):
[
  {
    "title": "<goal title, imperative, <80 chars>",
    "description": "<full spec with acceptance criteria. Reference the prototype file path. Include 'Do NOT add features beyond this spec.'>"
  }
]

Rules:
- Each goal should be completable in 1-3 hours
- Include acceptance criteria: "After completion, top-level tabs should be exactly [${tabs.join(', ')}]"
- Reference the prototype file: ${prototypePath}
- First goal should handle navigation restructuring
- Subsequent goals handle page content migration/consolidation
- Final goal should handle cleanup of removed routes/pages`;

  const result = await runSonnetForGoals(prompt);

  let goals: Array<{ title: string; description: string }>;
  try {
    goals = JSON.parse(result.text);
  } catch {
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      goals = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('Failed to parse goal decomposition');
    }
  }

  const goalIds: string[] = [];
  for (const g of goals) {
    const goal = addGoal(session.project, g.title, g.description);
    goalIds.push(goal.id);
  }

  return goalIds;
}

async function runSonnetForGoals(prompt: string): Promise<{ text: string; costUsd: number }> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');

    const proc = spawn(claudePath, [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', 'claude-sonnet-4-5',
    ], {
      cwd: join(__dirname, '../..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnvForClaude({
        PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
      }),
    });

    let output = '';
    let error = '';

    proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { error += data.toString(); });

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    proc.on('close', (code) => {
      if (code === 0 || output.length > 0) {
        try {
          const parsed = JSON.parse(output);
          resolve({
            text: (typeof parsed.result === 'string' ? parsed.result : output).trim(),
            costUsd: parsed.total_cost_usd ?? 0,
          });
        } catch {
          resolve({ text: output.trim(), costUsd: 0 });
        }
      } else {
        reject(new Error(`Sonnet exited with code ${code}: ${error}`));
      }
    });

    proc.on('error', reject);

    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Sonnet goal decomposition timed out after 3 minutes'));
    }, 180_000);
  });
}
