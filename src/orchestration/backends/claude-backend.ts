/**
 * Claude CLI Backend — Default execution backend for DreamTeam.
 *
 * Wraps `claude --print` with JSON output parsing, continuation support,
 * and clean environment setup.
 *
 * Extracted from task-runner.ts to enable pluggable backends.
 */

import { join } from 'path';
import { homedir } from 'os';
import { cleanEnvForClaude } from '../../utils/clean-env.js';
import {
  registerBackend,
  type CliBackend,
  type CliInvocationOptions,
  type ParsedCliOutput,
} from '../cli-backend.js';

const claudeBackend: CliBackend = {
  name: 'claude',

  resolveBinaryPath(): string {
    return process.env.CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude');
  },

  buildArgs(opts: CliInvocationOptions): string[] {
    const args = [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      for (const tool of opts.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    return args;
  },

  supportsContinuation: true,

  buildContinuationArgs(opts: CliInvocationOptions): string[] {
    const args = this.buildArgs(opts);
    args.push('--continue');
    return args;
  },

  parseOutput(stdout: string, _exitCode: number): ParsedCliOutput {
    try {
      const parsed = JSON.parse(stdout);
      return {
        text: (typeof parsed.result === 'string' ? parsed.result : stdout).trim(),
        costUsd: parsed.total_cost_usd ?? 0,
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
        jsonParseFailed: false,
      };
    } catch {
      // JSON parse failed — fall back to raw text
      return {
        text: stdout.trim(),
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        jsonParseFailed: true,
      };
    }
  },

  buildEnv(base: Record<string, string>): Record<string, string | undefined> {
    return cleanEnvForClaude(base);
  },
};

// Self-register on import
registerBackend(claudeBackend);

export default claudeBackend;
