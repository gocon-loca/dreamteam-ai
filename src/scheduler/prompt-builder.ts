/**
 * Prompt Builder — Extracted from overnight.ts
 *
 * Builds the full goal prompt including knowledge context, debriefs,
 * archetype context, scope rules, and model selection.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createLogger } from '../utils/logger.js';
import type { ModelTier } from '../orchestration/model-config.js';
import {
  getAllGoals,
  getGoal,
  isGoalUIRelated,
} from '../orchestration/goal-manager.js';
import type { Goal } from '../orchestration/goal-manager.js';
import { findRelevantDebriefs } from '../orchestration/debrief-index.js';
import { getProjectKnowledge } from '../director/knowledge.js';
import { getProject } from '../projects/registry.js';
import { formatAdoraContext } from '../director/adora-client.js';
import { loadWorkflow, formatWorkflowPrompt } from '../orchestration/workflow-loader.js';
import { loadCondensedMemory, formatCondensedMemory } from '../orchestration/debrief-condenser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const log = createLogger('prompt-builder');
import {
  classifyGoalArchetype,
  getArchetypeContext,
  shouldUseSequentialThinking,
  getArchetypeConfig,
  getSelfVerificationProtocol,
} from '../orchestration/archetypes.js';
import {
  selectModel,
  getRealBudgetData,
  classifyGoalType,
} from '../orchestration/model-router.js';
import { getPMAcceptanceCriteria } from '../pm/pm-agent.js';
import { TEST_COMMANDS_GUIDANCE } from '../orchestration/test-commands.js';

export interface BuiltPrompt {
  prompt: string;
  model: ModelTier;
  archetype: string;
  useSequentialThinking: boolean;
  estimatedCostUsd: number;
}

/**
 * Build the full prompt for a goal, including knowledge context,
 * debrief history, archetype instructions, and model selection.
 */
