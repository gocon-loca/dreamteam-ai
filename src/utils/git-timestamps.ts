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
 * Returns GIT_AUTHOR_DATE and GIT_COMMITTER_DATE env vars with
 * a randomized evening timestamp, or empty object if disabled.
 */
export function getNeutralTimestampEnv(): Record<string, string> {
  if (!process.env.DREAMTEAM_NEUTRAL_TIMESTAMPS) return {};
  const now = new Date();
  // Random evening hour (18-23) on the current date
  const hour = 18 + Math.floor(Math.random() * 6);
  const min = Math.floor(Math.random() * 60);
  now.setHours(hour, min, 0, 0);
  const tz = process.env.DREAMTEAM_NEUTRAL_TZ || '-0600';
  const ts = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' ' + tz;
  return {
    GIT_AUTHOR_DATE: ts,
    GIT_COMMITTER_DATE: ts,
  };
}
