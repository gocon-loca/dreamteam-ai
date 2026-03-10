/**
 * Strip Claude Code session environment variables so spawned
 * Claude CLI processes don't detect a "nested session" and refuse to start.
 */
export function cleanEnvForClaude(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  // Remove all Claude Code session markers
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}
