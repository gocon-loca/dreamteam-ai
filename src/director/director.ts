/**
 * Director Agent - The strategic brain of DreamTeam
 *
 * This is YOU - the Claude instance that:
 * - Maintains full context about the infrastructure
 * - Translates ideas into concrete goals
 * - Reasons about how to make the system more effective
 * - Has back-and-forth conversations via Telegram
 * - Can be "resumed" to continue previous conversations
 *
 * Mode-aware (interactive/autonomous), proposal flow,
 * token-optimized prompt, ChatResult return type.
 */

import { spawn, ChildProcess } from 'child_process';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { dirname } from 'path';
import {
  addGoal,
  getAllGoals,
  getGoalsSummary,
  getRecentDebriefs,
  updateGoal,
  Goal,
} from '../orchestration/goal-manager.js';
import { listProjectNames } from '../projects/registry.js';
import {
  formatKnowledgeForDirector,
  extractAndStorePatterns,
  addKnowledge,
  analyzePatterns,
} from './knowledge.js';
import {
  getDecisionsContextForDirector,
  parseDecisionCommands,
} from './decision-journal.js';
import { insertDirectorInteraction } from '../db/director-log.js';
import { getUserMode } from '../orchestration/user-presence.js';
import {
  createBatch,
  getActiveBatch,
  type GoalProposal,
} from '../orchestration/proposal-store.js';
import { selectModel } from '../orchestration/model-router.js';
import { getSuccessPatterns } from '../analytics/patterns.js';
import { getRollupStatus } from '../orchestration/subtask-manager.js';
import { getRoadmapContextForDirector } from '../orchestration/roadmap.js';
import { getLatestAudit, isAuditStale, runAppAudit } from './app-audit.js';
import { formatInventoryForDirector } from './feature-inventory.js';
import { formatFeedbackContext as formatFeedbackContextForDirector } from '../orchestration/feedback-processor.js';
import { formatAdoraContext } from './adora-client.js';
import {
  getActiveRedesignSession,
  handleRedesignChoice,
  handleRedesignApproval,
} from './redesign.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const DIRECTOR_STATE_FILE = join(DATA_DIR, 'director-state.json');
const CONVERSATION_FILE = join(DATA_DIR, 'director-conversation.json');

// ── Types ──────────────────────────────────────────────────

interface ConversationMessage {
  role: 'user' | 'director';
  content: string;
  timestamp: string;
  source?: 'text' | 'voice';
}

interface DirectorState {
  sessionId: string | null;
  lastActive: string;
  conversationCount: number;
}

interface DirectorConversation {
  messages: ConversationMessage[];
  startedAt: string;
  lastUpdated: string;
}

export interface ChatResult {
  text: string;               // Conversational response (goal signals stripped)
  proposals: GoalProposal[];  // Populated in interactive mode
  goalsCreated: Goal[];       // Populated in autonomous mode (green)
  goalsHeld: Goal[];          // Populated in autonomous mode (yellow)
  batchId?: string;           // Set when proposals were stored
  learned: number;            // Count of LEARN commands processed
  decisions: number;          // Count of DECISION commands processed
  cost: { inputTokens: number; outputTokens: number; costUsd: number };
}

// ── State ──────────────────────────────────────────────────

let currentState: DirectorState | null = null;
let conversation: DirectorConversation | null = null;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState(): DirectorState {
  ensureDataDir();
  if (existsSync(DIRECTOR_STATE_FILE)) {
    return JSON.parse(readFileSync(DIRECTOR_STATE_FILE, 'utf-8'));
  }
  return {
    sessionId: null,
    lastActive: new Date().toISOString(),
    conversationCount: 0,
  };
}

function saveState(state: DirectorState): void {
  ensureDataDir();
  writeFileSync(DIRECTOR_STATE_FILE, JSON.stringify(state, null, 2));
}

