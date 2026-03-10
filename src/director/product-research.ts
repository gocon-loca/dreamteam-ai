/**
 * Product Research Agent — Sonnet + web search competitor analysis
 *
 * Researches competitor apps before proposing UX changes.
 * Uses Claude CLI with Sonnet model to search and analyze.
 *
 * Results saved to data/research/{project}-ux-research.json
 */

import { spawn } from 'child_process';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { homedir } from 'os';
import { getProject } from '../projects/registry.js';
import { getLatestAudit } from './app-audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const RESEARCH_DIR = join(DATA_DIR, 'research');

// ── Types ──────────────────────────────────────────────────

export interface UxResearch {
  project: string;
  timestamp: string;
  competitors: Competitor[];
  commonPatterns: UxPattern[];
  recommendation: {
    proposedTabs: string[];
    rationale: string;
    inspiredBy: string[];
  };
  costUsd: number;
}

export interface Competitor {
  name: string;
  url: string;
  category: string;
  navPattern: {
    type: 'bottom-tabs' | 'sidebar' | 'hamburger' | 'top-tabs';
    topLevelItems: string[];
    nestingDepth: number;
  };
  strengths: string[];
}

export interface UxPattern {
  pattern: string;
  prevalence: string;
  reasoning: string;
}

// ── Research Agent ──────────────────────────────────────────

export async function runProductResearch(projectName: string): Promise<UxResearch> {
  const project = getProject(projectName);
  const audit = getLatestAudit(projectName);

  const auditContext = audit
    ? `\n\n## Current App Audit\nPages: ${audit.pages.length}\nNav type: ${audit.navigation.type} (${audit.navigation.totalItems} items)\nFeatures: ${audit.features.map(f => f.name).join(', ')}\nUX Issues: ${audit.uxIssues.map(i => i.description).join('; ')}\nSummary: ${audit.summary}`
    : '';

  const prompt = `You are a UX researcher analyzing competitor apps for "${projectName}".

## Project Description
${project.description || projectName}
${auditContext}

## Task
1. Search for 3-5 competitor/comparable apps in the same category as ${projectName}
2. For each competitor, analyze their navigation patterns (tab count, nesting, sidebar vs bottom nav)
3. Identify common UX patterns across these competitors
4. Recommend an information architecture based on what works in the market

## Output Format
Respond with ONLY a JSON object (no markdown, no code fences) matching this exact structure:
{
  "competitors": [
    {
      "name": "<app name>",
      "url": "<website url>",
      "category": "<app category>",
      "navPattern": {
        "type": "<bottom-tabs|sidebar|hamburger|top-tabs>",
        "topLevelItems": ["<item1>", "<item2>"],
        "nestingDepth": <number>
      },
      "strengths": ["<strength1>", "<strength2>"]
    }
  ],
  "commonPatterns": [
    {
      "pattern": "<e.g. 'Bottom tab bar with 4-5 items'>",
      "prevalence": "<e.g. '4/5 competitors'>",
      "reasoning": "<why this pattern works>"
    }
  ],
  "recommendation": {
    "proposedTabs": ["<tab1>", "<tab2>", "<tab3>", "<tab4>"],
    "rationale": "<why this IA works for ${projectName}>",
    "inspiredBy": ["<competitor1>", "<competitor2>"]
  }
}

Be thorough in your research. Use web search to find real competitor apps and their actual navigation patterns.`;

  console.log(`[Research] Starting product research for ${projectName}...`);

  const result = await runSonnetWithSearch(prompt);

  let analysis: Omit<UxResearch, 'project' | 'timestamp' | 'costUsd'>;
  try {
    analysis = JSON.parse(result.text);
  } catch {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysis = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('Sonnet returned non-JSON response for research');
    }
  }

  const research: UxResearch = {
    project: projectName,
    timestamp: new Date().toISOString(),
    competitors: analysis.competitors || [],
    commonPatterns: analysis.commonPatterns || [],
    recommendation: analysis.recommendation || { proposedTabs: [], rationale: '', inspiredBy: [] },
    costUsd: result.costUsd,
  };

  // Save to disk
  if (!existsSync(RESEARCH_DIR)) {
    mkdirSync(RESEARCH_DIR, { recursive: true });
  }
  writeFileSync(
    join(RESEARCH_DIR, `${projectName}-ux-research.json`),
    JSON.stringify(research, null, 2)
  );

  console.log(`[Research] Complete. ${research.competitors.length} competitors analyzed. Cost: $${research.costUsd.toFixed(4)}`);

  return research;
}

export function getLatestResearch(project: string): UxResearch | null {
  const filePath = join(RESEARCH_DIR, `${project}-ux-research.json`);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function isResearchStale(project: string): boolean {
  const filePath = join(RESEARCH_DIR, `${project}-ux-research.json`);
  if (!existsSync(filePath)) return true;

  try {
    const research: UxResearch = JSON.parse(readFileSync(filePath, 'utf-8'));
    const ageMs = Date.now() - new Date(research.timestamp).getTime();
    return ageMs > 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

export function formatResearchSummary(research: UxResearch): string {
  const lines: string[] = [];

  lines.push(`🔍 UX Research: ${research.project}`);
  lines.push('');

  lines.push('Competitors analyzed:');
  for (const c of research.competitors) {
    lines.push(`  • ${c.name} (${c.navPattern.type}, ${c.navPattern.topLevelItems.length} tabs)`);
    lines.push(`    ${c.navPattern.topLevelItems.join(' | ')}`);
  }

  lines.push('');
  lines.push('Common patterns:');
  for (const p of research.commonPatterns) {
    lines.push(`  • ${p.pattern} (${p.prevalence})`);
  }

  lines.push('');
  lines.push('💡 Recommended IA:');
  lines.push(`  Tabs: ${research.recommendation.proposedTabs.join(' | ')}`);
  lines.push(`  ${research.recommendation.rationale}`);
  lines.push(`  Inspired by: ${research.recommendation.inspiredBy.join(', ')}`);

  lines.push('');
  lines.push(`💰 Cost: $${research.costUsd.toFixed(4)}`);

  return lines.join('\n');
}

// ── Claude CLI with Web Search ──────────────────────────────

interface SonnetResult {
  text: string;
  costUsd: number;
}

async function runSonnetWithSearch(prompt: string): Promise<SonnetResult> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');

    const proc = spawn(claudePath, [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', 'claude-sonnet-4-5',
      '--allowedTools', 'WebSearch',
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

    // Timeout after 3 minutes (web search may be slow)
    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Sonnet research timed out after 3 minutes'));
    }, 180_000);
  });
}
