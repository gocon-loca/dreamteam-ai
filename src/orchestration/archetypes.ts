/**
 * Agent Archetypes — Role-based context and tool configuration
 *
 * Each goal is classified into an archetype (frontend, backend, etc.)
 * which determines what context documents, tools, and instructions
 * the agent receives.
 *
 * This replaces the monolithic getProjectSpecificContext() in overnight.ts
 * with targeted, role-specific context loading.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Goal } from './goal-manager.js';
import { getProject, getAllProjects } from '../projects/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ──────────────────────────────────────────────────

export type AgentArchetype =
  | 'frontend'
  | 'backend'
  | 'integration'
  | 'test-fix'
  | 'docs'
  | 'devops'
  | 'research'
  | 'ux-consolidation'
  | 'design-research';

export interface ArchetypeConfig {
  name: AgentArchetype;
  description: string;
  contextDocs: string[];        // filenames to look for in project root
  promptAdditions: string;      // archetype-specific instructions
  modelPreference: 'ancillary' | 'secondary' | 'primary';
  useSequentialThinking: boolean; // enable mcp__thinking__sequentialthinking
  /** MCP tools to explicitly enable for this archetype (passed as --allowedTools) */
  allowedTools?: string[];
}

// ── Archetype Definitions ──────────────────────────────────

