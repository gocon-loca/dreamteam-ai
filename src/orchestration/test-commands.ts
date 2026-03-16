/**
 * TEST_COMMANDS — Goal-specific acceptance criteria verification.
 *
 * Goals can include a TEST_COMMANDS: block in their description.
 * Each command is run in the project directory after agent completion.
 * Any non-zero exit code means the gate rejects the goal.
 *
 * Example in goal description:
 *   TEST_COMMANDS:
 *   - curl -sf localhost:3000/api/items | python3 -c "import json,sys; assert len(json.load(sys.stdin))>0"
 *   - sqlite3 data/app.db "SELECT COUNT(*) FROM users" | python3 -c "import sys; assert int(sys.stdin.read())>=1"
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface TestCommandResult {
  command: string;
  passed: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Parse TEST_COMMANDS: block from a goal description.
 * Returns an array of shell command strings.
 */
export function parseTestCommands(goalDescription: string): string[] {
  if (!goalDescription) return [];

  // Match the TEST_COMMANDS: block — ends at a blank line, another section header, or end of string
  const match = goalDescription.match(/TEST_COMMANDS:\s*\n([\s\S]*?)(?:\n\n|\n[A-Z_]+:|\n---|\n##|$)/);
  if (!match) return [];

  const block = match[1];
  const commands: string[] = [];

  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    // Lines starting with - are commands
    if (trimmed.startsWith('- ')) {
      const cmd = trimmed.slice(2).trim();
      if (cmd.length > 0) {
        commands.push(cmd);
      }
    }
  }

  return commands;
}

/**
 * Run TEST_COMMANDS in the project directory and return results.
 * Each command runs with a 30-second timeout.
 *
 * For Python projects, if a venv exists at the original project path,
 * commands are wrapped with venv activation so imports work correctly
 * (even when running in a detached git worktree).
 */
export async function runTestCommands(
  projectPath: string,
  commands: string[],
  opts?: { originalProjectPath?: string }
): Promise<TestCommandResult[]> {
  const results: TestCommandResult[] = [];

  // Detect Python venv — check original project path (worktrees don't have venvs)
  const basePath = opts?.originalProjectPath || projectPath;
  const venvActivate = join(basePath, '.venv', 'bin', 'activate');
  const hasVenv = existsSync(venvActivate);

  for (const command of commands) {
    // Block dangerous shell injection patterns — TEST_COMMANDS come from goal descriptions
    // which may be user-authored. Only allow standard test/check patterns.
    if (/`[^`]+`/.test(command) || /\$\([^)]+\)/.test(command)) {
      // Allow $() only inside python -c strings (common pattern for assertions)
      const strippedOfPythonC = command.replace(/-c\s+["'][^"']*["']/g, '');
      if (/`[^`]+`/.test(strippedOfPythonC) || /\$\([^)]+\)/.test(strippedOfPythonC)) {
        results.push({
          command,
          passed: false,
          output: 'BLOCKED: Command contains shell injection pattern (backticks or $() outside quoted strings). Rewrite using pipes instead.',
          exitCode: 1,
          durationMs: 0,
        });
        continue;
      }
    }

    // Fix common shell compatibility issues in test commands:
    // 1. \! (escaped negation) — macOS bash 3.2 doesn't support ! as pipeline negation
    //    in non-interactive mode. Convert: \! CMD && echo X  →  if CMD; then exit 1; else echo X; fi
    // 2. grep with unescaped | in pattern needs -E flag for alternation
    let sanitized = command;

    // Strip hardcoded `cd /absolute/path && ...` prefixes — these escape the
    // worktree and run against whatever branch is checked out in the original dir.
    // Only strip ABSOLUTE paths (starting with / or ~). Relative `cd frontend &&`
    // is fine — it works correctly inside worktrees since directory structure matches.
    sanitized = sanitized.replace(/^cd\s+[\/~]\S+\s*&&\s*/, '');

    // Convert \! CMD && echo X patterns to bash-compatible if/else form
    // Use [^|]+ to avoid matching across shell pipe operators
    sanitized = sanitized.replace(/\\!\s+([^|]+?)\s*&&\s*echo\s+(\S+)/g, 'if $1; then exit 1; else echo $2; fi');
    // Fallback: plain \! not followed by && echo — just remove the backslash
    sanitized = sanitized.replace(/\\!/g, '!');
    // Add -E flag if grep uses | for alternation but doesn't have -E or -P
    // Only match | inside double-quoted grep patterns, not shell pipe operators
    sanitized = sanitized.replace(
      /\bgrep\b(?!\s+--)((?:\s+-[a-zA-Z]*)*)\s+"([^"]*\|[^"]*)"/g,
      (match, flags, _pattern) => {
        if (/\b-[EP]\b/.test(flags) || /-[a-zA-Z]*[EP]/.test(flags)) return match;
        return match.replace(/\bgrep\b/, 'grep -E');
      }
    );

    // Wrap Python commands with venv activation if available
    const isPythonCmd = /\bpython3?\b|\bpip\b|\bpytest\b|\bfrom\s+\w+/.test(command);

    // Wrap command in explicit bash -c for robust pipe/subshell handling.
    // execSync with shell:'/bin/bash' does this internally, but wrapping
    // explicitly ensures complex pipes (cmd | if read n; then ...) work
    // correctly by running in a single bash invocation.
    const shellCommand = (hasVenv && isPythonCmd)
      ? `source "${venvActivate}" && ${sanitized}`
      : sanitized;

    const start = Date.now();
    try {
      const output = execSync(shellCommand, {
        cwd: projectPath,
        encoding: 'utf8',
        timeout: 30_000,
        shell: '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      results.push({
        command,
        passed: true,
        output: output.trim().slice(0, 1000),
        exitCode: 0,
        durationMs: Date.now() - start,
      });
    } catch (err: any) {
      const exitCode = err.status ?? 1;
      const output = (err.stdout || '') + (err.stderr || '');

      results.push({
        command,
        passed: false,
        output: output.trim().slice(0, 1000),
        exitCode,
        durationMs: Date.now() - start,
      });
    }
  }

  return results;
}

