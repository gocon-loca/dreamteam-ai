/**
 * System control commands: /startwork, /stopwork, /pause, /resume, /kill, /status, /supervisor
 */

import type { Telegraf, Context } from 'telegraf';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { resumeProject as resumeCircuitBreaker } from '../orchestration/circuit-breaker.js';
import {
  getGoal,
  getGoalsSummary,
} from '../orchestration/goal-manager.js';
import {
  getActiveItems,
  getQueuedCount,
  getItemByGoalId,
} from '../db/work-queue.js';
import { getRecentEvents } from '../db/supervisor-events.js';
import { isLinearEnabled } from '../integrations/linear.js';
import { getSupervisorStatus } from './core.js';

export function registerSystemCommands(bot: Telegraf<Context>) {
  // Command: /startwork - Start supervisor + workers via start.sh
  bot.command('startwork', async (ctx) => {
    // Check if supervisor is already running
    let supervisorRunning = false;
    try {
      const { execSync } = require('child_process');
      const ps = execSync('pgrep -f "supervisor.js" 2>/dev/null || true', { encoding: 'utf8' });
      supervisorRunning = ps.trim().length > 0;
    } catch { /* ignore */ }

    if (supervisorRunning) {
      await ctx.reply('\u{1F9E0} Supervisor is already running. Use /stopwork to stop it.');
      return;
    }

    await ctx.reply('\u{1F680} Starting supervisor + workers...');

    try {
      const { execSync } = require('child_process');
      execSync(`cd "${process.cwd()}" && bash scripts/start.sh`, {
        encoding: 'utf8',
        shell: '/bin/bash',
        timeout: 30000,
      });
      await ctx.reply('\u2705 Supervisor + workers started! Goals will be dispatched automatically.');
    } catch (error) {
      await ctx.reply(`\u274C Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /stopwork - Stop supervisor (workers finish current goals)
  bot.command('stopwork', async (ctx) => {
    try {
      const { execSync } = require('child_process');
      execSync('pkill -f "supervisor.js" 2>/dev/null || true', { encoding: 'utf8' });
      await ctx.reply('\u2705 Supervisor stopped. Workers will finish current goals, then idle.');
    } catch (error) {
      await ctx.reply(`\u274C Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /pause - Pause supervisor (workers finish current goals)
  bot.command('pause', async (ctx) => {
    const controlFile = resolve(process.cwd(), 'data/supervisor-control.json');
    try {
      const existing = existsSync(controlFile) ? JSON.parse(readFileSync(controlFile, 'utf8')) : {};
      writeFileSync(controlFile, JSON.stringify({ ...existing, paused: true, updatedAt: new Date().toISOString() }, null, 2));
      await ctx.reply('\u23F8\uFE0F Supervisor paused. Active workers will finish current goals.');
    } catch (error) {
      await ctx.reply(`\u274C Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /resume [project] - Resume supervisor or a specific project's circuit breaker
  bot.command('resume', async (ctx) => {
    const arg = ctx.message.text.replace('/resume', '').trim();

    // If a project name is given, resume its circuit breaker
    if (arg) {
      const resumed = resumeCircuitBreaker(arg);
      if (resumed) {
        await ctx.reply(`\u2705 Circuit breaker reset for ${arg}. Goals will resume dispatching.`);
      } else {
        await ctx.reply(`\u2139\uFE0F ${arg} circuit breaker is not tripped.`);
      }
      return;
    }

    // No arg — resume the supervisor
    const controlFile = resolve(process.cwd(), 'data/supervisor-control.json');
    try {
      const existing = existsSync(controlFile) ? JSON.parse(readFileSync(controlFile, 'utf8')) : {};
      writeFileSync(controlFile, JSON.stringify({ ...existing, paused: false, updatedAt: new Date().toISOString() }, null, 2));
      await ctx.reply('\u25B6\uFE0F Supervisor resumed.');
    } catch (error) {
      await ctx.reply(`\u274C Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /kill <goal_id> - Kill the agent working on a specific goal
  bot.command('kill', async (ctx) => {
    const goalId = ctx.message.text.replace('/kill', '').trim();
    if (!goalId) {
      await ctx.reply('Usage: /kill <goal-id>');
      return;
    }

    try {
      const item = getItemByGoalId(goalId);
      if (!item) {
        await ctx.reply(`No active work found for goal: ${goalId}`);
        return;
      }

      // Kill via process tracker
      const { killTrackedProcess } = await import('../orchestration/process-tracker.js');
      killTrackedProcess(goalId, 'SIGTERM');

      // Also kill worker process
      if (item.worker_pid) {
        try { process.kill(item.worker_pid, 'SIGTERM'); } catch { /* ignore */ }
      }

      // Mark as failed in work_queue
      const { getDb } = await import('../db/index.js');
      getDb().prepare(`
        UPDATE work_queue SET status = 'failed', completed_at = datetime('now'),
        exit_signal = 'killed', error = 'Killed via /kill command'
        WHERE id = ?
      `).run(item.id);

      await ctx.reply(`\u{1F52A} Killed agent for [${item.project}] goal ${goalId.slice(0, 8)}`);
    } catch (error) {
      await ctx.reply(`\u274C Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /status
  bot.command('status', async (ctx) => {
    const summary = getGoalsSummary();
    const linearEnabled = isLinearEnabled();
    const sv = getSupervisorStatus();

    // Worker count
    let workerCount = 0;
    try {
      const { execSync } = require('child_process');
      const ps = execSync('pgrep -f "worker.js" 2>/dev/null || true', { encoding: 'utf8' });
      workerCount = ps.trim().split('\n').filter(Boolean).length;
    } catch { /* ignore */ }

    // Work queue stats
    const activeItems = getActiveItems();
    const queuedCount = getQueuedCount();

    // Budget
    let todaySpend = '?';
    let dailyLimit = '30';
    try {
      const { getRealBudgetData } = await import('../orchestration/model-router.js');
      const budget = getRealBudgetData();
      todaySpend = budget.todayUsd.toFixed(2);
      const controlFile = resolve(process.cwd(), 'data/supervisor-control.json');
      if (existsSync(controlFile)) {
        const ctrl = JSON.parse(readFileSync(controlFile, 'utf8'));
        if (ctrl.dailyBudgetUsd) dailyLimit = String(ctrl.dailyBudgetUsd);
      }
    } catch { /* ignore */ }

    const supervisorStatus = !sv.running ? '\u{1F534} STOPPED' : sv.paused ? '\u23F8\uFE0F PAUSED' : '\u{1F7E2} RUNNING';
    const lines = [
      `\u{1F9E0} Supervisor: ${supervisorStatus}`,
      `\u{1F477} Workers: ${workerCount}/4 active`,
      `\u{1F4B0} Budget: $${todaySpend} / $${dailyLimit} (${Math.round(parseFloat(todaySpend) / parseFloat(dailyLimit) * 100)}%)`,
      `\u{1F3AF} Queue: ${activeItems.length} running, ${queuedCount} queued`,
      `\u{1F4CB} Linear: ${linearEnabled ? '\u{1F7E2}' : '\u26AA'}`,
      '',
      `Goals:`,
      `  \u23F3 Pending: ${summary.pending}`,
      `  \u{1F504} In Progress: ${summary.inProgress}`,
      `  \u2705 Completed: ${summary.completed}`,
      `  \u26D4 Blocked: ${summary.blocked}`,
    ];

    if (activeItems.length > 0) {
      lines.push('', 'Active:');
      for (const item of activeItems.slice(0, 4)) {
        const goal = getGoal(item.goal_id);
        const title = goal ? goal.title.slice(0, 40) : item.goal_id.slice(0, 8);
        lines.push(`  [${item.project}] ${title} ($${item.cost_usd.toFixed(2)})`);
      }
    }

    if (!sv.running) {
      lines.push('', '\u{1F4A1} Use /startwork to start');
    }

    await ctx.reply(lines.join('\n'));
  });

  // Command: /supervisor - View supervisor + worker detailed status
  bot.command('supervisor', async (ctx) => {
    const sv = getSupervisorStatus();

    // Worker count
    let workerCount = 0;
    try {
      const { execSync } = require('child_process');
      const ps = execSync('pgrep -f "worker.js" 2>/dev/null || true', { encoding: 'utf8' });
      workerCount = ps.trim().split('\n').filter(Boolean).length;
    } catch { /* ignore */ }

    const svStatus = !sv.running ? '\u{1F534} NOT RUNNING' : sv.paused ? '\u23F8\uFE0F PAUSED' : '\u{1F7E2} RUNNING';

    const lines = [
      '\u{1F6E1}\uFE0F Supervisor Details',
      '',
      `Status: ${svStatus}${sv.pid ? ` (PID: ${sv.pid})` : ''}`,
      `Workers: ${workerCount}/4`,
      `Bot: \u{1F7E2} (this process)`,
    ];

    // Recent events from supervisor_events table
    try {
      const events = getRecentEvents(5);
      if (events.length > 0) {
        lines.push('', 'Recent events:');
        for (const e of events) {
          const time = new Date(e.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          const cost = e.cost_usd ? ` ($${e.cost_usd.toFixed(2)})` : '';
          lines.push(`  ${time} ${e.event_type}${cost} ${(e.details || '').slice(0, 60)}`);
        }
      }
    } catch { /* ignore */ }

    // Active work items
    try {
      const active = getActiveItems();
      if (active.length > 0) {
        lines.push('', 'Active work:');
        for (const item of active) {
          const goal = getGoal(item.goal_id);
          const title = goal ? goal.title.slice(0, 35) : item.goal_id.slice(0, 8);
          const started = item.started_at ? `${Math.round((Date.now() - new Date(item.started_at).getTime()) / 60000)} min` : '?';
          lines.push(`  [${item.project}] ${title} (${started}, $${item.cost_usd.toFixed(2)})`);
        }
      }
    } catch { /* ignore */ }

    if (!sv.running) {
      lines.push('', '\u{1F4A1} Use /startwork to start');
    }

    await ctx.reply(lines.join('\n'));
  });
}