const ARCHETYPES: Record<AgentArchetype, ArchetypeConfig> = {
  frontend: {
    name: 'frontend',
    description: 'UI/UX work: pages, components, styling, layouts',
    contextDocs: ['DESIGN.md', 'STYLE_GUIDE.md', 'COMPONENT_GUIDE.md'],
    promptAdditions: `## Frontend Agent Guidelines
- Your scope is: templates, components, stylesheets, layouts, and route handlers that render pages
- Only modify files in the presentation layer (templates/, components/, pages/, styles/, routes that render views)
- Before building, look at adjacent pages/components in the project for design patterns
- Match existing spacing, fonts, and color patterns — reuse existing design tokens
- For React/Next: prefer existing component library over custom elements
- Verify your changes visually before declaring GOAL_COMPLETE`,
    modelPreference: 'secondary',
    useSequentialThinking: true,
    allowedTools: ['mcp__puppeteer__puppeteer_screenshot', 'mcp__puppeteer__puppeteer_navigate', 'mcp__puppeteer__puppeteer_click'],
  },

  backend: {
    name: 'backend',
    description: 'API, database, server-side logic',
    contextDocs: ['API.md', 'SCHEMA.md', 'DATABASE.md'],
    promptAdditions: `## Backend Agent Guidelines
- Your scope is: data models, services, pipelines, CLI scripts, API routes, and tests
- Only modify files in the data/logic layer (models/, services/, pipelines/, api/, db/, tests/)
- Run tests before AND after changes to catch regressions
- Check for existing test patterns before writing new tests
- Validate API contracts match expected request/response shapes
- Test database migration rollback before committing schema changes
- Log meaningful errors with context, not raw stack traces
- Verification: unit tests and API-level checks only — use curl for endpoint checks`,
    modelPreference: 'secondary',
    useSequentialThinking: false,
    allowedTools: ['mcp__thinking__sequentialthinking'],
  },

  integration: {
    name: 'integration',
    description: 'Cross-project work, E2E flows, system integration',
    contextDocs: ['CLAUDE.md', 'README.md', 'API.md'],
    promptAdditions: `## Integration Agent Guidelines
- Read CLAUDE.md and README for ALL involved projects before starting
- Understand the data flow between systems before making changes
- Test the full integration path, not just your changes in isolation
- Be aware of API versioning and backwards compatibility
- Changes in one project may require coordinated changes in another`,
    modelPreference: 'primary',
    useSequentialThinking: true,
    allowedTools: ['mcp__thinking__sequentialthinking', 'mcp__puppeteer__puppeteer_screenshot', 'mcp__puppeteer__puppeteer_navigate'],
  },

  'test-fix': {
    name: 'test-fix',
    description: 'Fix failing tests, add test coverage',
    contextDocs: [],
    promptAdditions: `## Test Fix Agent Guidelines
- Read the FULL test output to understand the failure before making changes
- Focus on root cause — don't just suppress errors or skip tests
- Check if the test is testing the right behavior (sometimes the test is wrong)
- Run the specific failing test first, then the full suite after fixing
- Keep test scope narrow — fix the failing test, don't refactor the whole suite`,
    modelPreference: 'secondary',
    useSequentialThinking: false,
    allowedTools: [],
  },

  docs: {
    name: 'docs',
    description: 'Documentation, READMEs, comments, guides',
    contextDocs: ['README.md', 'CLAUDE.md'],
    promptAdditions: `## Documentation Agent Guidelines
- Follow existing documentation style in the project
- Keep docs concise and actionable — developers read docs to DO things
- Include code examples where helpful
- Don't duplicate information that exists elsewhere — link to it
- Update Table of Contents if the doc has one`,
    modelPreference: 'ancillary',
    useSequentialThinking: false,
    allowedTools: [],
  },

  devops: {
    name: 'devops',
    description: 'CI/CD, infrastructure, deployment, configuration',
    contextDocs: ['DEPLOYMENT.md', 'INFRA.md'],
    promptAdditions: `## DevOps Agent Guidelines
- Test configuration changes in isolation before applying broadly
- Store secrets in environment variables or secret managers — always use references, not literals
- Verify existing pipelines still pass after your changes
- Document any new environment variables or configuration requirements
- Plan rollback scenarios for infrastructure changes before applying them`,
    modelPreference: 'secondary',
    useSequentialThinking: false,
    allowedTools: [],
  },

  research: {
    name: 'research',
    description: 'Patent research, competitive analysis, strategy, investigation',
    contextDocs: ['ROADMAP.md', 'README.md'],
    promptAdditions: `## Research & Strategy Agent Guidelines
- This is a NON-CODING archetype — your output is structured documents, not code changes
- Read existing research in docs/patents/, research/, or similar directories before starting
- Structure findings with: Executive Summary, Key Findings, Analysis, Recommendations
- Cite sources and provide links where possible
- Use the sequential-thinking tool for complex analysis and multi-faceted comparisons
- Save research outputs to appropriate project directories (docs/, research/, etc.)
- Be thorough but concise — aim for actionable insights, not exhaustive surveys
- When investigating bugs or system issues, document root cause, impact, and fix recommendations
- For patent/IP research: document novel aspects, prior art, and differentiation clearly`,
    modelPreference: 'primary',
    useSequentialThinking: true,
    allowedTools: ['mcp__thinking__sequentialthinking', 'WebSearch', 'WebFetch'],
  },

  'ux-consolidation': {
    name: 'ux-consolidation',
    description: 'Simplify navigation, merge redundant pages, remove empty/dead features',
    contextDocs: ['README.md', 'DESIGN.md'],
    promptAdditions: `## UX Consolidation Agent Guidelines
You are a UX consolidation specialist. Your goal is to simplify the app's navigation and reduce feature bloat.

Rules:
- Remove empty or placeholder pages entirely — consolidate into real content pages
- Merge pages that serve nearly identical purposes into a single, cleaner page
- Simplify navigation — fewer top-level items is always better
- Preserve all working functionality — consolidation means reorganizing, not deleting features
- Update all navigation links/routes after consolidation
- Run the app and visually verify the result`,
    modelPreference: 'secondary',
    useSequentialThinking: true,
    allowedTools: ['mcp__puppeteer__puppeteer_screenshot', 'mcp__puppeteer__puppeteer_navigate', 'mcp__puppeteer__puppeteer_click'],
  },

  'design-research': {
    name: 'design-research',
    description: 'Two-phase design research: competitor audit → implementation proposal with STYLE.md',
    contextDocs: ['DESIGN.md', 'STYLE.md', 'ROADMAP.md', 'README.md'],
    promptAdditions: `## Design Research Agent Guidelines
You are a design research specialist running a structured two-phase process.

### Phase 1 — Competitive Research & Audit
- Research 5–8 competitor/best-in-class apps in the same domain
- For each competitor, document: name, URL, screenshots/descriptions, standout UX patterns, navigation structure, design tokens (colors, typography, spacing)
- Identify the top 3 UX patterns worth adopting and explain WHY
- Produce a structured research document saved to docs/design-research/

### Phase 2 — Implementation Proposal (STYLE.md + Goal Templates)
- Synthesize Phase 1 findings into a concrete STYLE.md (design tokens, component patterns, spacing scale, color palette)
- Generate a prioritized list of goal templates (title + description) that implement the design vision
- Each goal template must include TEST_COMMANDS for smoke-test verification
- Save STYLE.md to project root, goal templates to docs/design-research/goal-templates.md

### Output Format
Your output document must include:
1. **Executive Summary** — 3-sentence overview of findings and recommendation
2. **Competitor Matrix** — table comparing features, UX patterns, design quality
3. **Recommended Patterns** — top patterns to adopt with rationale
4. **STYLE.md Draft** (Phase 2 only) — ready to commit design tokens
5. **Goal Templates** (Phase 2 only) — ready-to-dispatch implementation goals

### Rules
- Use WebSearch and WebFetch tools to research competitors
- Use sequential-thinking for multi-faceted analysis
- Save all research artifacts to docs/design-research/ directory
- This is a NON-CODING archetype in Phase 1 — output is research documents
- Phase 2 produces STYLE.md (code artifact) + goal templates (planning artifact)`,
    modelPreference: 'primary',
    useSequentialThinking: true,
    allowedTools: ['mcp__thinking__sequentialthinking', 'WebSearch', 'WebFetch'],
  },
};

