/**
 * Review & feedback commands: /held, /approve, /feedback, /budget, /review, /escalations, /checkpoints
 */

import type { Telegraf, Context } from 'telegraf';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  getGoal,
  updateGoal,
  getPendingGoals,
} from '../orchestration/goal-manager.js';
import { sendLongMessage } from './core.js';

export function registerReviewCommands(bot: Telegraf<Context>) {
  // Command: /held - List yellow (held) goals waiting for review
  bot.command('held', async (ctx) => {
    try {
      const { getYellowGoals, formatHeldGoals } = await import('../orchestration/goal-triage.js');
      const pending = getPendingGoals();
      const yellowGoals = getYellowGoals(pending);
      await ctx.reply(formatHeldGoals(yellowGoals));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /approve <goal_id> [context] - Promote yellow goal to green
  bot.command('approve', async (ctx) => {
    const text = ctx.message.text.replace('/approve', '').trim();
    if (!text) {
      await ctx.reply('Usage: /approve <goal-id> [additional context]');
      return;
    }

    const parts = text.split(/\s+/);
    const goalId = parts[0];
    const context = parts.slice(1).join(' ').replace(/^["']|["']$/g, '') || undefined;

    try {
      const { promoteToGreen } = await import('../orchestration/goal-triage.js');

      const goal = getGoal(goalId);
      if (!goal) {
        await ctx.reply(`Goal not found: ${goalId}`);
        return;
      }

      const promoted = promoteToGreen(goal, context);
      updateGoal(goalId, {
        description: promoted.description,
        confidence: 'green',
        approvedAt: new Date().toISOString(),
      });

      await ctx.reply(
        `Approved: "${goal.title}" [${goal.project}]\n` +
        `Status: yellow -> green (will be dispatched)\n` +
        (context ? `Context added: ${context}` : '')
      );
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /feedback <goal_id> <thumbs> [comment]
  bot.command('feedback', async (ctx) => {
    const text = ctx.message.text.replace('/feedback', '').trim();
    if (!text) {
      await ctx.reply('Usage: /feedback <goal-id> <+/-> [comment]\n\nExamples:\n  /feedback goal-abc +\n  /feedback goal-abc - "spacing is wrong"');
      return;
    }

    const parts = text.split(/\s+/);
    const goalId = parts[0];
    const thumbs = parts[1];
    const comment = parts.slice(2).join(' ').replace(/^["']|["']$/g, '');

    if (!thumbs || !['+', '-', 'good', 'bad', 'positive', 'negative'].includes(thumbs)) {
      await ctx.reply('Second argument must be + or - (or good/bad)');
      return;
    }

    const isPositive = ['+', 'good', 'positive'].includes(thumbs);

    try {
      const { getGoal } = await import('../orchestration/goal-manager.js');
      const { insertFeedback } = await import('../db/feedback.js');
      const { getLatestRunForGoal } = await import('../db/execution-log.js');
      const { addLinearComment, isLinearEnabled } = await import('../integrations/linear.js');

      const goal = getGoal(goalId);
      if (!goal) {
        await ctx.reply(`Goal not found: ${goalId}`);
        return;
      }

      const latestRun = getLatestRunForGoal(goalId);
      insertFeedback({
        runId: latestRun?.id,
        goalId,
        type: isPositive ? 'positive' : 'negative',
        comment: comment || undefined,
      });

      // Post to Linear if connected
      if (goal.linearId && isLinearEnabled()) {
        const emoji = isPositive ? '\u{1F44D}' : '\u{1F44E}';
        const body = `${emoji} **Human Feedback:** ${isPositive ? 'Positive' : 'Negative'}${comment ? `\n${comment}` : ''}`;
        await addLinearComment(goal.linearId, body).catch(() => {});
      }

      const emoji = isPositive ? '\u{1F44D}' : '\u{1F44E}';
      await ctx.reply(`${emoji} Feedback recorded for: ${goal.title}${comment ? `\nNote: ${comment}` : ''}`);
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /budget [amount] - Show budget or set daily max
  bot.command('budget', async (ctx) => {
    const arg = ctx.message.text.replace('/budget', '').trim();

    // Set budget if amount provided
    if (arg) {
      const amount = parseFloat(arg);
      if (isNaN(amount) || amount <= 0 || amount > 200) {
        await ctx.reply('Usage: /budget [amount]\nAmount must be 1-200. No args = show current.');
        return;
      }

      const controlFile = resolve(process.cwd(), 'data/supervisor-control.json');
      try {
        const existing = existsSync(controlFile) ? JSON.parse(readFileSync(controlFile, 'utf8')) : {};
        writeFileSync(controlFile, JSON.stringify({
          ...existing,
          dailyBudgetUsd: amount,
          updatedAt: new Date().toISOString(),
        }, null, 2));
        await ctx.reply(`\u{1F4B0} Daily budget set to $${amount}. Supervisor will pick up the change within 10s.`);
      } catch (error) {
        await ctx.reply(`\u274C Error: ${error instanceof Error ? error.message : 'Unknown'}`);
      }
      return;
    }

    // Show budget
    try {
      const { getUsageSummary } = await import('../orchestration/budget.js');
      const summary = getUsageSummary();
      await ctx.reply(summary);
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /review — list goals awaiting visual review
  bot.command('review', async (ctx) => {
    try {
      const { getPendingReviewGoals } = await import('../orchestration/goal-manager.js');
      const goals = getPendingReviewGoals();

      if (goals.length === 0) {
        await ctx.reply('No goals awaiting review.');
        return;
      }

      const lines: string[] = [`\u{1F4CB} ${goals.length} goal(s) awaiting review:\n`];
      for (const goal of goals) {
        lines.push(`\u2022 [${goal.project}] ${goal.title}`);
        lines.push(`  ID: ${goal.id.slice(0, 20)}`);
        // Try to get tunnel URL
        try {
          const { getTunnelUrl } = await import('../projects/tunnel-manager.js');
          const tunnel = getTunnelUrl(goal.project);
          if (tunnel) lines.push(`  \u{1F517} ${tunnel}`);
        } catch { /* ignore */ }
        lines.push('');
      }
      lines.push('React \u{1F44D} on the completion message to approve, or reply with feedback to request changes.');

      await sendLongMessage(ctx, lines.join('\n'));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /escalations - View pending escalations
  bot.command('escalations', async (ctx) => {
    const { getEscalations, formatAssessmentForTelegram } = await import('../orchestration/quality.js');
    const escalations = getEscalations();

    if (escalations.length === 0) {
      await ctx.reply('No pending escalations. All clear!');
      return;
    }

    await ctx.reply(`\u{1F6A8} ${escalations.length} escalation(s) need attention:`);
    for (const e of escalations.slice(0, 5)) {
      await ctx.reply(formatAssessmentForTelegram(e));
    }
  });

  // Command: /checkpoints - View recent system checkpoints
  bot.command('checkpoints', async (ctx) => {
    const { listCheckpoints, formatCheckpointSummary } = await import('../orchestration/checkpoint.js');
    const checkpoints = listCheckpoints({ limit: 5 });

    if (checkpoints.length === 0) {
      await ctx.reply('\u{1F4CD} No checkpoints yet. They are created automatically during work.');
      return;
    }

    const lines = ['\u{1F4CD} Recent Checkpoints:', ''];
    for (const cp of checkpoints) {
      lines.push(formatCheckpointSummary(cp));
      lines.push('');
    }

    await ctx.reply(lines.join('\n'));
  });
}
