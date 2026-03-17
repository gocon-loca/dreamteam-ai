/**
 * OpenAI Codex CLI Backend — Alternative execution backend for DreamTeam.
 *
 * Uses `codex exec` with JSONL output, supporting o3 and o4-mini models.
 * Set CODEX_PATH env var to override the default binary location.
 *
 * Key differences from Claude:
 * - Uses `codex exec` subcommand
 * - JSONL output format (one JSON object per line)
 * - `--dangerously-bypass-approvals-and-sandbox` for autonomous mode
 * - `-C <dir>` for working directory (instead of cwd)
 * - Prompt via stdin
 * - Continuation via `codex exec resume --last`
 * - Requires OPENAI_API_KEY in environment
 */

import { execSync } from 'child_process';
import {
  registerBackend,
  type CliBackend,
  type CliInvocationOptions,
  type ParsedCliOutput,
} from '../cli-backend.js';

const codexBackend: CliBackend = {
  name: 'codex',

  resolveBinaryPath(): string {
    if (process.env.CODEX_PATH) return process.env.CODEX_PATH;

    // Try to find codex in common locations
    try {
      const path = execSync('which codex', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (path) return path;
    } catch { /* not in PATH */ }

    throw new Error('Codex CLI not found. Install it or set CODEX_PATH env var.');
  },

  buildArgs(opts: CliInvocationOptions): string[] {
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
    ];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    // Codex uses -C for working directory
    if (opts.cwd) {
      args.push('-C', opts.cwd);
    }

    return args;
  },

  supportsContinuation: true,

  buildContinuationArgs(opts: CliInvocationOptions): string[] {
    const args = [
      'exec', 'resume', '--last',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
    ];

    if (opts.cwd) {
      args.push('-C', opts.cwd);
    }

    return args;
  },

  parseOutput(stdout: string, _exitCode: number): ParsedCliOutput {
    // Codex outputs JSONL — one JSON object per line
    // We need the last message and aggregate cost from events
    const lines = stdout.trim().split('\n').filter(l => l.trim());

    let text = '';
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let jsonParseFailed = false;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Extract text from message events
        if (event.type === 'message' && event.content) {
          if (typeof event.content === 'string') {
            text = event.content;
          } else if (Array.isArray(event.content)) {
            // Content blocks — extract text parts
            const textParts = event.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text);
            if (textParts.length > 0) {
              text = textParts.join('\n');
            }
          }
        }

        // Extract usage/cost data
        if (event.usage) {
          inputTokens += event.usage.input_tokens || event.usage.prompt_tokens || 0;
          outputTokens += event.usage.output_tokens || event.usage.completion_tokens || 0;
        }

        if (event.cost_usd != null) {
          costUsd = Math.max(costUsd, event.cost_usd); // Take cumulative max
        }

        // Some Codex versions put the final text in a 'result' field
        if (event.result && typeof event.result === 'string') {
          text = event.result;
        }
      } catch {
        // Not valid JSON — treat as raw text
        if (!text) text = line;
        jsonParseFailed = true;
      }
    }

    // If no structured events parsed, treat entire stdout as text
    if (!text && stdout.length > 0) {
      text = stdout.trim();
      jsonParseFailed = true;
    }

    return {
      text,
      costUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,  // Codex doesn't report cache tokens
      cacheCreationTokens: 0,
      jsonParseFailed,
    };
  },

  buildEnv(base: Record<string, string>): Record<string, string | undefined> {
    // Codex needs OPENAI_API_KEY; pass through most env vars
    const env = { ...process.env, ...base } as Record<string, string | undefined>;

    // Remove Claude-specific session markers
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
        delete env[key];
      }
    }

    // Ensure OPENAI_API_KEY is present
    if (!env.OPENAI_API_KEY) {
      console.warn('[codex-backend] OPENAI_API_KEY not set — Codex CLI will fail');
    }

    return env;
  },
};

// Self-register on import
registerBackend(codexBackend);

export default codexBackend;