export function buildGoalPrompt(goal: Goal, project: string): BuiltPrompt {
  // Build context from knowledge graph and recent debriefs
  const knowledgeEntries = getProjectKnowledge(project);
  const knowledgeContext = knowledgeEntries.length > 0
    ? knowledgeEntries.slice(-5).map(k => `- ${k.content}`).join('\n')
    : 'No previous context available.';

  const recentDebriefs = findRelevantDebriefs(goal, project, 3);
  const debriefContext = recentDebriefs.length > 0
    ? recentDebriefs.map(d => {
        const parts = [`[${d.title}]`];
        if (d.working) parts.push(`Working: ${d.working}`);
        if (d.broken) parts.push(`Broken: ${d.broken}`);
        if (d.next) parts.push(`Next: ${d.next}`);
        return `- ${parts.join(' | ')}`;
      }).join('\n')
    : 'No previous debriefs.';

  const description = goal.description || '';

  // Classify archetype — explicit goal.archetype overrides auto-classification
  const archetype = (goal.archetype === 'backend' || goal.archetype === 'frontend')
    ? goal.archetype
    : classifyGoalArchetype(goal);
  let archetypeContext = getArchetypeContext(archetype, project);

  // Determine if sequential thinking should be enabled
  const goalType = classifyGoalType(goal);
  const useSeqThinking = shouldUseSequentialThinking(archetype, goalType);

  // If goal-type triggers thinking but archetype doesn't, append prompt instruction
  if (useSeqThinking && !getArchetypeConfig(archetype).useSequentialThinking) {
    archetypeContext += '\n\n## Structured Reasoning\nFor complex decisions, use mcp__thinking__sequentialthinking to plan before implementing.';
  }

  // If integration goal touches UI, append self-verification protocol
  if (archetype === 'integration' && isGoalUIRelated(goal)) {
    const verifyProtocol = getSelfVerificationProtocol(project, 'frontend');
    if (verifyProtocol) {
      archetypeContext += '\n\n' + verifyProtocol;
    }
  }

  // PM Agent acceptance criteria (injected from latest smoke test findings)
  let pmCriteria = '';
  try {
    const criteria = getPMAcceptanceCriteria(project, goal.title, description);
    if (criteria) pmCriteria = '\n' + criteria + '\n';
  } catch (e) { log.swallow('get-pm-criteria', e); }

  // Boundary objects — design specs and app state for frontend/UX goals
  let boundaryObjects = '';
  const isUI = isGoalUIRelated(goal);
  if (isUI || archetype === 'integration') {
    // Inject approved redesign prototype (if exists)
    try {
      const sessionFile = join(__dirname, '../../data/redesign-sessions', `${project}.json`);
      if (existsSync(sessionFile)) {
        const session = JSON.parse(readFileSync(sessionFile, 'utf-8'));
        if (session.finalPrototype && existsSync(session.finalPrototype)) {
          const prototypeHtml = readFileSync(session.finalPrototype, 'utf-8');
          boundaryObjects += `\n## DESIGN SPEC (you MUST match this layout)
The approved prototype for this project's navigation is below.
Your changes MUST result in navigation that matches this prototype.
Do NOT add tabs, pages, or navigation items that aren't in this prototype.
Do NOT remove tabs that ARE in this prototype.

${prototypeHtml.slice(0, 5000)}
`;
        }
      }
    } catch (e) { log.swallow('load-redesign-session', e); }

    // Inject current app state from latest smoke test snapshot
    try {
      const snapshotPath = join(__dirname, '../../data/snapshots', `${project}-latest.json`);
      if (existsSync(snapshotPath)) {
        const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
        if (snapshot.routes && snapshot.routes.length > 0) {
          const routeList = snapshot.routes
            .map((r: { path: string; status: number }) => `${r.path} (${r.status})`)
            .join(', ');
          boundaryObjects += `\n## CURRENT APP STATE
Routes: ${routeList}
Do NOT break any of these working routes.
Do NOT remove or deprecate routes without explicit instruction.
`;
        }
      }
    } catch (e) { log.swallow('load-snapshot', e); }

    // Inject product brief quality standards
    try {
      const briefPath = join(__dirname, '../../config/product-briefs', `${project}.md`);
      if (existsSync(briefPath)) {
        const brief = readFileSync(briefPath, 'utf-8');
        // Extract just the quality standards / navigation sections
        const qualityMatch = brief.match(/## (?:Quality|Standards|Navigation|Core Routes)[\s\S]*?(?=\n## |\n# |$)/i);
        if (qualityMatch) {
          boundaryObjects += `\n## PRODUCT QUALITY STANDARDS
${qualityMatch[0].slice(0, 1500)}
`;
        }
      }
    } catch (e) { log.swallow('load-product-brief', e); }

    // Inject Adora journey map (known screens + journeys)
    try {
      const adoraContext = formatAdoraContext(project);
      if (adoraContext) {
        boundaryObjects += adoraContext;
      }
    } catch (e) { log.swallow('load-adora-context', e); }
  }

  // Build the prompt — keep it tight and focused
  const sections: string[] = [];

  // 1. Goal (always first and most prominent)
  sections.push(`# Goal: ${goal.title}`);
  if (description) sections.push(description);
  if (pmCriteria) sections.push(pmCriteria);
  if (boundaryObjects) sections.push(boundaryObjects);

  // Inject TEST_COMMANDS guidance when the goal has test commands
  if (description.includes('TEST_COMMANDS:')) {
    sections.push(TEST_COMMANDS_GUIDANCE);
  }

  // 2. Context — deduplicated: debriefs supersede knowledge entries,
  //    condensed memory only added when no recent debriefs exist
  if (knowledgeEntries.length > 0 || recentDebriefs.length > 0) {
    const contextParts: string[] = ['## Context'];

    if (recentDebriefs.length > 0) {
      // Debriefs are more specific and recent — prefer them over knowledge entries
      contextParts.push(`Recent debriefs:\n${debriefContext}`);
    } else if (knowledgeEntries.length > 0) {
      // No debriefs — fall back to knowledge graph
      contextParts.push(knowledgeContext);
    }

    // Condensed memory only when no recent debriefs (avoids redundancy)
    if (recentDebriefs.length === 0) {
      try {
        const condensed = loadCondensedMemory(project);
        if (condensed) {
          contextParts.push(formatCondensedMemory(condensed));
        }
      } catch (e) { log.swallow('load-condensed-memory', e); }
    }

    sections.push(contextParts.join('\n'));
  }

  // 3. Role context (archetype-specific instructions)
  if (archetypeContext) {
    sections.push(`## Role: ${archetype}\n${archetypeContext}`);
  }

  // 4. Project workflow (WORKFLOW.md)
  try {
    const workflow = loadWorkflow(project);
    if (workflow) {
      const workflowPrompt = formatWorkflowPrompt(workflow);
      if (workflowPrompt) {
        sections.push(`## Project Workflow\n${workflowPrompt}`);
      }
    }
  } catch (e) { log.swallow('load-workflow', e); }

  // 4b. Project lessons (LESSONS.md) — accumulated from past rejections/failures
  try {
    const projectConfig = getProject(project);
    if (projectConfig?.path) {
      const lessonsPath = join(projectConfig.path, 'LESSONS.md');
      if (existsSync(lessonsPath)) {
        const lessons = readFileSync(lessonsPath, 'utf-8').trim();
        if (lessons) {
          // Only inject the last ~1500 chars to keep prompt lean
          const trimmed = lessons.length > 1500
            ? '...\n' + lessons.slice(-1500)
            : lessons;
          sections.push(`## Lessons from Past Work\nThese patterns caused rejections or failures on this project. Do NOT repeat them.\n\n${trimmed}`);
        }
      }
    }
  } catch (e) { log.swallow('load-lessons', e); }

  // 4c. Failure context from any quality gate rejection
  //     Inject the rejection reason so the agent knows what went wrong and can fix it.
  if (goal.lastRejectionReason) {
    const failureLines: string[] = ['## Previous Attempt Failed (MUST ADDRESS)'];

    if (goal.lastRejectionReason.includes('Review agent')) {
      failureLines.push('The previous attempt was REJECTED by the **code review agent**.');
    } else if (goal.lastRejectionReason.includes('Smoke test')) {
      failureLines.push('The previous attempt was REJECTED by the **smoke test** (app broke after changes).');
    } else if (goal.lastRejectionReason.includes('TEST_COMMANDS')) {
      failureLines.push('The previous attempt FAILED the **test commands** (acceptance criteria not met).');
    } else if (goal.lastRejectionReason.includes('Validation failed')) {
      failureLines.push('The previous attempt failed **validation** (empty diff, surrender, or fabrication detected).');
    } else if (goal.lastRejectionReason.includes('timed out')) {
      failureLines.push('The previous attempt **timed out** before completing.');
    } else {
      failureLines.push('The previous attempt was REJECTED.');
    }

    failureLines.push('');
    failureLines.push('**Rejection details:**');
    failureLines.push(goal.lastRejectionReason.slice(0, 1500));
    failureLines.push('');
    failureLines.push('You MUST address the issues above. Try a DIFFERENT approach from the previous attempt.');

    sections.push(failureLines.join('\n'));
  }

  // 4d. Branch continuity — tell agent to check for prior work on the goal branch
  const goalBranchName = `goal/${goal.id}`;
  if ((goal.attemptCount || 0) > 0) {
    sections.push(`## Prior Work on Branch
You are on branch \`${goalBranchName}\`. A previous agent may have left useful commits.
Before starting work, run \`git log --oneline main..HEAD\` to see what was already done.
Build on existing commits rather than starting from scratch. Only revert if the prior work is fundamentally wrong.`);
  }

  // 4e. STYLE.md enforcement — inject design tokens for frontend/UX/design-research goals
  try {
    const projectConfig = getProject(project);
    if (projectConfig?.path) {
      const stylePath = join(projectConfig.path, 'STYLE.md');
      if (existsSync(stylePath) && (archetype === 'frontend' || archetype === 'ux-consolidation' || archetype === 'design-research' || isUI)) {
        const styleContent = readFileSync(stylePath, 'utf-8').trim();
        if (styleContent) {
          const trimmed = styleContent.length > 2000
            ? styleContent.slice(0, 2000) + '\n...(truncated)'
            : styleContent;
          sections.push(`## STYLE.md — Design System (MUST FOLLOW)
All UI work MUST conform to the design tokens and patterns defined below.
Do NOT introduce new colors, fonts, spacing, or component patterns that conflict with STYLE.md.

${trimmed}`);
        }
      }
    }
  } catch (e) { log.swallow('load-style-md', e); }

  // 4f. Stack-specific context — inject framework patterns for non-standard stacks
  //     Claude agents default to React/Node patterns. Projects using different stacks
  //     (Python/htmx/Jinja2, Ruby/Rails, etc.) need explicit guidance to avoid common mistakes.
  try {
    const projectConfig = getProject(project);
    if (projectConfig?.path) {
      const hasPyproject = existsSync(join(projectConfig.path, 'pyproject.toml'));
      const hasTemplates = existsSync(join(projectConfig.path, 'templates'));
      const hasJinja = existsSync(join(projectConfig.path, 'templates')) ||
                       existsSync(join(projectConfig.path, 'app', 'templates'));

      // Python + htmx/Jinja2 stack (e.g., voicenotes)
      if (hasPyproject && (hasTemplates || hasJinja)) {
        sections.push(`## Stack Context: Python + htmx + Jinja2
This project uses Python with htmx and Jinja2 templates — NOT React/Node.

Key patterns:
- **Routing**: Flask/FastAPI route handlers return rendered Jinja2 templates, not JSON
- **Interactivity**: htmx attributes (hx-get, hx-post, hx-target, hx-swap) handle dynamic updates — no JavaScript frameworks
- **Templates**: Jinja2 templates in templates/ directory use {% extends %}, {% block %}, {{ variable }} syntax
- **Forms**: Use standard HTML forms with htmx attributes, not React controlled components
- **Database**: SQLAlchemy ORM or raw SQL — not Prisma/Drizzle
- **Static files**: Served from static/ directory, referenced with url_for('static', filename=...)
- **Testing**: pytest for backend, no Jest/Vitest

Common mistakes to avoid:
- Do NOT add React, npm, or Node.js dependencies
- Do NOT create .tsx/.jsx files — use .html Jinja2 templates
- Do NOT use fetch() for htmx interactions — use hx-* attributes
- htmx responses should return HTML fragments, not JSON
- Use hx-target to specify where the response HTML goes
- Use hx-swap to control how content is inserted (innerHTML, outerHTML, beforeend, etc.)
- Forms with hx-post must have matching Flask/FastAPI route handlers`);
      }
    }
  } catch (e) { log.swallow('load-stack-context', e); }

  // 5. Rules — goal-specific, agent-level rules live in buildEnhancedPrompt
  sections.push(`## Rules
- Read the project's CLAUDE.md first for conventions and patterns
- NEVER output GOAL_COMPLETE unless ALL acceptance criteria are met

## Required Output
Before GOAL_COMPLETE, output this debrief:

---DEBRIEF---
COMMITS: <commit hashes and messages>
WORKING: <what is working now>
BROKEN: <what needs attention, or "none">
VERIFIED: <what you checked — pages visited, tests run, endpoints curled>
CONFIDENCE: <high|medium|low>
NEXT: <suggestions for follow-up work>
---END_DEBRIEF---

GOAL_COMPLETE`);

  // Inject Jam context for jam-sourced goals
  if (goal.source?.startsWith('jam:')) {
    const jamId = goal.source.replace('jam:', '');
    const jamCtx = goal.jamContext;
    const jamLines: string[] = ['## Original Bug Report (Jam Recording)'];
    jamLines.push(`Jam ID: ${jamId} — https://jam.dev/c/${jamId}`);

    if (jamCtx?.description) {
      jamLines.push(`\nUser description: ${jamCtx.description}`);
    }
    if (jamCtx?.transcript) {
      jamLines.push(`\nUser narration from video:\n${jamCtx.transcript.slice(0, 1500)}`);
    }
    if (jamCtx?.screenshotUrl) {
      jamLines.push(`\nScreenshot of the bug: ${jamCtx.screenshotUrl}`);
    }
    if (jamCtx?.consoleLogs) {
      jamLines.push(`\n### Console Errors\n${jamCtx.consoleLogs.slice(0, 1000)}`);
    }
    if (jamCtx?.failedRequests) {
      jamLines.push(`\n### Failed Network Requests\n${jamCtx.failedRequests.slice(0, 1000)}`);
    }
    if (jamCtx?.userEvents) {
      jamLines.push(`\n### User Interaction Replay\n${jamCtx.userEvents.slice(0, 1000)}`);
    }
    if (!jamCtx) {
      jamLines.push('If you have access to the mcp__jam__getDetails tool, call it with this ID to review the original user feedback.');
    }
    jamLines.push('\nVerify your fix addresses every issue reported in the bug report above.');
    sections.push(jamLines.join('\n'));
  }

  const prompt = sections.join('\n\n');

  // Select model using intelligent router
  let modelDecision;
  try {
    const budgetData = getRealBudgetData();
    modelDecision = selectModel(goal, {
      budgetRemainingUsd: 100 - budgetData.todayUsd,
      archetype,
    });
  } catch (e) {
    log.swallow('select-model', e);
    modelDecision = {
      model: 'primary' as const,
      reasoning: 'router error',
      estimatedCostUsd: 0.79,
      confidence: 0.5,
      fallbackModel: 'primary' as const,
    };
  }

  return {
    prompt,
    model: modelDecision.model,
    archetype,
    useSequentialThinking: useSeqThinking,
    estimatedCostUsd: modelDecision.estimatedCostUsd,
  };
}