// ── Classification ─────────────────────────────────────────

/**
 * Classify a goal into an archetype based on title and description.
 */
export function classifyGoalArchetype(goal: Goal): AgentArchetype {
  const text = `${goal.title} ${goal.description || ''}`.toLowerCase();
  const titleText = goal.title.toLowerCase();

  // Test fix — high priority match
  if (/\b(fix test|fix failing|failing test|test failure|broken test|test broken|test fix)\b/.test(text)) {
    return 'test-fix';
  }

  // Design Research — two-phase design research (competitor audit → proposal)
  if (/\b(design.?research|competitor.?audit|ux.?audit|style.?guide.?research|design.?system.?research|competitive.?ux)\b/.test(titleText)) {
    return 'design-research';
  }

  // Research & Strategy — match primarily on TITLE to avoid false positives
  // from detailed implementation descriptions that mention "analysis" etc.
  // Note: "investigate" alone is too broad — "Investigate and fix bug" is not research.
  // Require "investigate" + research-y context, or match compound research phrases.
  if (/\b(research|patent|competitive analysis|strategy|survey|prior art|market research|landscape|feasibility|spike)\b/.test(titleText)) {
    return 'research';
  }
  if (/\binvestigat\w*\b/.test(titleText) && !/\b(fix|bug|crash|error|broken|implement|add|build|create)\b/.test(titleText)) {
    return 'research';
  }

  // Documentation
  if (/\b(update readme|add docs|documentation|write guide|add comment|jsdoc|doc update)\b/.test(text)) {
    return 'docs';
  }

  // DevOps — "config" alone is too broad (any goal mentioning config files).
  // Require compound config phrases or match specific devops keywords.
  if (/\b(deploy|ci\/cd|pipeline|docker|infra|build system|launchd|cron|daemon setup)\b/.test(text)) {
    return 'devops';
  }
  if (/\b(config(?:ure|uration)?)\b/.test(text) && /\b(deploy|ci|cd|docker|infra|server|nginx|env|environment|k8s|kubernetes|aws|gcp|cloud)\b/.test(text)) {
    return 'devops';
  }

  // Integration — cross-project or E2E
  // "connect.*to" was too broad (matches "connect button to handler").
  // Require integration-specific connect phrases.
  if (/\b(cross-project|multi-project|integration|e2e|end-to-end|sync between)\b/.test(text)) {
    return 'integration';
  }
  if (/\bconnect\s+\w+\s+to\s+\w+\s+(api|service|server|backend|system|database|endpoint)\b/.test(text)) {
    return 'integration';
  }

  // UX Consolidation — before frontend
  if (/\b(consolidat\w*|simplif\w*|merge.*page|remove.*empty|reduce.*nav|ux.?cleanup|navigation.*simplif|dead.?page|orphan.?feature)\b/i.test(text)) {
    return 'ux-consolidation';
  }

  // Frontend/UI — "design" alone is too broad ("design the API schema" is not frontend).
  // Keep "design" only when combined with UI context, or match specific UI keywords.
  if (/\b(ui|ux|page|button|layout|component|responsive|mobile|sidebar|modal|dashboard|card|navigation|tab|form|display|visual|style|css|scss|tailwind|frontend|overhaul|redesign)\b/.test(text)) {
    return 'frontend';
  }
  if (/\bdesign\b/.test(text) && /\b(ui|ux|page|layout|component|screen|view|interface|mockup|wireframe|visual)\b/.test(text)) {
    return 'frontend';
  }

  // Backend
  if (/\b(api|endpoint|route|backend|server|database|query|migration|schema|graphql|rest|middleware|auth|session|token)\b/.test(text)) {
    return 'backend';
  }

  // Default: if it's a bug fix, treat as backend unless UI-related
  // "error" alone is too broad — "Display error messages on form" is frontend.
  // Match "error" only in bug-fix context.
  if (/\b(fix|bug|broken|regression|crash)\b/.test(text)) {
    return 'backend';
  }
  if (/\berror\b/.test(text) && /\b(handling|handler|catch|throw|exception|log|trace|500|server|api|backend)\b/.test(text)) {
    return 'backend';
  }

  // If nothing matches, default based on complexity
  return 'backend';
}

