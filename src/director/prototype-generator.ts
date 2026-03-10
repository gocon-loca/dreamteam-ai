/**
 * Visual Prototype Generator — HTML prototype generation (3 options)
 *
 * Generates 2-3 competing IA options as interactive HTML prototypes
 * based on audit data and competitor research.
 *
 * Prototypes saved to data/prototypes/{project}-option-{a,b,c}.html
 */

import { spawn } from 'child_process';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { homedir } from 'os';
import { getLatestAudit } from './app-audit.js';
import { getLatestResearch } from './product-research.js';
import { getTailscaleIp } from '../projects/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const PROTOTYPES_DIR = join(DATA_DIR, 'prototypes');
const URL_FILE = join(DATA_DIR, 'prototype-url.txt');

/**
 * Get the base URL for prototype links (tunnel URL if available, else Tailscale IP).
 * The prototype server writes data/prototype-url.txt on startup.
 */
export function getPrototypeBaseUrl(): string {
  if (existsSync(URL_FILE)) {
    const url = readFileSync(URL_FILE, 'utf-8').trim();
    if (url && !url.includes('0.0.0.0')) return url;
  }
  return `http://${getTailscaleIp()}:8080`;
}

// ── Types ──────────────────────────────────────────────────

export interface PrototypeSet {
  project: string;
  timestamp: string;
  options: PrototypeOption[];
  costUsd: number;
}

export interface PrototypeOption {
  id: 'a' | 'b' | 'c';
  label: string;
  rationale: string;
  inspiredBy: string[];
  tabs: string[];
  filePath: string;
  url: string;
}

interface OptionSpec {
  id: 'a' | 'b' | 'c';
  strategy: string;
  description: string;
}

// ── Generator ──────────────────────────────────────────────

export async function generatePrototypes(projectName: string): Promise<PrototypeSet> {
  const audit = getLatestAudit(projectName);
  const research = getLatestResearch(projectName);

  if (!audit) {
    throw new Error(`No audit data for ${projectName}. Run /audit first.`);
  }

  const featureNames = audit.features.map(f => f.name).join(', ');
  const currentNav = `${audit.navigation.type} with ${audit.navigation.totalItems} items`;

  const researchContext = research
    ? `\n\nCompetitor research:\n${research.competitors.map(c =>
        `- ${c.name}: ${c.navPattern.type}, tabs: ${c.navPattern.topLevelItems.join(', ')}`
      ).join('\n')}\n\nRecommended IA: ${research.recommendation.proposedTabs.join(' | ')} — ${research.recommendation.rationale}`
    : '';

  const optionSpecs: OptionSpec[] = [
    {
      id: 'a',
      strategy: 'Conservative',
      description: 'Closest to current navigation, minimal disruption. Keep most existing tabs but clean up empty/broken ones.',
    },
    {
      id: 'b',
      strategy: 'Research-aligned',
      description: research
        ? `Follow the recommended IA from research: ${research.recommendation.proposedTabs.join(' | ')}. ${research.recommendation.rationale}`
        : 'Balanced approach — moderate consolidation based on common patterns in similar apps.',
    },
    {
      id: 'c',
      strategy: 'Ambitious',
      description: 'Aggressive consolidation — fewest possible tabs. Merge related features into unified views.',
    },
  ];

  if (!existsSync(PROTOTYPES_DIR)) {
    mkdirSync(PROTOTYPES_DIR, { recursive: true });
  }

  const protoBaseUrl = getPrototypeBaseUrl();
  let totalCost = 0;
  const options: PrototypeOption[] = [];

  console.log(`[Prototype] Generating 3 options for ${projectName}...`);

  // Generate all 3 options in parallel
  const results = await Promise.all(
    optionSpecs.map(spec => generateSinglePrototype(projectName, spec, featureNames, currentNav, researchContext))
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const spec = optionSpecs[i];
    const filePath = join(PROTOTYPES_DIR, `${projectName}-option-${spec.id}.html`);

    writeFileSync(filePath, result.html);
    totalCost += result.costUsd;

    options.push({
      id: spec.id,
      label: result.label || `${spec.strategy}: ${spec.id.toUpperCase()}`,
      rationale: result.rationale || spec.description,
      inspiredBy: result.inspiredBy || [],
      tabs: result.tabs || [],
      filePath,
      url: `${protoBaseUrl}/prototypes/${projectName}-option-${spec.id}.html`,
    });
  }

  const prototypeSet: PrototypeSet = {
    project: projectName,
    timestamp: new Date().toISOString(),
    options,
    costUsd: totalCost,
  };

  // Save metadata
  writeFileSync(
    join(PROTOTYPES_DIR, `${projectName}-prototypes.json`),
    JSON.stringify(prototypeSet, null, 2)
  );

  console.log(`[Prototype] Complete. 3 options generated. Cost: $${totalCost.toFixed(4)}`);

  return prototypeSet;
}