function loadConversation(): DirectorConversation {
  ensureDataDir();
  if (existsSync(CONVERSATION_FILE)) {
    return JSON.parse(readFileSync(CONVERSATION_FILE, 'utf-8'));
  }
  return {
    messages: [],
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

function saveConversation(conv: DirectorConversation): void {
  ensureDataDir();
  conv.lastUpdated = new Date().toISOString();
  writeFileSync(CONVERSATION_FILE, JSON.stringify(conv, null, 2));
}

/**
 * Initialize Director on startup
 */
export function initDirector(): void {
  currentState = loadState();
  conversation = loadConversation();
  console.log(`Director initialized. ${conversation.messages.length} messages in history.`);
}

// ── Prompt Helpers ─────────────────────────────────────────

/**
 * Get conversation context with per-message truncation to save tokens.
 */
function getConversationContext(): string {
  if (!conversation || conversation.messages.length === 0) {
    return 'No previous conversation.';
  }

  const recent = conversation.messages.slice(-20);
  return recent.map(m => {
    const truncated = m.content.length > 300
      ? m.content.slice(0, 300) + '...'
      : m.content;
    return `${m.role.toUpperCase()}: ${truncated}`;
  }).join('\n\n');
}

/**
 * Detect which projects the user message is about.
 * Returns null if no specific project detected (braindump — include all).
 */
function getRelevantProjects(userMessage: string): string[] | null {
  const projects = listProjectNames();
  const mentioned = projects.filter(p =>
    userMessage.toLowerCase().includes(p.toLowerCase())
  );
  return mentioned.length > 0 ? mentioned : null;
}

/**
 * Heuristic: does the user message look like a goal request?
 * When false, we skip the doctrine + goal creation rules (~880 tokens).
 */
function looksLikeGoalRequest(userMessage: string): boolean {
  return /\b(fix|build|add|implement|change|create|update|redesign|refactor|overhaul|improve|make|set up|configure|deploy|migrate|remove|delete|replace)\b/i.test(userMessage)
    || (getActiveBatch()?.status === 'pending') === true; // user adjusting proposals
}

/**
 * Build the Director system prompt — mode-aware, token-optimized.
 */
function buildDirectorPrompt(mode: 'interactive' | 'autonomous', userMessage: string): string {
  const goals = getAllGoals();
  const summary = getGoalsSummary();
  const projects = listProjectNames();

  // Filter debriefs to relevant projects when possible
  const relevantProjects = getRelevantProjects(userMessage);
  const debriefs = getRecentDebriefs({ limit: 10 });
  const filteredDebriefs = relevantProjects
    ? debriefs.filter(d => relevantProjects.includes(d.project))
    : debriefs;

  const debriefsByProject = new Map<string, string[]>();
  for (const d of filteredDebriefs) {
    if (!debriefsByProject.has(d.project)) debriefsByProject.set(d.project, []);
    const parts = [d.title];
    if (d.working) parts.push(`Working: ${d.working.slice(0, 80)}`);
    if (d.broken) parts.push(`Broken: ${d.broken.slice(0, 80)}`);
    debriefsByProject.get(d.project)!.push(parts.join(' | '));
  }
  const debriefContext = debriefsByProject.size > 0
    ? Array.from(debriefsByProject.entries())
        .map(([proj, items]) => `**${proj}:**\n${items.map(i => `  - ${i}`).join('\n')}`)
        .join('\n')
    : 'No agent debriefs yet.';

  // Base prompt — always included
  let prompt = `# You are the Director of DreamTeam

You are the strategic brain. The user communicates via Telegram — often voice notes, braindumps, and high-level guidance. Your job is to translate their vision into specific, executable work.

## Your Role
- Decompose braindumps into specific, testable goals (1-3 hours each)
- Know what's already done (from debriefs below) to avoid redundant work
- Maintain context across conversations
- Escalate when you need human guidance on ambiguous decisions

## Available Projects
${projects.map(p => `- ${p}`).join('\n')}

## Current Goals Summary
- Total: ${summary.total} | Pending: ${summary.pending} | In Progress: ${summary.inProgress} | Completed: ${summary.completed} | Blocked: ${summary.blocked}

## Recent Goals
${goals.slice(-10).map(g => {
  let line = `- [${g.status}] ${g.project}: ${g.title}`;
  try {
    const rollup = getRollupStatus(g.id);
    if (rollup !== 'No sub-tasks') line += ` (${rollup})`;
  } catch {}
  return line;
}).join('\n') || 'No goals yet.'}

## Recent Agent Debriefs (what's actually working/broken)
${debriefContext}

## Recent Conversation
${getConversationContext()}

${formatKnowledgeForDirector()}

${getDecisionsContextForDirector()}
`;

  // Performance insights from model_task_memory
  try {
    const patterns = getSuccessPatterns({ minRuns: 10 });
    const wins = patterns.topSuccessPatterns.slice(0, 3);
    const fails = patterns.failurePatterns.slice(0, 3);
    if (wins.length > 0 || fails.length > 0) {
      const lines: string[] = ['\n## Performance Insights'];
      if (wins.length > 0) {
        lines.push('Working well: ' + wins.map(p =>
          `${p.goalType}+${p.model} ${(p.successRate * 100).toFixed(0)}% (${p.runs} runs)`
        ).join(', '));
      }
      if (fails.length > 0) {
        lines.push('Struggling: ' + fails.map(p =>
          `${p.goalType}+${p.model} ${(p.failureRate * 100).toFixed(0)}% fail (${p.runs} runs)`
        ).join(', '));
      }
      prompt += lines.join('\n') + '\n';
    }
  } catch { /* patterns module unavailable */ }

  // User feedback context — negative signals that need attention
  try {
    const feedbackCtx = formatFeedbackContextForDirector(20);
    if (feedbackCtx) {
      prompt += feedbackCtx;
    }
  } catch { /* feedback processor unavailable */ }

  // Roadmap context — what each project is working toward
  try {
    const roadmapContext = getRoadmapContextForDirector();
    if (roadmapContext) {
      prompt += '\n' + roadmapContext + '\n';
    }
  } catch { /* roadmap module unavailable */ }

  // Product intelligence — audit + inventory context
  try {
    const auditProjects = relevantProjects || listProjectNames();
    for (const proj of auditProjects) {
      const audit = getLatestAudit(proj);
      if (audit) {
        prompt += `\n\n## Recent Audit: ${proj} (${audit.timestamp})\n`;
        prompt += `Pages: ${audit.pages.length}, Features: ${audit.features.length}\n`;
        if (audit.uxIssues.length > 0) {
          prompt += `UX Issues:\n${audit.uxIssues.map(i => `- ${i.type}: ${i.description}`).join('\n')}\n`;
        }
        prompt += `Summary: ${audit.summary}\n`;
      }
      const inv = formatInventoryForDirector(proj);
      if (inv) {
        prompt += `\n\n## Feature Inventory: ${proj}\n${inv}\n`;
      }
    }
  } catch { /* audit/inventory modules unavailable */ }

  // Adora product intelligence — real screen maps and journey data
  try {
    const adoraProjects = relevantProjects || listProjectNames();
    for (const proj of adoraProjects) {
      const adoraCtx = formatAdoraContext(proj);
      if (adoraCtx) {
        prompt += adoraCtx;
      }
    }
  } catch { /* adora module unavailable */ }

  // Show pending proposals if any (for adjustments)
  const activeBatch = getActiveBatch();
  if (activeBatch && activeBatch.status === 'pending') {
    prompt += `\n## Pending Proposals (awaiting user confirmation)\n`;
    for (const p of activeBatch.proposals) {
      prompt += `- [${p.confidence}] ${p.project}: "${p.title}" ($${p.estimatedCostUsd.toFixed(2)}, ${p.model})\n`;
    }
    prompt += `\nThe user may be asking about or adjusting these. If they want changes, output new GOAL_PROPOSE commands (which replaces the old batch).\n`;
  }

  // Goal doctrine and rules — always included
  prompt += `
## Quality Doctrine (CRITICAL)

**Better to create 2 excellent, specific goals than 5 vague ones.**
Agents produce quality work ONLY when goals have detailed specs. Vague goals = vague output = wasted tokens.
Every goal you create will be executed by an autonomous agent with no human oversight. The spec IS the product manager.

`;
  // Mode-specific goal creation rules
  if (mode === 'interactive') {
    prompt += `## Goal Proposal Rules (you are in INTERACTIVE mode)

When you want to create goals, use GOAL_PROPOSE (NOT GOAL_CREATE):

GOAL_PROPOSE project="<project>" title="<title>" description="<full spec>" complexity="<routine|complex>" confidence="<green|yellow>" reason="<1 sentence why green/yellow>"

I show the user your proposals as cards with cost estimates and approve/drop buttons. Nothing runs until they confirm.

When you have MIXED confidence, separate them:
"I'd send these 2 overnight ($0.68). Holding the dashboard redesign — need layout details: cards or list?"

Keep your conversational response SHORT. The proposal cards provide the detail.

`;
  } else {
    prompt += `## Goal Creation Rules (you are in AUTONOMOUS mode — user is away)

When creating goals, use GOAL_CREATE:

GOAL_CREATE project="<project>" title="<title>" description="<full spec>" complexity="<routine|complex>" confidence="<green|yellow>"

Only create GREEN-confidence goals. Yellow goals will be held for user review.

`;
  }

  // Shared goal rules (both modes)
  prompt += `## Goal Spec Requirements (all goals)
1. **Decompose**: Break braindumps into multiple specific goals.
2. **Be specific**: Title < 80 chars. Full spec in description.
3. **Acceptance criteria**: Every goal MUST have clear "done" criteria.
4. **UI/UX goals** need a UX spec: layout, interaction, content, anti-requirements, reference pages.
5. **Tag complexity**: routine (Sonnet — tests, docs, config, small fixes) or complex (Opus — features, architecture, multi-file).
6. **Tag confidence**: green (clear spec, precedent, <$2) or yellow (underspecified, no precedent, UI without DESIGN.md, >$2).
7. **Check debriefs first**: Don't redo what's already working.
8. **One feature per goal**: Don't bundle. Maximum scope: ONE page or component per goal.
9. **If vague, ask**: "Cards or list? What info per result?" saves tokens.
10. **Anti-scope-creep**: Include "Do NOT add features beyond this spec."

## Goal Description Structure (MANDATORY for all goals)
Every goal description MUST include these five sections:

**WHAT**: Specific files, routes, or components to change.
**HOW**: Concrete end state — what it should look/work like after the change.
**DO NOT TOUCH**: Explicit list of routes, files, or features to preserve unchanged.
**ACCEPTANCE CRITERIA**: Bullet list of verifiable conditions.
**TEST_COMMANDS**: Shell commands that verify the work was done (exit 0 = pass). These run automatically after the agent finishes. Write "TEST_COMMANDS: none" for refactoring/docs goals with no observable output.

TEST_COMMANDS rules:
- Each command must exit 0 on success, non-zero on failure
- Max 30s per command. Keep them simple and read-only.
- Test OBSERVABLE OUTCOMES (API responses, DB state, build passing, pages loading) — not file paths or imports
- For web projects: \`curl -sf localhost:PORT/path | python3 -c "import json,sys; data=json.load(sys.stdin); assert <condition>"\`
- For DB projects: \`sqlite3 "path/db" "SELECT ..." | python3 -c "import sys; val=sys.stdin.read().strip(); assert <condition>"\`
- For build checks: \`cd /path && npm run build 2>&1 | tail -1\`
- For file content: \`grep -q "expected pattern" path/to/file\`
- NEVER test Python imports (venv may not be active). NEVER check specific filenames (agent may name files differently).
- Quote paths containing shell special chars like brackets: \`"app/[id]/page.tsx"\`

Project ports and DB paths are defined in config/projects.yaml — check healthCheck and devPort fields.

Examples:

GOOD goal with TEST_COMMANDS:
"Add /api/habits endpoint that returns user habits as JSON.
WHAT: Create API route at /api/habits
HOW: GET returns array of {id, title, frequency, streak}
DO NOT TOUCH: /api/auth, /api/communities
ACCEPTANCE CRITERIA: Endpoint returns 200 with JSON array
TEST_COMMANDS:
- curl -sf http://localhost:3000/api/habits | python3 -c \"import json,sys; data=json.load(sys.stdin); assert isinstance(data, list)\"
- cd ~/projects/my-app && npm run build"

GOOD refactoring goal (no observable output):
"Refactor auth utils into a shared module.
WHAT: Extract auth helpers from 3 files into shared/auth.ts
HOW: Single source of truth for token validation
DO NOT TOUCH: Any API behavior or UI
ACCEPTANCE CRITERIA: All imports resolve, build passes
TEST_COMMANDS:
- cd ~/projects/my-app && npm run build"

A review agent checks every completed goal against its spec. Vague specs = automatic rejection = wasted tokens. Be specific.

`;

  // Other capabilities — always included
  prompt += `## Other Capabilities
- LEARN type="<decision|pattern|preference>" content="<what to remember>"
- DECISION category="<architecture|technology|process|scope|priority|approach>" title="<brief title>" rationale="<why>"
- Summarize status across projects
- Suggest improvements proactively

## Roadmap Awareness
You have access to each project's ROADMAP.md (shown above under "Project Roadmaps").
When proposing goals, cross-reference the roadmaps to:
- Suggest goals that advance the highest-priority roadmap items
- Flag blockers that need human intervention
- Avoid proposing work that conflicts with the current phase
When the user asks "what should we work on?" or says something vague, use roadmaps to suggest specific, high-priority goals.

## Product Intelligence
When proposing goals for a project with audit or Adora data:
- Reference specific UX issues from the audit or Adora-flagged issues
- Propose 'ux-consolidation' goals for empty pages, redundant navigation, or dead features
- Consider feature inventory status — don't propose goals for features that are already working
- Use Adora's journey map to understand how screens connect — don't break existing user flows
- Target Adora-flagged issues first — they represent real usability problems, not guesses

## Response Style
- This is Telegram on a phone. 3-5 sentences max per conversational response.
- Be opinionated: "Here's what I think you mean. Here's where I'm unsure."
- Ask SPECIFIC questions, not open-ended. Bad: "What do you want?" Good: "Should search results be cards or a list?"
- When proposing expensive work (Opus, >$0.50), mention the cost.
- Never repeat the full spec in conversation — it's in the proposal cards.
- Reference what agents have reported in debriefs.

---

`;

  return prompt;
}

// ── Parsing ────────────────────────────────────────────────

/**
 * Parse GOAL_PROPOSE (and GOAL_CREATE as fallback) from response.
 * Returns GoalProposal[] enriched with cost estimates.
 */
export function parseGoalProposals(response: string): GoalProposal[] {
  const pattern = /GOAL_(?:PROPOSE|CREATE)\s+project="([^"]+)"\s+title="([^"]+)"(?:\s+description="([^"]*)")?(?:\s+complexity="([^"]*)")?(?:\s+confidence="([^"]*)")?(?:\s+reason="([^"]*)")?/g;
  const proposals: GoalProposal[] = [];

  let match;
  while ((match = pattern.exec(response)) !== null) {
    const [, project, title, description, complexity, confidence, reason] = match;

    // Get cost estimate from model-router
    const comp = (complexity === 'routine' || complexity === 'complex') ? complexity : 'complex';
    const conf = (confidence === 'green' || confidence === 'yellow') ? confidence : 'yellow';

    // Build a minimal Goal-like object for selectModel
    const fakeGoal: Goal = {
      id: '', project, title,
      description: description || '',
      status: 'pending',
      complexity: comp,
      confidence: conf,
      createdAt: new Date(),
      assumptions: [],
      iterations: 0,
    };

    let estimatedCostUsd = 0.15; // default fallback
    let model = 'secondary';
    try {
      const decision = selectModel(fakeGoal);
      estimatedCostUsd = decision.estimatedCostUsd;
      model = decision.model;
    } catch {
      // model-router not ready — use defaults
    }

    proposals.push({
      id: '', // filled by createBatch
      project,
      title,
      description: description || '',
      complexity: comp,
      confidence: conf,
      confidenceReason: reason || '',
      estimatedCostUsd,
      model,
    });
  }

  return proposals;
}

/**
 * Parse GOAL_CREATE commands and create goals immediately (autonomous mode).
 */
function parseAndCreateGoals(response: string): Goal[] {
  const goalPattern = /GOAL_CREATE\s+project="([^"]+)"\s+title="([^"]+)"(?:\s+description="([^"]*)")?(?:\s+complexity="([^"]*)")?(?:\s+confidence="([^"]*)")?/g;
  const created: Goal[] = [];

  let match;
  while ((match = goalPattern.exec(response)) !== null) {
    const [, project, title, description, complexity, confidence] = match;
    try {
      const goal = addGoal(project, title, description);
      const updates: Partial<Goal> = {};
      if (complexity === 'routine' || complexity === 'complex') {
        updates.complexity = complexity;
      }
      if (confidence === 'green' || confidence === 'yellow') {
        updates.confidence = confidence;
      }
      if (Object.keys(updates).length > 0) {
        updateGoal(goal.id, updates);
      }
      created.push({ ...goal, ...updates });
    } catch (error) {
      console.error(`Failed to create goal for ${project}:`, error);
    }
  }

  return created;
}

/**
 * Strip GOAL_PROPOSE and GOAL_CREATE signals from text shown to user.
 */
export function stripGoalCommands(response: string): string {
  return response
    .replace(/GOAL_(?:PROPOSE|CREATE)\s+project="[^"]*"\s+title="[^"]*"(?:\s+description="[^"]*")?(?:\s+complexity="[^"]*")?(?:\s+confidence="[^"]*")?(?:\s+reason="[^"]*")?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse LEARN commands from Director response and store knowledge.
 */
function parseAndLearn(response: string): string[] {
  const learnPattern = /LEARN\s+type="(decision|pattern|preference)"\s+content="([^"]+)"/g;
  const learned: string[] = [];

  let match;
  while ((match = learnPattern.exec(response)) !== null) {
    const [, type, content] = match;
    try {
      addKnowledge(type as 'decision' | 'pattern' | 'preference', content, {
        source: 'conversation',
        confidence: 0.9,
      });
      learned.push(content);
    } catch (error) {
      console.error('Failed to store knowledge:', error);
    }
  }

  return learned;
}

// ── Main Chat ──────────────────────────────────────────────

/**
 * Send a message to the Director and get a structured response.
 */
export async function chat(
  userMessage: string,
  source: 'text' | 'voice' = 'text'
): Promise<ChatResult> {
  if (!conversation) {
    conversation = loadConversation();
  }
  if (!currentState) {
    currentState = loadState();
  }

  // Add user message to conversation
  conversation.messages.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
    source,
  });

  // Determine mode
  const mode = getUserMode();

  // Build full prompt
  const systemPrompt = buildDirectorPrompt(mode, userMessage);
  const fullPrompt = `${systemPrompt}\n\nUser message:\n${userMessage}`;

  // Check for active redesign session
  const relevantProjects = getRelevantProjects(userMessage);
  const activeRedesign = getActiveRedesignSession(relevantProjects);
  if (activeRedesign) {
    // Placeholder sendTelegram — in the bot context, messages go through ctx.reply
    const noopSend = async (_msg: string) => {};

    if (activeRedesign.status === 'awaiting_choice') {
      const responseText = await handleRedesignChoice(activeRedesign, userMessage, noopSend);
      conversation.messages.push(
        { role: 'user', content: userMessage, timestamp: new Date().toISOString(), source },
        { role: 'director', content: responseText, timestamp: new Date().toISOString() },
      );
      saveConversation(conversation);
      return {
        text: responseText,
        proposals: [],
        goalsCreated: [],
        goalsHeld: [],
        learned: 0,
        decisions: 0,
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    }

    if (activeRedesign.status === 'awaiting_approval') {
      const responseText = await handleRedesignApproval(activeRedesign, userMessage, noopSend);
      conversation.messages.push(
        { role: 'user', content: userMessage, timestamp: new Date().toISOString(), source },
        { role: 'director', content: responseText, timestamp: new Date().toISOString() },
      );
      saveConversation(conversation);
      return {
        text: responseText,
        proposals: [],
        goalsCreated: [],
        goalsHeld: [],
        learned: 0,
        decisions: 0,
        cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    }
  }

  // Auto-audit: refresh stale audits before proposing goals
  if (looksLikeGoalRequest(userMessage)) {
    const auditProjects = getRelevantProjects(userMessage);
    if (auditProjects) {
      for (const proj of auditProjects) {
        if (isAuditStale(proj)) {
          try {
            await runAppAudit(proj);
          } catch (err) {
            console.error(`[Director] Auto-audit failed for ${proj}:`, err);
          }
        }
      }
    }
  }

  try {
    const result = await runClaude(fullPrompt);
    const response = result.text;

    // Mode-aware goal handling
    let proposals: GoalProposal[] = [];
    let goalsCreated: Goal[] = [];
    let goalsHeld: Goal[] = [];
    let batchId: string | undefined;

    if (mode === 'interactive') {
      // Parse GOAL_PROPOSE (and catch GOAL_CREATE as fallback)
      proposals = parseGoalProposals(response);
      if (proposals.length > 0) {
        const batch = createBatch(proposals);
        batchId = batch.id;
        // Update proposals with IDs from batch
        proposals = batch.proposals;
      }
      // DO NOT call addGoal() — wait for user confirmation
    } else {
      // Autonomous: create goals immediately
      const created = parseAndCreateGoals(response);
      goalsCreated = created.filter(g => g.confidence !== 'yellow');
      goalsHeld = created.filter(g => g.confidence === 'yellow');
    }

    // Parse LEARN and DECISION commands
    const learned = parseAndLearn(response);
    const decisions = parseDecisionCommands(response);

    // Extract patterns automatically
    extractAndStorePatterns(userMessage, response);

    // Strip goal commands from text shown to user
    const cleanText = stripGoalCommands(response);

    // Add director response to conversation
    conversation.messages.push({
      role: 'director',
      content: response,
      timestamp: new Date().toISOString(),
    });

    // Save conversation
    saveConversation(conversation);

    // Update state
    currentState.lastActive = new Date().toISOString();
    currentState.conversationCount++;
    saveState(currentState);

    // Log interaction to SQLite
    try {
      insertDirectorInteraction({
        userInputRaw: userMessage,
        inputType: source,
        directorResponse: response,
        goalsProposed: proposals.length > 0
          ? proposals.map(p => ({
              project: p.project,
              title: p.title,
              description: p.description,
              confidence: p.confidence,
              complexity: p.complexity,
            }))
          : goalsCreated.map(g => ({
              project: g.project,
              title: g.title,
              description: g.description || '',
            })),
        goalsConfirmed: goalsCreated.map(g => ({
          project: g.project,
          title: g.title,
          goalId: g.id,
        })),
        goalsHeld: goalsHeld.length > 0
          ? goalsHeld.map(g => ({
              project: g.project,
              title: g.title,
              reason: 'yellow confidence — held for review',
            }))
          : undefined,
        exchangeMessageCount: conversation.messages.length,
        sessionId: currentState.sessionId || undefined,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      });
    } catch (e) {
      console.error('[Director] Failed to log interaction to SQLite:', e);
    }

    // Log to Linear daily director log
    try {
      const { isLinearEnabled, ensureDailyDirectorLog, postDirectorInteractionToLinear } =
        await import('../integrations/linear.js');
      if (isLinearEnabled()) {
        const dailyLogId = await ensureDailyDirectorLog();
        if (dailyLogId) {
          await postDirectorInteractionToLinear(dailyLogId, {
            userInput: userMessage,
            inputType: source,
            directorResponse: response,
            proposalsCount: proposals.length,
            proposals: proposals.map(p => ({
              confidence: p.confidence,
              project: p.project,
              title: p.title,
              estimatedCostUsd: p.estimatedCostUsd,
            })),
            goalsCreatedCount: goalsCreated.length,
            goalsHeldCount: goalsHeld.length,
            costUsd: result.costUsd,
          });
        }
      }
    } catch (e) {
      console.error('[Director] Failed to post to Linear:', e);
    }

    return {
      text: cleanText,
      proposals,
      goalsCreated,
      goalsHeld,
      batchId,
      learned: learned.length,
      decisions: decisions.length,
      cost: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Director chat error:', error);
    return {
      text: `Sorry, I encountered an error: ${errorMsg}`,
      proposals: [],
      goalsCreated: [],
      goalsHeld: [],
      learned: 0,
      decisions: 0,
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
}

// ── Claude CLI ─────────────────────────────────────────────

interface DirectorRunResult {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Run Claude CLI and get response (with JSON output for cost tracking)
 */
async function runClaude(prompt: string): Promise<DirectorRunResult> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');

    const proc = spawn(claudePath, [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', 'claude-opus-4-6',
    ], {
      cwd: join(__dirname, '../..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnvForClaude({
        PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
      }),
    });

    let output = '';
    let error = '';

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      error += data.toString();
    });

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    proc.on('close', (code) => {
      if (code === 0 || output.length > 0) {
        try {
          const parsed = JSON.parse(output);
          resolve({
            text: (typeof parsed.result === 'string' ? parsed.result : output).trim(),
            costUsd: parsed.total_cost_usd ?? 0,
            inputTokens: parsed.usage?.input_tokens ?? 0,
            outputTokens: parsed.usage?.output_tokens ?? 0,
          });
        } catch {
          console.warn('[Director] JSON parse failed, falling back to text mode');
          resolve({
            text: output.trim(),
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
          });
        }
      } else {
        reject(new Error(`Claude exited with code ${code}: ${error}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    // Timeout after 10 minutes
    const DIRECTOR_TIMEOUT = 10 * 60 * 1000;
    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Claude timed out after 10 minutes'));
    }, DIRECTOR_TIMEOUT);
  });
}

// ── Public Helpers ──────────────────────────────────────────

/**
 * Get Director status
 */
export function getDirectorStatus(): {
  conversationLength: number;
  lastActive: string | null;
  totalMessages: number;
} {
  if (!currentState) currentState = loadState();
  if (!conversation) conversation = loadConversation();

  return {
    conversationLength: conversation.messages.length,
    lastActive: currentState.lastActive,
    totalMessages: currentState.conversationCount,
  };
}

/**
 * Clear conversation history (start fresh)
 */
export function clearConversation(): void {
  conversation = {
    messages: [],
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
  saveConversation(conversation);
}

/**
 * Get recent conversation for display
 */
export function getRecentConversation(count: number = 5): ConversationMessage[] {
  if (!conversation) conversation = loadConversation();
  return conversation.messages.slice(-count);
}
