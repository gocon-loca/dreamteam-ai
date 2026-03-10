/**
 * Jam Enrichment — Fetches rich bug context from Jam MCP tools
 * and uses Opus to generate structured goal specs with auto TEST_COMMANDS.
 *
 * Called synchronously during goal creation when source is `jam:{id}`.
 * User waits ~30s, gets a richly enriched goal to review.
 *
 * Flow:
 * 1. Call Jam MCP tools to fetch all available data
 * 2. Spawn Opus single-shot to analyze data and produce structured JSON
 * 3. Return enriched goal spec with title, description, TEST_COMMANDS, jamContext
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { cleanEnvForClaude } from '../utils/clean-env.js';
import { createLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const log = createLogger('jam-enrichment');

// ── Types ──────────────────────────────────────────────────

export interface EnrichedJamGoal {
  title: string;
  description: string;
  complexity: 'routine' | 'complex';
  archetype: 'frontend' | 'backend' | 'integration';
  testCommands: string[];
  jamContext: {
    description?: string;
    transcript?: string;
    screenshotUrl?: string;
    consoleLogs?: string;
    failedRequests?: string;
    userEvents?: string;
  };
}

// ── Main Entry Point ──────────────────────────────────────

/**
 * Enrich a Jam bug report into a full goal spec.
 * Spawns Claude Opus with Jam MCP tools to fetch data and analyze.
 *
 * @param jamId - The Jam recording ID
 * @param project - The target project name
 * @param devPort - Optional dev server port for TEST_COMMANDS generation
 * @returns Enriched goal spec, or null if enrichment fails
 */
export async function enrichJamGoal(
  jamId: string,
  project: string,
  devPort?: number,
): Promise<EnrichedJamGoal | null> {
  const portHint = devPort ? `\nThe app runs on http://localhost:${devPort}` : '';

  const prompt = `You are analyzing a Jam bug recording to create a detailed goal spec for an autonomous coding agent.

Your task:
1. Call mcp__jam__getDetails with jamId "${jamId}" to get the bug description and metadata
2. Call mcp__jam__getScreenshots with jamId "${jamId}" to get screenshot URLs
3. Call mcp__jam__getConsoleLogs with jamId "${jamId}" to get JavaScript errors and warnings
4. Call mcp__jam__getNetworkRequests with jamId "${jamId}" to get failed API calls
5. Call mcp__jam__getUserEvents with jamId "${jamId}" to get the user's click/type/navigate sequence
6. Call mcp__jam__getVideoTranscript with jamId "${jamId}" to get the user's narration

After fetching all data, analyze it and output ONLY a JSON object (no markdown, no code fences):

{
  "title": "Descriptive title that captures the actual bug (not just 'Fix: X')",
  "description": "Rich description with:\\n- What the user was doing\\n- What went wrong (with specific error messages/codes)\\n- Expected vs actual behavior\\n- Reproduction steps from the user events",
  "complexity": "routine" or "complex" (based on scope: single file fix = routine, multi-component = complex),
  "archetype": "frontend" or "backend" or "integration",
  "testCommands": [
    "command1 that verifies the fix",
    "command2 that verifies the fix"
  ],
  "jamContext": {
    "description": "Bug description from Jam",
    "transcript": "User narration from video (if available)",
    "screenshotUrl": "URL of the most relevant screenshot",
    "consoleLogs": "Formatted JS errors (first 5, most relevant)",
    "failedRequests": "Summary of failed API calls (method, path, status)",
    "userEvents": "Key user interactions (click/type/navigate sequence)"
  }
}

Project: ${project}${portHint}

## TEST_COMMANDS Guidelines
Generate 2-4 TEST_COMMANDS that verify the fix:
- Each is a single bash command runnable in the project directory
- Prefer curl/sqlite3/grep over Playwright (faster, more reliable)
- Test BEHAVIOR not implementation (don't grep for specific code)
- Use data from the failed network requests and console errors
- Exit 0 on success, non-zero on failure
${devPort ? `- Use port ${devPort} for HTTP requests` : '- If the project has a dev server, use the appropriate port'}

Example good commands:
- curl -sf http://localhost:PORT/api/endpoint | jq '.status' | grep -q 'ok'
- curl -sf http://localhost:PORT/page 2>&1 | grep -v 'error\\|500\\|404'
- sqlite3 data/app.db "SELECT COUNT(*) FROM items WHERE status='active'" | grep -v '^0$'

Example bad commands (fragile — do NOT use these patterns):
- grep -q 'specificFunctionName' src/file.ts
- test -f src/components/SpecificFile.tsx

## Analysis Guidelines
- If the bug is a JS error visible in console logs, the archetype is likely "frontend"
- If the bug is a failed API request (4xx/5xx), check if it's a backend issue or frontend sending wrong data
- If there are both console errors AND failed requests, it may be "integration"
- For complexity: a single missing null check or typo is "routine"; a broken data flow across components is "complex"
- Title should be specific: "Dashboard chart crashes when date range is empty" not "Fix: dashboard error"`;

  try {
    const result = await spawnOpusWithMcp(prompt);

    let parsed: EnrichedJamGoal;
    try {
      parsed = JSON.parse(result.text.trim());
    } catch {
      // Try to extract JSON from the response
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        log.warn(`Failed to parse enrichment JSON (${result.text.length} bytes)`);
        return null;
      }
    }

    // Validate required fields
    if (!parsed.title || !parsed.description) {
      log.warn('Enrichment missing required fields (title or description)');
      return null;
    }

    // Normalize and validate
    return {
      title: parsed.title.slice(0, 120),
      description: parsed.description,
      complexity: parsed.complexity === 'complex' ? 'complex' : 'routine',
      archetype: (['frontend', 'backend', 'integration'].includes(parsed.archetype)
        ? parsed.archetype
        : 'frontend') as 'frontend' | 'backend' | 'integration',
      testCommands: Array.isArray(parsed.testCommands)
        ? parsed.testCommands.filter((c: string) => typeof c === 'string' && c.length > 0).slice(0, 4)
        : [],
      jamContext: {
        description: parsed.jamContext?.description,
        transcript: parsed.jamContext?.transcript,
        screenshotUrl: parsed.jamContext?.screenshotUrl,
        consoleLogs: parsed.jamContext?.consoleLogs,
        failedRequests: parsed.jamContext?.failedRequests,
        userEvents: parsed.jamContext?.userEvents,
      },
    };
  } catch (err) {
    log.error('Jam enrichment failed', err);
    return null;
  }
}

// ── Opus Spawn ──────────────────────────────────────────────

function spawnOpusWithMcp(prompt: string): Promise<{ text: string; costUsd: number }> {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');

    const proc = spawn(claudePath, [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', 'claude-opus-4-5',
      '--max-turns', '10',
    ], {
      cwd: join(__dirname, '../..'), // DreamTeam root for .mcp.json access
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
        reject(new Error(`Opus exited with code ${code}: ${error.slice(0, 500)}`));
      }
    });

    proc.on('error', reject);

    // 60s timeout — Opus needs time to call multiple MCP tools
    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Jam enrichment timed out after 60s'));
    }, 60_000);
  });
}