interface PrototypeResult {
  html: string;
  label: string;
  rationale: string;
  inspiredBy: string[];
  tabs: string[];
  costUsd: number;
}

async function generateSinglePrototype(
  projectName: string,
  spec: OptionSpec,
  featureNames: string,
  currentNav: string,
  researchContext: string,
): Promise<PrototypeResult> {
  const prompt = `Generate a single self-contained HTML file for a mobile app prototype.

## App: ${projectName}
Current navigation: ${currentNav}
Real features: ${featureNames}
${researchContext}

## Option ${spec.id.toUpperCase()} — ${spec.strategy}
${spec.description}

## Requirements
- Self-contained HTML with Tailwind CDN (https://cdn.tailwindcss.com)
- Mobile-first: 375px viewport
- Clickable bottom tab bar showing proposed navigation
- Tapping tabs shows page content layout with placeholder boxes using REAL feature names from the audit
- Include a rationale banner at the top explaining this option's strategy
- Clean, modern design with proper spacing
- Each tab's content should show realistic layout for that section

## Output Format
First, output a JSON line with metadata, then the full HTML:
{"label": "<short label, e.g. '4 tabs, library-focused'>", "rationale": "<why this option>", "inspiredBy": ["<competitor names>"], "tabs": ["<tab1>", "<tab2>"]}
---HTML---
<!DOCTYPE html>
<html>
...entire HTML file...
</html>`;

  const result = await runSonnet(prompt);

  // Parse metadata + HTML
  let label = spec.strategy;
  let rationale = spec.description;
  let inspiredBy: string[] = [];
  let tabs: string[] = [];
  let html = result.text;

  const htmlSeparator = result.text.indexOf('---HTML---');
  if (htmlSeparator !== -1) {
    const metadataStr = result.text.slice(0, htmlSeparator).trim();
    html = result.text.slice(htmlSeparator + '---HTML---'.length).trim();

    try {
      const jsonMatch = metadataStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const metadata = JSON.parse(jsonMatch[0]);
        label = metadata.label || label;
        rationale = metadata.rationale || rationale;
        inspiredBy = metadata.inspiredBy || [];
        tabs = metadata.tabs || [];
      }
    } catch { /* use defaults */ }
  } else {
    // Try to extract HTML from response
    const htmlMatch = result.text.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
    if (htmlMatch) {
      html = htmlMatch[0];
    }
  }

  return { html, label, rationale, inspiredBy, tabs, costUsd: result.costUsd };
}

// ── Final Prototype (for hybrid choices) ────────────────────

export async function generateFinalPrototype(
  projectName: string,
  userChoice: string,
  existingOptions: PrototypeOption[],
): Promise<string> {
  const audit = getLatestAudit(projectName);
  const featureNames = audit ? audit.features.map(f => f.name).join(', ') : 'unknown features';

  const optionsSummary = existingOptions.map(o =>
    `Option ${o.id.toUpperCase()} (${o.label}): tabs = ${o.tabs.join(', ')}. ${o.rationale}`
  ).join('\n');

  const prompt = `Generate a final hybrid HTML prototype based on user feedback.

## App: ${projectName}
Features: ${featureNames}

## Existing Options
${optionsSummary}

## User's Request
"${userChoice}"

## Requirements
- Self-contained HTML with Tailwind CDN (https://cdn.tailwindcss.com)
- Mobile-first: 375px viewport
- Clickable bottom tab bar with the FINAL navigation
- Content for each tab using real feature names
- Banner at top: "Final Design — Custom hybrid based on your feedback"
- Respond with ONLY the HTML file, no other text`;

  const result = await runSonnet(prompt);

  let html = result.text;
  const htmlMatch = result.text.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
  if (htmlMatch) html = htmlMatch[0];

  const filePath = join(PROTOTYPES_DIR, `${projectName}-final.html`);
  writeFileSync(filePath, html);

  return filePath;
}

// ── Claude CLI ──────────────────────────────────────────────

interface SonnetResult {
  text: string;
  costUsd: number;
}

async function runSonnet(prompt: string): Promise<SonnetResult> {
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

    // Timeout after 3 minutes
    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Sonnet prototype generation timed out after 3 minutes'));
    }, 180_000);
  });
}