/**
 * Format test command results into a human-readable rejection reason.
 */
export function formatTestCommandFailures(results: TestCommandResult[]): string {
  const failures = results.filter(r => !r.passed);
  if (failures.length === 0) return '';

  const lines = [`${failures.length}/${results.length} test commands failed:`];
  for (const f of failures) {
    lines.push(`  ✗ ${f.command.slice(0, 200)}`);
    if (f.output) {
      lines.push(`    → ${f.output.slice(0, 500)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Validate TEST_COMMANDS syntax before dispatch — catch obvious errors
 * (broken quoting, invalid shell syntax, fragile grep patterns) before spending
 * agent tokens. Returns an array of warning strings for problematic commands.
 */
export function validateTestCommandSyntax(commands: string[]): string[] {
  const warnings: string[] = [];

  for (const cmd of commands) {
    // Check for obviously broken awk/sed quoting
    const singleQuotes = (cmd.match(/'/g) || []).length;
    const doubleQuotes = (cmd.match(/"/g) || []).length;
    if (singleQuotes % 2 !== 0) {
      warnings.push(`Unbalanced single quotes in: ${cmd.slice(0, 100)}`);
    }
    if (doubleQuotes % 2 !== 0) {
      warnings.push(`Unbalanced double quotes in: ${cmd.slice(0, 100)}`);
    }

    // Check for common shell syntax errors
    if (/\|\s*$/.test(cmd)) {
      warnings.push(`Trailing pipe with no command: ${cmd.slice(0, 100)}`);
    }
    if (/&&\s*$/.test(cmd)) {
      warnings.push(`Trailing && with no command: ${cmd.slice(0, 100)}`);
    }

    // Detect fragile grep patterns that check implementation details
    // These fail when the agent uses slightly different naming/formatting
    if (/grep\s+-q\s+['"]/.test(cmd) && /\.(ts|tsx|js|jsx|py|html)/.test(cmd)) {
      warnings.push(`Fragile grep pattern (checks exact string in source file, breaks on naming changes): ${cmd.slice(0, 100)}`);
    }

    // Bash -c syntax check (quick — just parses, doesn't execute)
    try {
      execSync(`bash -n -c ${JSON.stringify(cmd)}`, {
        timeout: 5000,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err: any) {
      const stderr = err.stderr || '';
      warnings.push(`Shell syntax error in: ${cmd.slice(0, 80)} → ${stderr.trim().slice(0, 100)}`);
    }
  }

  return warnings;
}

/**
 * Guidance for writing good TEST_COMMANDS.
 * Injected into the prompt when goals contain TEST_COMMANDS blocks,
 * and available to the director when creating goals.
 */
export const TEST_COMMANDS_GUIDANCE = `## TEST_COMMANDS Best Practices
Write behavioral verification commands, NOT implementation-detail checks.

GOOD (behavioral — checks what the app DOES):
- curl -sf localhost:3000/api/items | python3 -c "import json,sys; assert len(json.load(sys.stdin))>0"
- curl -sf localhost:3000/page | grep -qi "expected heading"
- cd frontend && npx tsc --noEmit
- pytest tests/test_feature.py -x
- sqlite3 data/app.db "SELECT COUNT(*) FROM table" | grep -v '^0$'

BAD (fragile — checks HOW the code is written):
- grep -q 'function specificName' src/file.ts
- grep -q 'import { ExactThing }' src/component.tsx
- grep -c 'className="exact-class"' src/file.tsx

Rules:
- Test exit codes and outputs, not source code strings
- Use curl to verify API responses and page content
- Use the project's own test runner (pytest, vitest, jest) when tests exist
- Use tsc --noEmit / python3 -m py_compile for type/syntax checks
- Use database queries to verify data layer changes
- Never grep source files for exact function/variable names`;

