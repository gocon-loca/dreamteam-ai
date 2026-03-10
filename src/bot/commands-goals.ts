/**
 * Goal management commands: /start, /goal, /goals, /redo, /delete, /clear
 */

import type { Telegraf, Context } from 'telegraf';
import { listProjectNames, getProject } from '../projects/registry.js';
import {
  addGoal,
  getAllGoals,
  getGoal,
  getGoalsSummary,
  deleteGoal,
  clearCompletedGoals,
  Goal,
} from '../orchestration/goal-manager.js';
import {
  getDirectorStatus,
  clearConversation,
} from '../director/index.js';
import { generateDigest, formatDigestForTelegram } from '../orchestration/digest.js';

export function registerGoalCommands(bot: Telegraf<Context>) {
  // Command: /start
  bot.command('start', async (ctx) => {
    const projects = listProjectNames();
    const directorStatus = getDirectorStatus();
    await ctx.reply(
      `\u{1F916} DreamTeam Director Ready\n\n` +
      `Just talk to me! Send text or voice notes.\n` +
      `I'll translate your ideas into goals.\n\n` +
      `Projects: ${projects.join(', ')}\n\n` +
      `Commands:\n` +
      `/goals - List all goals\n` +
      `/status - System status\n` +
      `/held - Goals waiting for review\n` +
      `/approve <id> - Approve a held goal\n` +
      `/costs [period] - Cost breakdown\n` +
      `/efficiency - Model performance\n` +
      `/patterns - Success patterns\n` +
      `/supervisor - 24/7 supervisor status\n` +
      `/knowledge - What I've learned\n` +
      `/newchat - Fresh conversation\n` +
      `/startwork - Start orchestrator\n\n` +
      `Conversation: ${directorStatus.conversationLength} msgs | \u{1F3A4} Voice ready`
    );
  });

  // Command: /newchat - Clear conversation history
  bot.command('newchat', async (ctx) => {
    clearConversation();
    await ctx.reply('\u{1F504} Conversation cleared. Fresh start!');
  });

  // Command: /goal <project> <title>
  bot.command('goal', async (ctx) => {
    const text = ctx.message.text.replace('/goal', '').trim();
    const parts = text.split(' ');

    if (parts.length < 2) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /goal <project> <title>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    const projectName = parts[0];
    const title = parts.slice(1).join(' ');

    try {
      getProject(projectName); // Validate project exists
      const goal = addGoal(projectName, title);
      await ctx.reply(`Goal added: ${goal.title}\nID: ${goal.id}\nProject: ${goal.project}`);
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });

  // Command: /goals
  bot.command('goals', async (ctx) => {
    const goals = getAllGoals();

    if (goals.length === 0) {
      await ctx.reply('No goals yet. Add one with /goal <project> <title>');
      return;
    }

    const summary = getGoalsSummary();
    const lines = [
      `Goals: ${summary.total} total`,
      `Pending: ${summary.pending} | In Progress: ${summary.inProgress}`,
      `Completed: ${summary.completed} | Blocked: ${summary.blocked}`,
      '',
    ];

    // Group by status
    const byStatus: Record<string, Goal[]> = {};
    for (const goal of goals) {
      byStatus[goal.status] = byStatus[goal.status] || [];
      byStatus[goal.status].push(goal);
    }

    for (const [status, statusGoals] of Object.entries(byStatus)) {
      lines.push(`--- ${status.toUpperCase()} ---`);
      for (const goal of statusGoals.slice(0, 5)) {
        const prefix = goal.status === 'blocked' ? '\u26D4' :
                       goal.status === 'completed' ? '\u2705' :
                       goal.status === 'in-progress' ? '\u{1F504}' : '\u23F3';
        lines.push(`${prefix} [${goal.project}] ${goal.title}`);
        if (goal.blockedReason) {
          lines.push(`   Reason: ${goal.blockedReason}`);
        }
      }
      if (statusGoals.length > 5) {
        lines.push(`   ... and ${statusGoals.length - 5} more`);
      }
    }

    await ctx.reply(lines.join('\n'));
  });

  // Command: /digest
  bot.command('digest', async (ctx) => {
    const digest = await generateDigest();
    const formatted = formatDigestForTelegram(digest);
    await ctx.reply(formatted, { parse_mode: 'Markdown' });
  });

  // Command: /redo <goal_id> "additional context"
  bot.command('redo', async (ctx) => {
    const text = ctx.message.text.replace('/redo', '').trim();
    if (!text) {
      await ctx.reply('Usage: /redo <goal-id> "additional context"');
      return;
    }

    // Parse goal ID and optional context
    const parts = text.split(/\s+/);
    const goalId = parts[0];
    const context = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');

    try {
      const { getGoal } = await import('../orchestration/goal-manager.js');
      const { insertFeedback } = await import('../db/feedback.js');
      const { getLatestRunForGoal } = await import('../db/execution-log.js');

      const original = getGoal(goalId);
      if (!original) {
        await ctx.reply(`Goal not found: ${goalId}`);
        return;
      }

      // Record redo feedback
      const latestRun = getLatestRunForGoal(goalId);
      insertFeedback({
        runId: latestRun?.id,
        goalId,
        type: 'redo',
        comment: context || 'User requested redo',
        redoContext: context,
      });

      // Create new goal with original spec + redo context
      const redoDescription = [
        original.description || '',
        '',
        '--- REDO ---',
        `Previous attempt: ${goalId}`,
        context ? `Additional context: ${context}` : 'User wants a different approach.',
        'Try a fundamentally different approach from the previous attempt.',
      ].join('\n');

      const newGoal = addGoal(original.project, original.title, redoDescription);
      await ctx.reply(
        `Redo created:\n` +
        `  New: ${newGoal.id}\n` +
        `  Original: ${goalId}\n` +
        `  Project: ${original.project}\n` +
        (context ? `  Context: ${context}` : '')
      );
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /delete <goal-id>
  bot.command('delete', async (ctx) => {
    const goalId = ctx.message.text.replace('/delete', '').trim();

    if (!goalId) {
      await ctx.reply('Usage: /delete <goal-id>');
      return;
    }

    const deleted = deleteGoal(goalId);
    if (deleted) {
      await ctx.reply(`Deleted goal: ${goalId}`);
    } else {
      await ctx.reply(`Goal not found: ${goalId}`);
    }
  });

  // Command: /clear
  bot.command('clear', async (ctx) => {
    const count = clearCompletedGoals();
    await ctx.reply(`Cleared ${count} completed goals.`);
  });
}
