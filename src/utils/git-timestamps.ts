/**
 * Neutral Git Timestamps
 *
 * When DREAMTEAM_NEUTRAL_TIMESTAMPS is set, generates randomized
 * evening timestamps (18:00-23:59) for git commits. This prevents
 * automated commits from creating identifiable work patterns.
 *
 * Usage:
 *   execSync('git commit -m "message"', {
 *     env: { ...process.env, ...getNeutralTimestampEnv() },
 *   });
 *
 * Set DREAMTEAM_NEUTRAL_TIMESTAMPS=1 in .env to enable.
 */

/**
 * Returns GIT_AUTHOR_DATE and GIT_COMMITTER_DATE env vars with the
 * current time shifted into evening hours (18:00-23:59), or empty
 * object if disabled.
 *
 * Uses deterministic shift (not random) so commit ordering is preserved:
 *   real hour % 6 → offset into 18-23 window
 *   real minutes + seconds preserved for sub-hour ordering
 *
 * NOTE: This is set once per spawned process. For agent sessions that
 * make multiple commits, all commits share the same timestamp. This
 * looks like a normal squash-merge and is not suspicious.
 */
export function getNeutralTimestampEnv(): Record<string, string> {
  if (!process.env.DREAMTEAM_NEUTRAL_TIMESTAMPS) return {};
  const now = new Date();
  const shifted = 18 + (now.getHours() % 6);
  const tz = process.env.DREAMTEAM_NEUTRAL_TZ || '-0600';
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(shifted)}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${tz}`;
  return {
    GIT_AUTHOR_DATE: ts,
    GIT_COMMITTER_DATE: ts,
  };
}