/**
 * Determine if an agent should use sequential thinking based on archetype + goal type.
 * Goal-type overrides: new-feature and integration always get thinking.
 */
export function shouldUseSequentialThinking(
  archetype: AgentArchetype,
  goalType: string,
): boolean {
  const config = ARCHETYPES[archetype];
  if (config.useSequentialThinking) return true;
  if (goalType === 'new-feature' || goalType === 'integration') return true;
  return false;
}

// ── Context Loading ────────────────────────────────────────

/**
 * Load a DESIGN.md (or similar doc) from a project root if it exists.
 */
export function loadDesignDoc(projectName: string): string | null {
  try {
    const project = getProject(projectName);
    const designPath = join(project.path, 'DESIGN.md');
    if (existsSync(designPath)) {
      const content = readFileSync(designPath, 'utf-8');
      // Cap at 3000 chars to avoid bloating agent context
      return content.slice(0, 3000);
    }
  } catch { /* project not found */ }
  return null;
}

/**
 * Load a specific doc from project root if it exists.
 */
function loadProjectDoc(projectPath: string, filename: string): string | null {
  const filePath = join(projectPath, filename);
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf-8');
    return content.slice(0, 2000); // Cap per-doc size
  }
  return null;
}

/**
 * Build the full context string for an archetype working on a project.
 *
 * Includes:
 * - Archetype-specific instructions (prompt additions)
 * - Loaded context documents (DESIGN.md, API.md, etc.)
 * - Project-specific setup info (dev commands, ports, URLs)
 */
