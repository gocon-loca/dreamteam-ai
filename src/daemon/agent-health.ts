/**
 * Agent Health Monitor - Intelligent output analysis and self-healing
 *
 * This is the missing piece: instead of just checking if agents are alive,
 * we actually READ their output, DIAGNOSE problems, and FIX them.
 *
 * The overnight failure of Feb 5-6 happened because:
 * - Agents appeared "alive" (PIDs existed)
 * - Log files existed (but were tiny — 103 bytes of error)
 * - Nobody read the actual output to see it was an error
 * - The system happily respawned broken agents all night
 *
 * This module prevents that by:
 * 1. Reading recent agent output from log files
 * 2. Classifying output as healthy/failing/stuck
 * 3. Diagnosing specific failure patterns
 * 4. Taking corrective action (rebuild, reconfigure, alert)
 */

import { existsSync, readFileSync, statSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const LOGS_DIR = join(PROJECT_ROOT, 'logs');

// Known failure patterns and their diagnoses
interface FailurePattern {
  pattern: RegExp;
  diagnosis: string;
  severity: 'critical' | 'warning' | 'info';
  autoFix?: () => Promise<boolean>; // Returns true if fix was applied
}

const FAILURE_PATTERNS: FailurePattern[] = [
  {
    pattern: /Input must be provided.*stdin.*--print/i,
    diagnosis: 'Claude CLI --continue + --print requires stdin input. The task-runner continuation code is broken.',
    severity: 'critical',
    autoFix: async () => {
      // This specific bug was the Feb 5-6 failure. The fix is in task-runner.ts
      // but if we see it, it means the build is stale.
      return await rebuildProject();
    },
  },
  {
    pattern: /model.*not found|not.*exist.*model|invalid.*model/i,
    diagnosis: 'Invalid model ID. Check MODELS mapping in task-runner.ts — may have date-suffixed model names.',
    severity: 'critical',
    autoFix: async () => {
      // Check if task-runner has date-suffixed model names and fix them
      try {
        const taskRunner = readFileSync(join(PROJECT_ROOT, 'src/projects/task-runner.ts'), 'utf-8');
        if (taskRunner.match(/claude-opus-4-6-\d{8}|claude-sonnet-4-5-\d{8}|claude-haiku-4-5-\d{8}/)) {
          log('WARN', 'Found date-suffixed model IDs in task-runner.ts — these need manual fix');
          return false; // Can't safely auto-edit source files
        }
      } catch { /* ignore */ }
      // Might be a stale build
      return await rebuildProject();
    },
  },
  {
    pattern: /rate.?limit|usage.?limit|quota.?exceeded|too.?many.?requests|billing|429/i,
    diagnosis: 'API rate limit hit. Agents should back off.',
    severity: 'warning',
  },
  {
    pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i,
    diagnosis: 'Network connectivity issue. Dev server may be down or API unreachable.',
    severity: 'warning',
    autoFix: async () => {
      log('INFO', 'Network error detected — checking if dev servers need restart');
      // Dev servers are managed by the overnight daemon, just log it
      return false;
    },
  },
  {
    pattern: /SPAWN ERROR|spawn.*ENOENT|command not found.*claude/i,
    diagnosis: 'Claude CLI not found or not executable. Check PATH and installation.',
    severity: 'critical',
    autoFix: async () => {
      try {
        execSync(`which claude || ${process.env.HOME}/.local/bin/claude --version`, { encoding: 'utf-8' });
        return false; // Claude exists, something else is wrong
      } catch {
        log('ERROR', 'Claude CLI not found at expected path');
        return false;
      }
    },
  },
  {
    pattern: /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i,
    diagnosis: 'Missing module — build is likely stale or dependencies need install.',
    severity: 'critical',
    autoFix: async () => {
      try {
        log('INFO', 'Missing module detected — running pnpm install + rebuild');
        execSync('pnpm install', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000 });
        return await rebuildProject();
      } catch (e) {
        log('ERROR', `Auto-fix failed: ${e}`);
        return false;
      }
    },
  },
  {
    pattern: /SyntaxError|TypeError|ReferenceError|RangeError/i,
    diagnosis: 'JavaScript runtime error in agent or project code.',
    severity: 'warning',
  },
  {
    pattern: /TIMEOUT.*killed|process killed after timeout/i,
    diagnosis: 'Agent timed out. May be stuck in an infinite loop or waiting for input.',
    severity: 'warning',
  },
  {
    pattern: /permission denied|EACCES/i,
    diagnosis: 'Permission denied. File or command access issue.',
    severity: 'warning',
  },
];

