/**
 * Adora API client — reads product intelligence from Adora journey maps.
 *
 * Adora auto-maps screens, journeys, and interactions in our apps.
 * This module reads exported journey data and formats it for:
 * 1. Director prompt context (what does the app look like?)
 * 2. Review agent validation (did the agent remove a mapped screen?)
 *
 * Data source: data/adora/{project}-journey.json (manual export for now)
 * Future: Adora API when available (https://adora.so/docs/api)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ADORA_DIR = join(__dirname, '../../data/adora');

// ── Types ──────────────────────────────────────────────────

export interface AdoraScreen {
  name: string;
  url: string;
  screenshot?: string;
}

export interface AdoraJourney {
  name: string;
  steps: Array<string | { action?: string; page?: string; expectation?: string }>;
}

export interface AdoraIssue {
  screen: string;
  type: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface AdoraProjectData {
  screens: AdoraScreen[];
  journeys: AdoraJourney[];
  issues: AdoraIssue[];
  lastUpdated: string;
}

// ── Data Access ────────────────────────────────────────────

/**
 * Load Adora journey data for a project.
 * Returns null if no data file exists.
 */
export function getAdoraData(projectName: string): AdoraProjectData | null {
  const filePath = join(ADORA_DIR, `${projectName}-journey.json`);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ── Director Context ───────────────────────────────────────

/**
 * Format Adora data for injection into Director's system prompt.
 * Gives the Director knowledge about what screens exist, how they
 * connect, and what issues Adora's AI flagged.
 */
export function formatAdoraContext(projectName: string): string {
  const data = getAdoraData(projectName);
  if (!data) return '';

  let context = `\n### Product Map (from Adora — last updated ${data.lastUpdated})\n`;

  if (data.screens?.length > 0) {
    context += `**Screens (${data.screens.length}):**\n`;
    context += data.screens.map(s => `- ${s.name}: ${s.url}`).join('\n');
    context += '\n\n';
  }

  if (data.journeys?.length > 0) {
    context += `**User Journeys:**\n`;
    context += data.journeys.map(j => {
      const stepNames = (j.steps || []).map((s: any) =>
        typeof s === 'string' ? s : (s?.action || s?.page || '?')
      );
      return `- ${j.name}: ${stepNames.join(' → ')}`;
    }).join('\n');
    context += '\n\n';
  }

  if (data.issues?.length > 0) {
    context += `**Issues Flagged by Adora:**\n`;
    context += data.issues
      .sort((a, b) => {
        const order = { critical: 0, warning: 1, info: 2 };
        return order[a.severity] - order[b.severity];
      })
      .map(i => `- [${i.severity}] ${i.screen}: ${i.description}`)
      .join('\n');
    context += '\n\n';
  }

  return context;
}

// ── Review Agent Context ───────────────────────────────────

/**
 * Format Adora data for the review agent's rejection criteria.
 * Returns a string to append to the review prompt that instructs
 * the agent to reject changes that remove mapped screens.
 */
export function formatAdoraReviewContext(projectName: string): string {
  const data = getAdoraData(projectName);
  if (!data) return '';
  if (!data.screens || data.screens.length === 0) {
    // No screens data — check if we have journeys with page URLs instead
    if (!data.journeys?.length) return '';

    // Extract page URLs from journey steps as pseudo-screens
    const pages = new Set<string>();
    for (const j of data.journeys) {
      for (const step of j.steps || []) {
        const url = typeof step === 'string' ? step : step?.page;
        if (url) pages.add(url);
      }
    }
    if (pages.size === 0) return '';

    const journeyNames = data.journeys.map(j => {
      const stepNames = (j.steps || []).map((s: any) =>
        typeof s === 'string' ? s : (s?.action || s?.page || '?')
      );
      return `${j.name} (${stepNames.join(' → ')})`;
    }).join('; ');

    return `
## ADORA JOURNEY MAP (product intelligence)
Known pages: ${[...pages].join(', ')}
Journeys: ${journeyNames}
REJECT if the agent removed any of these known pages without being explicitly told to.
`;
  }

  const screenUrls = data.screens.map(s => s.url).join(', ');
  const journeyInfo = data.journeys?.length
    ? `\nJourneys: ${data.journeys.map(j => {
        const stepNames = (j.steps || []).map((s: any) =>
          typeof s === 'string' ? s : (s?.action || s?.page || '?')
        );
        return `${j.name} (${stepNames.join(' → ')})`;
      }).join('; ')}`
    : '';

  return `
## ADORA JOURNEY MAP (product intelligence)
Known screens: ${screenUrls}${journeyInfo}
REJECT if the agent removed any of these known screens without being explicitly told to.
REJECT if the agent broke a journey by removing a step from any mapped journey.
`;
}