export function getArchetypeContext(archetype: AgentArchetype, projectName: string): string {
  const config = ARCHETYPES[archetype];
  const sections: string[] = [];

  // 1. Archetype instructions
  sections.push(config.promptAdditions);

  // 2. Load context documents
  try {
    const project = getProject(projectName);
    const loadedDocs: string[] = [];

    for (const docName of config.contextDocs) {
      const content = loadProjectDoc(project.path, docName);
      if (content) {
        loadedDocs.push(`### ${docName}\n${content}`);
      }
    }

    if (loadedDocs.length > 0) {
      sections.push(`## Project Documentation\n${loadedDocs.join('\n\n')}`);
    }
  } catch { /* project not found — skip docs */ }

  // 3. Project-specific setup (dev server, URLs, test commands)
  const setupInfo = getProjectSetup(projectName);
  if (setupInfo) {
    sections.push(setupInfo);
  }

  // 4. Sequential thinking prompt (if enabled for this archetype)
  if (config.useSequentialThinking) {
    sections.push(`## Structured Reasoning
For complex decisions (architecture choices, component design, multi-step debugging), use the sequential-thinking tool (mcp__thinking__sequentialthinking) to break down your reasoning. This helps plan before implementing and consider alternatives. Skip it for simple/obvious tasks.`);
  }

  // 5. Self-verification protocol (archetype-appropriate)
  const verifyProtocol = getSelfVerificationProtocol(projectName, config.name);
  if (verifyProtocol) {
    sections.push(verifyProtocol);
  }

  return sections.join('\n\n');
}

/**
 * Get project setup info (dev server, URLs, test commands).
 * Dynamically built from config/projects.yaml.
 */
function getProjectSetup(projectName: string): string | null {
  const config = getProject(projectName);
  if (!config) return null;

  const lines = [`## Project Setup: ${projectName}`];
  if (config.path) lines.push(`- Path: \`${config.path}\``);
  if (config.devCommand) lines.push(`- Dev server: \`${config.devCommand}\``);
  if (config.devPort) lines.push(`- URL: http://localhost:${config.devPort}`);
  if (config.description) lines.push(`- ${config.description}`);

  return lines.join('\n');
}

/**
 * Get the visual verification protocol for a project.
 * Frontend/UX agents get a screenshot tool so they can SEE their work.
 * Returns null if the project has no dev server URL.
 */
export function getSelfVerificationProtocol(projectName: string, archetype: string): string | null {
  try {
    const project = getProject(projectName);

    if (archetype === 'frontend' || archetype === 'ux-consolidation' || archetype === 'integration') {
      if (!project.devPort && !project.healthCheck) return null;
      const baseUrl = project.devPort
        ? `http://localhost:${project.devPort}`
        : project.healthCheck!;
      const tool = join(__dirname, '../tools/screenshot.js');

      return `## Visual Verification (REQUIRED)
You MUST screenshot and review every page you changed before GOAL_COMPLETE.

1. Capture: \`node ${tool} ${baseUrl}/<page>\`
   Add \`--mobile\` for mobile view (375px). Default is desktop (1280px).
2. Read the PNG path printed to stdout — you will see the rendered page.
3. If the layout is broken, misaligned, or content is missing — fix it and re-verify.

Do NOT skip this step. Code that looks correct often renders incorrectly.
Screenshot at least the primary page you changed, at desktop width.`;
    }

    if (archetype === 'backend') {
      return `## Verify Your Work
Before GOAL_COMPLETE, run the relevant tests or curl the affected endpoints to confirm your changes work. Check for regressions.`;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the archetype configuration for a given archetype name.
 */
export function getArchetypeConfig(archetype: AgentArchetype): ArchetypeConfig {
  return ARCHETYPES[archetype];
}

/**
 * Get all archetype names.
 */
export function listArchetypes(): AgentArchetype[] {
  return Object.keys(ARCHETYPES) as AgentArchetype[];
}