// What "healthy" agent output looks like
const HEALTHY_SIGNALS = [
  /GOAL_COMPLETE/,
  /ASSUMPTION:/,
  /ASSESSMENT:/,
  /git commit/i,
  /git push/i,
  /feat:|fix:|refactor:|test:|chore:/i,
  /Running tests/i,
  /Tests? pass/i,
  /\d+ files? changed/i,
];

export interface AgentHealthReport {
  project: string;
  logFile: string;
  status: 'healthy' | 'failing' | 'stuck' | 'silent' | 'unknown';
  lastOutputAge: number; // ms since last output
  outputSize: number; // bytes
  diagnosis?: string;
  severity?: 'critical' | 'warning' | 'info';
  autoFixApplied?: boolean;
  autoFixResult?: string;
  recentOutput: string; // last ~500 chars for debugging
  healthySignals: string[]; // which healthy signals were found
  failurePatterns: string[]; // which failure patterns matched
}

export interface SystemHealthReport {
  timestamp: string;
  overallStatus: 'healthy' | 'degraded' | 'critical' | 'dead';
  agents: AgentHealthReport[];
  activeAgentPids: number[];
  totalAgents: number;
  healthyAgents: number;
  failingAgents: number;
  recommendations: string[];
  autoFixesApplied: string[];
}

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [HEALTH] [${level}] ${message}`;
  console.log(logLine);
  try {
    const logFile = join(LOGS_DIR, `health-${timestamp.split('T')[0]}.log`);
    appendFileSync(logFile, logLine + '\n');
  } catch { /* ignore logging failures */ }
}

/**
 * Read the tail of a log file (last N bytes)
 */
function readLogTail(filePath: string, maxBytes: number = 10000): string {
  try {
    if (!existsSync(filePath)) return '';
    const stat = statSync(filePath);
    const fd = require('fs').openSync(filePath, 'r');
    const startPos = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
    require('fs').readSync(fd, buffer, 0, buffer.length, startPos);
    require('fs').closeSync(fd);
    return buffer.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * Analyze a single agent's output for health
 */
async function analyzeAgentHealth(project: string, logFile: string): Promise<AgentHealthReport> {
  const report: AgentHealthReport = {
    project,
    logFile,
    status: 'unknown',
    lastOutputAge: Infinity,
    outputSize: 0,
    recentOutput: '',
    healthySignals: [],
    failurePatterns: [],
  };

  if (!existsSync(logFile)) {
    report.status = 'silent';
    report.diagnosis = 'No log file found — agent may not have started';
    return report;
  }

  try {
    const stat = statSync(logFile);
    report.outputSize = stat.size;
    report.lastOutputAge = Date.now() - stat.mtimeMs;

    // Read recent output
    const recentOutput = readLogTail(logFile, 10000);
    report.recentOutput = recentOutput.slice(-500);

    // Check for failure patterns
    for (const fp of FAILURE_PATTERNS) {
      if (fp.pattern.test(recentOutput)) {
        report.failurePatterns.push(fp.diagnosis);
        report.severity = fp.severity;

        // Try auto-fix for the most severe issue
        if (!report.autoFixApplied && fp.autoFix) {
          log('INFO', `Attempting auto-fix for ${project}: ${fp.diagnosis}`);
          const fixed = await fp.autoFix();
          report.autoFixApplied = true;
          report.autoFixResult = fixed ? 'Fix applied' : 'Fix attempted but may not have resolved the issue';
        }
      }
    }

    // Check for healthy signals
    for (const signal of HEALTHY_SIGNALS) {
      if (signal.test(recentOutput)) {
        report.healthySignals.push(signal.source);
      }
    }

    // Determine overall status
    if (report.failurePatterns.length > 0 && report.severity === 'critical') {
      report.status = 'failing';
      report.diagnosis = report.failurePatterns[0]; // Primary diagnosis
    } else if (report.outputSize < 200 && report.lastOutputAge < 10 * 60 * 1000) {
      // Tiny recent output = likely silent failure
      report.status = 'failing';
      report.diagnosis = `Output is only ${report.outputSize} bytes — agent likely crashed immediately`;
    } else if (report.lastOutputAge > 30 * 60 * 1000) {
      // No output in 30 minutes
      report.status = 'stuck';
      report.diagnosis = `No output for ${Math.round(report.lastOutputAge / 60000)} minutes`;
    } else if (report.healthySignals.length > 0 && report.failurePatterns.length === 0) {
      report.status = 'healthy';
    } else if (report.failurePatterns.length > 0) {
      report.status = 'failing';
      report.diagnosis = report.failurePatterns[0];
    } else if (report.outputSize > 1000) {
      // Decent amount of output with no failure signals = probably ok
      report.status = 'healthy';
    } else {
      report.status = 'unknown';
      report.diagnosis = 'Could not determine agent health from output';
    }

  } catch (e) {
    report.status = 'unknown';
    report.diagnosis = `Error reading log: ${e}`;
  }

  return report;
}

/**
 * Get PIDs of all running Claude agents
 */
function getAgentPids(): number[] {
  try {
    const result = execSync('pgrep -f "claude.*print" 2>/dev/null || true', { encoding: 'utf-8' });
    return result.trim().split('\n').filter(Boolean).map(p => parseInt(p)).filter(p => !isNaN(p));
  } catch {
    return [];
  }
}

/**
 * Rebuild the DreamTeam project
 */
async function rebuildProject(): Promise<boolean> {
  try {
    log('INFO', 'Rebuilding DreamTeam project...');
    execSync('pnpm build', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 120000 });
    log('INFO', 'Rebuild successful');
    return true;
  } catch (e) {
    log('ERROR', `Rebuild failed: ${e}`);
    return false;
  }
}

/**
 * Run a full system health check
 * This is the main entry point — call this periodically from the supervisor
 */
export async function runHealthCheck(): Promise<SystemHealthReport> {
  const report: SystemHealthReport = {
    timestamp: new Date().toISOString(),
    overallStatus: 'healthy',
    agents: [],
    activeAgentPids: getAgentPids(),
    totalAgents: 0,
    healthyAgents: 0,
    failingAgents: 0,
    recommendations: [],
    autoFixesApplied: [],
  };

  report.totalAgents = report.activeAgentPids.length;

  // Check each project's agent logs — dynamically built from tmp dir
  const projectLogs: { project: string; file: string }[] = [];
  try {
    const tmpFiles = readdirSync('/tmp').filter(f => f.endsWith('-agent.log') || f.endsWith('-auto.log'));
    for (const f of tmpFiles) {
      const project = f.replace(/-agent\.log$/, '').replace(/-auto\.log$/, '');
      projectLogs.push({ project, file: `/tmp/${f}` });
    }
  } catch { /* /tmp not readable */ }

  // Also check the overnight daemon's own logs
  const overnightLogPattern = join(LOGS_DIR, `overnight-${new Date().toISOString().split('T')[0]}.log`);
  if (existsSync(overnightLogPattern)) {
    const overnightOutput = readLogTail(overnightLogPattern, 5000);
    // Check overnight daemon itself for repeated failure patterns
    const failureCount = (overnightOutput.match(/failed.*exit code|Iteration.*failed/gi) || []).length;
    if (failureCount > 5) {
      report.recommendations.push(
        `Overnight daemon log shows ${failureCount} agent failures. Check task-runner configuration.`
      );
    }
  }

  for (const { project, file } of projectLogs) {
    const agentReport = await analyzeAgentHealth(project, file);
    report.agents.push(agentReport);

    if (agentReport.status === 'healthy') {
      report.healthyAgents++;
    } else if (agentReport.status === 'failing' || agentReport.status === 'silent') {
      report.failingAgents++;
    }

    if (agentReport.autoFixApplied) {
      report.autoFixesApplied.push(`${project}: ${agentReport.autoFixResult}`);
    }
  }

  // Generate recommendations
  if (report.totalAgents === 0 && report.failingAgents === 0) {
    report.recommendations.push('No agents running and no recent logs. System may not have started.');
  }

  if (report.failingAgents > 0 && report.failingAgents === report.agents.filter(a => a.status !== 'unknown' && a.logFile).length) {
    report.recommendations.push(
      'ALL agents are failing. This is likely a systemic issue (model config, build error, or CLI problem). Check the most recent failure diagnosis.'
    );
  }

  if (report.totalAgents > 0 && report.healthyAgents === 0) {
    report.recommendations.push(
      'Agents are running but none show healthy output. They may be stuck or producing errors.'
    );
  }

  // Check for the specific Feb 5-6 failure pattern: agents spawning but all producing tiny output
  const allTiny = report.agents.every(a => a.outputSize < 500 && a.outputSize > 0);
  if (allTiny) {
    report.recommendations.push(
      'CRITICAL: All agents producing tiny output (<500 bytes). This matches the silent failure pattern. ' +
      'Check task-runner.ts stdin handling and rebuild.'
    );
  }

  // Determine overall status
  if (report.failingAgents > 0 && report.healthyAgents === 0) {
    report.overallStatus = report.totalAgents === 0 ? 'dead' : 'critical';
  } else if (report.failingAgents > 0) {
    report.overallStatus = 'degraded';
  } else if (report.totalAgents === 0) {
    report.overallStatus = 'dead';
  } else {
    report.overallStatus = 'healthy';
  }

  log('INFO', `Health check: ${report.overallStatus} — ${report.healthyAgents} healthy, ${report.failingAgents} failing, ${report.totalAgents} total agents`);

  return report;
}

/**
 * Format a health report for Telegram
 */
export function formatHealthReportForTelegram(report: SystemHealthReport): string {
  const statusEmoji = {
    healthy: '🟢',
    degraded: '🟡',
    critical: '🔴',
    dead: '💀',
  }[report.overallStatus];

  const lines = [
    `${statusEmoji} Agent Health Report`,
    `${report.healthyAgents} healthy / ${report.failingAgents} failing / ${report.totalAgents} total PIDs`,
    '',
  ];

  for (const agent of report.agents) {
    const agentEmoji = {
      healthy: '✅',
      failing: '❌',
      stuck: '⏳',
      silent: '🔇',
      unknown: '❓',
    }[agent.status];

    lines.push(`${agentEmoji} ${agent.project}: ${agent.status}`);
    if (agent.diagnosis) {
      lines.push(`   ${agent.diagnosis.slice(0, 100)}`);
    }
    if (agent.autoFixApplied) {
      lines.push(`   🔧 Auto-fix: ${agent.autoFixResult}`);
    }
  }

  if (report.recommendations.length > 0) {
    lines.push('', '💡 Recommendations:');
    for (const rec of report.recommendations.slice(0, 3)) {
      lines.push(`• ${rec.slice(0, 120)}`);
    }
  }

  if (report.autoFixesApplied.length > 0) {
    lines.push('', '🔧 Auto-fixes applied:');
    for (const fix of report.autoFixesApplied) {
      lines.push(`• ${fix}`);
    }
  }

  return lines.join('\n');
}
