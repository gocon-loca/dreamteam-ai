/**
 * Workflow Loader — Per-project WORKFLOW.md support
 *
 * Inspired by OpenAI Symphony: instead of all agent behavior being defined
 * centrally in prompt-builder.ts, each project can have a WORKFLOW.md file
 * in its root directory that defines project-specific agent instructions,
 * hooks, and constraints. This version-controls agent behavior with the codebase.
 *
 * WORKFLOW.md format uses YAML front matter (between --- delimiters) for
 * structured config, plus a markdown body for free-form instructions.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProject } from '../projects/registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailureMode {
  /** Short label, e.g. "SCOPE_CREEP" */
  name: string;
  /** What this violation looks like */
  description: string;
  /** What to do instead */
  prevention: string;
}

export interface WorkflowConfig {
  /** Project-specific rules the agent must follow */
  rules?: string[];
  /** Named failure modes the agent should avoid */
  failureModes?: FailureMode[];
  /** Pre-completion checklist items */
  completionChecklist?: string[];
  /** Files the agent should read first for context */
  contextFiles?: string[];
  /** Custom environment setup commands */
  setupCommands?: string[];
  /** Free-form markdown body (content after the YAML front matter) */
  markdownBody?: string;
}

// ---------------------------------------------------------------------------
// YAML front-matter parser (no external dependency)
// ---------------------------------------------------------------------------

/**
 * Minimal YAML parser that handles:
 * - Simple key: value pairs
 * - Arrays via leading `  - ` indent
 * - Objects nested inside array items (failureModes)
 *
 * This is intentionally limited — it only needs to parse the fields
 * defined in WorkflowConfig, not arbitrary YAML.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  let currentObject: Record<string, string> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }

    // Top-level key (no leading whitespace)
    const topLevelMatch = line.match(/^(\w[\w\-]*):\s*(.*)/);
    if (topLevelMatch) {
      // Flush previous state
      if (currentKey && currentArray) {
        if (currentObject && Object.keys(currentObject).length > 0) {
          currentArray.push(currentObject);
          currentObject = null;
        }
        result[currentKey] = currentArray;
      }

      const key = topLevelMatch[1];
      const inlineValue = topLevelMatch[2].trim();

      if (inlineValue) {
        // Simple scalar value: key: value
        result[key] = unquote(inlineValue);
        currentKey = null;
        currentArray = null;
      } else {
        // Array or nested structure follows
        currentKey = key;
        currentArray = [];
        currentObject = null;
      }
      continue;
    }

    // Array item: `  - value` or `  - name: value` (start of object)
    const arrayItemMatch = line.match(/^\s+-\s+(.*)/);
    if (arrayItemMatch && currentKey && currentArray) {
      // Flush any pending object
      if (currentObject && Object.keys(currentObject).length > 0) {
        currentArray.push(currentObject);
        currentObject = null;
      }

      const itemContent = arrayItemMatch[1].trim();
      const kvMatch = itemContent.match(/^(\w[\w\-]*):\s*(.*)/);

      if (kvMatch) {
        // Start of an object inside the array: `  - name: SCOPE_CREEP`
        currentObject = { [kvMatch[1]]: unquote(kvMatch[2]) };
      } else {
        // Simple string array item: `  - Always run build`
        currentArray.push(unquote(itemContent));
      }
      continue;
    }

    // Nested object property: `    key: value` (deeper indent, no dash)
    const nestedMatch = line.match(/^\s{4,}(\w[\w\-]*):\s*(.*)/);
    if (nestedMatch && currentObject) {
      currentObject[nestedMatch[1]] = unquote(nestedMatch[2]);
      continue;
    }
  }

  // Flush final state
  if (currentKey && currentArray) {
    if (currentObject && Object.keys(currentObject).length > 0) {
      currentArray.push(currentObject);
    }
    result[currentKey] = currentArray;
  }

  return result;
}

/** Remove surrounding quotes from a YAML string value */
function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Front-matter extraction
// ---------------------------------------------------------------------------

interface ParsedFrontMatter {
  frontMatter: Record<string, unknown>;
  body: string;
}

/**
 * Split a WORKFLOW.md file into YAML front matter and markdown body.
 * Front matter is delimited by `---` on its own line at the start.
 */
function parseFrontMatter(content: string): ParsedFrontMatter {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith('---')) {
    // No front matter — entire file is markdown body
    return { frontMatter: {}, body: content.trim() };
  }

  // Find the closing `---`
  const afterFirst = trimmed.indexOf('\n');
  if (afterFirst === -1) {
    return { frontMatter: {}, body: '' };
  }

  const rest = trimmed.slice(afterFirst + 1);
  const closingIdx = rest.indexOf('\n---');

  if (closingIdx === -1) {
    // No closing delimiter — treat everything as front matter, no body
    return { frontMatter: parseSimpleYaml(rest), body: '' };
  }

  const yamlBlock = rest.slice(0, closingIdx);
  const body = rest.slice(closingIdx + 4).trim(); // skip past `\n---`

  return {
    frontMatter: parseSimpleYaml(yamlBlock),
    body,
  };
}

