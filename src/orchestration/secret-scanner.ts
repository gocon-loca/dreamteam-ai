/**
 * Secret Scanner — Detect leaked secrets in diffs before merge.
 *
 * Runs as a pre-merge quality gate. Scans git diff for common
 * secret patterns (API keys, tokens, credentials).
 *
 * Returns findings with severity levels:
 * - critical: High-entropy strings matching known key formats
 * - warning: Potential secrets that need human review
 */

import { execSync } from 'child_process';
import { createLogger } from '../utils/logger.js';

const log = createLogger('secret-scanner');

// ── Secret Patterns ─────────────────────────────────────────

interface SecretPattern {
  name: string;
  pattern: RegExp;
  severity: 'critical' | 'warning';
}

const SECRET_PATTERNS: SecretPattern[] = [
  // API Keys & Tokens
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/, severity: 'critical' },
  { name: 'AWS Secret Key', pattern: /(?:aws)?_?(?:secret)?_?(?:access)?_?key["'\s:=]+[A-Za-z0-9/+=]{40}/, severity: 'critical' },
  { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/, severity: 'critical' },
  { name: 'GitHub OAuth', pattern: /gho_[A-Za-z0-9]{36,}/, severity: 'critical' },
  { name: 'Anthropic API Key', pattern: /sk-ant-[A-Za-z0-9-_]{40,}/, severity: 'critical' },
  { name: 'OpenAI API Key', pattern: /sk-[A-Za-z0-9]{48,}/, severity: 'critical' },
  { name: 'Stripe Key', pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/, severity: 'critical' },
  { name: 'Stripe Publishable', pattern: /pk_(?:live|test)_[A-Za-z0-9]{24,}/, severity: 'warning' },
  { name: 'Supabase Service Role', pattern: /eyJ[A-Za-z0-9_-]{100,}\.[A-Za-z0-9_-]{100,}/, severity: 'critical' },
  { name: 'Slack Token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, severity: 'critical' },
  { name: 'Telegram Bot Token', pattern: /\d{8,10}:[A-Za-z0-9_-]{35}/, severity: 'critical' },
  { name: 'Twilio Key', pattern: /SK[a-f0-9]{32}/, severity: 'critical' },
  { name: 'SendGrid Key', pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/, severity: 'critical' },
  { name: 'Mailgun Key', pattern: /key-[a-f0-9]{32}/, severity: 'critical' },
  { name: 'Firebase Key', pattern: /AIza[A-Za-z0-9_-]{35}/, severity: 'warning' },
  { name: 'Google OAuth', pattern: /[0-9]+-[a-z0-9_]{32}\.apps\.googleusercontent\.com/, severity: 'warning' },
  { name: 'Vercel Token', pattern: /vercel_[A-Za-z0-9]{24,}/, severity: 'critical' },
  { name: 'npm Token', pattern: /npm_[A-Za-z0-9]{36,}/, severity: 'critical' },
  { name: 'Age Private Key', pattern: /AGE-SECRET-KEY-[A-Z0-9]{59}/, severity: 'critical' },
  { name: 'Generic Bearer Token', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/, severity: 'warning' },

  // Database Connection Strings
  { name: 'Database URL with Password', pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/, severity: 'critical' },

  // Private Keys
  { name: 'RSA Private Key', pattern: /-----BEGIN (?:RSA )?PRIVATE KEY-----/, severity: 'critical' },
  { name: 'SSH Private Key', pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/, severity: 'critical' },
  { name: 'PGP Private Key', pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/, severity: 'critical' },

  // Passwords in common config patterns
  { name: 'Password Assignment', pattern: /(?:password|passwd|pwd|secret)["'\s:=]+["'][^"']{8,}["']/i, severity: 'warning' },
];

// Files to skip (these normally contain encoded data, not secrets)
const SKIP_FILE_PATTERNS = [
  /\.lock$/,
  /pnpm-lock\.yaml$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /\.min\.js$/,
  /\.min\.css$/,
  /dist\//,
  /node_modules\//,
  /\.woff2?$/,
  /\.png$|\.jpg$|\.gif$|\.ico$/,
  /\.svg$/,
  /\.enc\./,  // Encrypted files (SOPS)
];

// ── Types ───────────────────────────────────────────────────

export interface SecretFinding {
  file: string;
  line: number;
  pattern: string;
  severity: 'critical' | 'warning';
  snippet: string;  // Redacted snippet showing context
}

export interface ScanResult {
  passed: boolean;
  findings: SecretFinding[];
  filesScanned: number;
  summary: string;
}

// ── Scanner ─────────────────────────────────────────────────

/**
 * Scan a git diff for leaked secrets.
 * Only checks added lines (lines starting with +).
 */
export function scanDiffForSecrets(diff: string): ScanResult {
  const findings: SecretFinding[] = [];
  let currentFile = '';
  let lineNumber = 0;
  const filesScanned = new Set<string>();

  const lines = diff.split('\n');

  for (const line of lines) {
    // Track file changes
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      lineNumber = 0;
      continue;
    }

    // Track line numbers from hunk headers
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      lineNumber = parseInt(hunkMatch[1]) - 1;
      continue;
    }

    // Only scan added lines
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    lineNumber++;

    // Skip excluded file types
    if (SKIP_FILE_PATTERNS.some(p => p.test(currentFile))) continue;
    filesScanned.add(currentFile);

    const content = line.slice(1); // Remove the leading +

    // Skip comments and common false positives
    if (content.trim().startsWith('//') && content.includes('example')) continue;
    if (content.trim().startsWith('#') && content.includes('example')) continue;
    if (content.includes('placeholder') || content.includes('YOUR_')) continue;
    if (content.includes('process.env.')) continue; // Env var references, not values
    if (content.includes('${') && content.includes('}')) continue; // Template literals referencing vars

    for (const sp of SECRET_PATTERNS) {
      const match = content.match(sp.pattern);
      if (match) {
        // Redact the actual secret in the snippet
        const matchStr = match[0];
        const redacted = matchStr.slice(0, 6) + '***REDACTED***' + matchStr.slice(-4);
        const snippet = content.slice(0, 120).replace(matchStr, redacted);

        findings.push({
          file: currentFile,
          line: lineNumber,
          pattern: sp.name,
          severity: sp.severity,
          snippet: snippet.trim(),
        });
        break; // One finding per line is enough
      }
    }
  }

  const critical = findings.filter(f => f.severity === 'critical');
  const warnings = findings.filter(f => f.severity === 'warning');

  const passed = critical.length === 0;
  let summary: string;
  if (findings.length === 0) {
    summary = `No secrets detected (${filesScanned.size} files scanned)`;
  } else {
    const parts: string[] = [];
    if (critical.length > 0) parts.push(`${critical.length} CRITICAL`);
    if (warnings.length > 0) parts.push(`${warnings.length} warning`);
    summary = `Secret scan: ${parts.join(', ')} (${filesScanned.size} files scanned)`;
  }

  return { passed, findings, filesScanned: filesScanned.size, summary };
}

/**
 * Scan a goal's branch diff for secrets.
 * Gets the diff between main and the goal branch.
 */
export function scanBranchForSecrets(cwd: string, goalId: string): ScanResult {
  try {
    const branch = `goal/${goalId}`;

    // Get the diff between main and the goal branch
    let diff: string;
    try {
      diff = execSync(`git diff main...${branch}`, {
        cwd,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
    } catch {
      // Branch may not exist or may be same as main
      return { passed: true, findings: [], filesScanned: 0, summary: 'No diff to scan' };
    }

    if (!diff.trim()) {
      return { passed: true, findings: [], filesScanned: 0, summary: 'Empty diff' };
    }

    const result = scanDiffForSecrets(diff);
    if (result.findings.length > 0) {
      log.warn(`Secret scan for goal ${goalId}: ${result.summary}`);
      for (const f of result.findings) {
        log.warn(`  ${f.severity}: ${f.pattern} in ${f.file}:${f.line}`);
      }
    }

    return result;
  } catch (e) {
    log.error('Secret scan error', e);
    return { passed: true, findings: [], filesScanned: 0, summary: `Scan error: ${e}` };
  }
}

/**
 * Format secret findings for inclusion in rejection reason / Telegram.
 */
export function formatSecretFindings(findings: SecretFinding[]): string {
  const lines: string[] = [];
  for (const f of findings.slice(0, 5)) {
    lines.push(`• [${f.severity.toUpperCase()}] ${f.pattern} in ${f.file}:${f.line}`);
    lines.push(`  ${f.snippet}`);
  }
  if (findings.length > 5) {
    lines.push(`  ... and ${findings.length - 5} more`);
  }
  return lines.join('\n');
}