// ---------------------------------------------------------------------------
// Config extraction
// ---------------------------------------------------------------------------

function extractConfig(parsed: ParsedFrontMatter): WorkflowConfig {
  const fm = parsed.frontMatter;
  const config: WorkflowConfig = {};

  // rules: string[]
  if (Array.isArray(fm.rules)) {
    config.rules = fm.rules.filter((r): r is string => typeof r === 'string');
  }

  // failureModes: FailureMode[]
  if (Array.isArray(fm.failureModes)) {
    config.failureModes = fm.failureModes
      .filter((f): f is Record<string, string> =>
        typeof f === 'object' && f !== null && 'name' in f)
      .map(f => ({
        name: String(f.name || ''),
        description: String(f.description || ''),
        prevention: String(f.prevention || ''),
      }));
  }

  // completionChecklist: string[]
  if (Array.isArray(fm.completionChecklist)) {
    config.completionChecklist = fm.completionChecklist
      .filter((c): c is string => typeof c === 'string');
  }

  // contextFiles: string[]
  if (Array.isArray(fm.contextFiles)) {
    config.contextFiles = fm.contextFiles
      .filter((c): c is string => typeof c === 'string');
  }

  // setupCommands: string[]
  if (Array.isArray(fm.setupCommands)) {
    config.setupCommands = fm.setupCommands
      .filter((c): c is string => typeof c === 'string');
  }

  // Markdown body
  if (parsed.body) {
    config.markdownBody = parsed.body;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load WORKFLOW.md from a project's root directory.
 * Returns null if the file doesn't exist.
 */
export function loadWorkflow(projectName: string): WorkflowConfig | null {
  let projectPath: string;
  try {
    const project = getProject(projectName);
    projectPath = project.path;
  } catch {
    // Unknown project
    return null;
  }

  const workflowPath = join(projectPath, 'WORKFLOW.md');

  if (!existsSync(workflowPath)) {
    return null;
  }

  try {
    const content = readFileSync(workflowPath, 'utf-8');
    const parsed = parseFrontMatter(content);
    return extractConfig(parsed);
  } catch (err) {
    console.error(`[workflow-loader] Failed to parse ${workflowPath}:`, err);
    return null;
  }
}

/**
 * Load WORKFLOW.md from an arbitrary filesystem path.
 * Useful when working with worktrees or custom locations.
 */
export function loadWorkflowFromPath(dirPath: string): WorkflowConfig | null {
  const workflowPath = join(dirPath, 'WORKFLOW.md');

  if (!existsSync(workflowPath)) {
    return null;
  }

  try {
    const content = readFileSync(workflowPath, 'utf-8');
    const parsed = parseFrontMatter(content);
    return extractConfig(parsed);
  } catch (err) {
    console.error(`[workflow-loader] Failed to parse ${workflowPath}:`, err);
    return null;
  }
}

/**
 * Format a loaded workflow config into prompt text to inject
 * into the agent's instructions.
 */
export function formatWorkflowPrompt(config: WorkflowConfig): string {
  const sections: string[] = [];

  // Rules
  if (config.rules && config.rules.length > 0) {
    sections.push(
      '## Project Rules\n' +
      config.rules.map(r => `- ${r}`).join('\n')
    );
  }

  // Failure modes
  if (config.failureModes && config.failureModes.length > 0) {
    const modes = config.failureModes.map(fm =>
      `### ${fm.name}\n` +
      `**What it looks like:** ${fm.description}\n` +
      `**Prevention:** ${fm.prevention}`
    ).join('\n\n');
    sections.push(`## Failure Modes to Avoid\n\n${modes}`);
  }

  // Completion checklist
  if (config.completionChecklist && config.completionChecklist.length > 0) {
    sections.push(
      '## Pre-Completion Checklist\n' +
      config.completionChecklist.map(c => `- [ ] ${c}`).join('\n')
    );
  }

  // Context files hint
  if (config.contextFiles && config.contextFiles.length > 0) {
    sections.push(
      '## Required Reading\n' +
      'Read these files before starting work:\n' +
      config.contextFiles.map(f => `- \`${f}\``).join('\n')
    );
  }

  // Markdown body (free-form instructions)
  if (config.markdownBody) {
    sections.push(config.markdownBody);
  }

  return sections.join('\n\n');
}
