/**
 * Callback and reaction handlers:
 * - fix_goal, dismiss_feedback, auto_approve, auto_reject callbacks
 * - Proposal batch callbacks (p:{batchId}:{action}:{index})
 * - Emoji reaction handler (thumbs up/down on goal completion messages)
 */

import type { Telegraf, Context } from 'telegraf';
import { Markup } from 'telegraf';
import {
  addGoal,
  getGoal,
  updateGoal,
  recordLesson,
} from '../orchestration/goal-manager.js';
import {
  getActiveBatch,
  confirmProposal,
  confirmBatch,
  dropProposal,
  dropBatch,
  type ProposalBatch,
} from '../orchestration/proposal-store.js';

/**
 * Show proposal cards with inline approve/drop buttons.
 * Each proposal gets its own message; a summary message at the end.
 */
export async function showProposals(ctx: Context, batch: ProposalBatch) {
  for (let i = 0; i < batch.proposals.length; i++) {
    const p = batch.proposals[i];
    const icon = p.confidence === 'green' ? '\u{1F7E2}' : '\u{1F7E1}';
    const descPreview = p.description.length > 120
      ? p.description.slice(0, 120) + '...'
      : p.description;

    const text = [
      `${icon} [${i + 1}/${batch.proposals.length}] ${p.project}: "${p.title}"`,
      `${p.model} | ~$${p.estimatedCostUsd.toFixed(2)} | ${p.complexity}`,
      p.confidenceReason ? p.confidenceReason : '',
      descPreview,
    ].filter(Boolean).join('\n');

    await ctx.reply(text, Markup.inlineKeyboard([
      Markup.button.callback('Approve', `p:${batch.id}:ok:${i}`),
      Markup.button.callback('Drop', `p:${batch.id}:drop:${i}`),
      Markup.button.callback('Details', `p:${batch.id}:det:${i}`),
    ]));
  }

  // Summary message with batch-level actions
  const greenCost = batch.proposals
    .filter(p => p.confidence === 'green')
    .reduce((sum, p) => sum + p.estimatedCostUsd, 0);

  const summaryLines = [
    `Total: ${batch.proposals.length} goals, ~$${batch.totalEstimatedCostUsd.toFixed(2)}`,
    `${batch.greenCount} green, ${batch.yellowCount} yellow`,
  ];

  const buttons = [
    [Markup.button.callback(
      `Confirm All ($${batch.totalEstimatedCostUsd.toFixed(2)})`,
      `p:${batch.id}:all:0`
    )],
  ];

  if (batch.greenCount > 0 && batch.yellowCount > 0) {
    buttons.push([
      Markup.button.callback(
        `Green Only ($${greenCost.toFixed(2)})`,
        `p:${batch.id}:grn:0`
      ),
      Markup.button.callback('Drop All', `p:${batch.id}:nope:0`),
    ]);
  } else {
    buttons.push([
      Markup.button.callback('Drop All', `p:${batch.id}:nope:0`),
    ]);
  }

  await ctx.reply(summaryLines.join(' | '), Markup.inlineKeyboard(buttons));
}

export function registerCallbackHandlers(bot: Telegraf<Context>) {
  // Callback: fix_goal — create a fix goal from negative feedback
  bot.action(/^fix_goal:([^:]+):(.+)$/, async (ctx) => {
    const goalId = ctx.match[1];
    const project = ctx.match[2];
    try {
      const { getGoal, addGoal } = await import('../orchestration/goal-manager.js');
      const original = getGoal(goalId);
      const title = original ? `Fix issues from: ${original.title}` : `Fix issues from ${goalId.slice(0, 12)}`;
      const desc = `The previous goal (${goalId}) received negative feedback. Review and fix the issues.\n\nOriginal title: ${original?.title || 'unknown'}\nAcceptance: all feedback issues resolved, app working correctly.`;
      const newGoal = addGoal(project, title, desc);
      await ctx.answerCbQuery('Fix goal created');
      await ctx.editMessageReplyMarkup(undefined);
      await ctx.reply(`\u{1F527} Created fix goal: ${newGoal.id.slice(0, 15)}\n${title}`);
    } catch (err) {
      console.error('[Bot] fix_goal error:', err);
      try { await ctx.answerCbQuery('Error creating goal'); } catch { /* stale query */ }
    }
  });

  // Callback: dismiss_feedback
  bot.action(/^dismiss_feedback:/, async (ctx) => {
    try {
      await ctx.answerCbQuery('Dismissed');
      await ctx.editMessageReplyMarkup(undefined);
    } catch (err) {
      console.error('[Bot] dismiss_feedback error:', err);
    }
  });

  // Callback: auto_approve — approve an auto-proposed goal
  bot.action(/^auto_approve:(.+)$/, async (ctx) => {
    const proposalId = ctx.match[1];
    try {
      const { approveProposal, getProposal } = await import('../orchestration/pending-proposals.js');
      const proposal = getProposal(proposalId);
      const goalId = approveProposal(proposalId);
      if (goalId) {
        await ctx.answerCbQuery('Goal created!');
        await ctx.editMessageReplyMarkup(undefined);
        await ctx.reply(`\u2705 Approved \u2192 created goal ${goalId.slice(0, 15)}\n${proposal?.title || ''}`);
      } else {
        await ctx.answerCbQuery('Already resolved or expired');
      }
    } catch (err) {
      console.error('[Bot] auto_approve error:', err);
      try { await ctx.answerCbQuery('Error approving'); } catch { /* stale */ }
    }
  });

  // Callback: auto_reject — reject an auto-proposed goal
  bot.action(/^auto_reject:(.+)$/, async (ctx) => {
    const proposalId = ctx.match[1];
    try {
      const { rejectProposal } = await import('../orchestration/pending-proposals.js');
      const ok = rejectProposal(proposalId);
      if (ok) {
        await ctx.answerCbQuery('Rejected');
        await ctx.editMessageReplyMarkup(undefined);
        await ctx.reply('\u274C Proposal rejected.');
      } else {
        await ctx.answerCbQuery('Already resolved');
      }
    } catch (err) {
      console.error('[Bot] auto_reject error:', err);
      try { await ctx.answerCbQuery('Error rejecting'); } catch { /* stale */ }
    }
  });

  // Callback data format: p:{batchId}:{action}:{index}
  // Actions: ok (approve one), drop (drop one), det (details), all (confirm all), grn (green only), nope (drop all)
  bot.action(/^p:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
    const batchId = ctx.match[1];
    const action = ctx.match[2];
    const index = parseInt(ctx.match[3]);

    try {
      const batch = getActiveBatch();
      if (!batch || batch.id !== batchId) {
        await ctx.answerCbQuery('Proposals expired or already resolved.');
        return;
      }

      switch (action) {
        case 'ok': {
          const proposal = batch.proposals[index];
          if (!proposal) break;
          const goal = confirmProposal(batchId, proposal.id);
          if (goal) {
            await ctx.editMessageText(
              `\u2705 Approved: [${goal.project}] ${goal.title}\nGoal ID: ${goal.id}`
            );
          }
          await ctx.answerCbQuery('Approved!');
          break;
        }

        case 'drop': {
          const proposal = batch.proposals[index];
          if (!proposal) break;
          dropProposal(batchId, proposal.id);
          await ctx.editMessageText(
            `\u274C Dropped: [${proposal.project}] ${proposal.title}`
          );
          await ctx.answerCbQuery('Dropped.');
          break;
        }

        case 'det': {
          const proposal = batch.proposals[index];
          if (!proposal) break;
          await ctx.answerCbQuery();
          await ctx.reply(
            `\u{1F4CB} Full spec for: "${proposal.title}"\n\n` +
            `Project: ${proposal.project}\n` +
            `Model: ${proposal.model} | Cost: ~$${proposal.estimatedCostUsd.toFixed(2)}\n` +
            `Confidence: ${proposal.confidence} \u2014 ${proposal.confidenceReason}\n\n` +
            proposal.description
          );
          break;
        }

        case 'all': {
          const goals = confirmBatch(batchId, 'all');
          await ctx.editMessageText(
            `\u2705 Confirmed all ${goals.length} goal(s):\n` +
            goals.map(g => `  [${g.project}] ${g.title}`).join('\n')
          );
          await ctx.answerCbQuery(`Created ${goals.length} goals!`);
          break;
        }

        case 'grn': {
          const goals = confirmBatch(batchId, 'green');
          await ctx.editMessageText(
            `\u2705 Confirmed ${goals.length} green goal(s):\n` +
            goals.map(g => `  [${g.project}] ${g.title}`).join('\n')
          );
          await ctx.answerCbQuery(`Created ${goals.length} green goals!`);
          break;
        }

        case 'nope': {
          dropBatch(batchId);
          await ctx.editMessageText('\u274C All proposals dropped.');
          await ctx.answerCbQuery('All dropped.');
          break;
        }

        default:
          await ctx.answerCbQuery('Unknown action.');
      }
    } catch (error) {
      console.error('[Bot] Callback query error:', error);
      try { await ctx.answerCbQuery('Error processing action.'); } catch { /* stale query */ }
    }
  });
}

export function registerReactionHandler(bot: Telegraf<Context>) {
  // Handle emoji reactions (thumbs up/down) on goal completion messages
  bot.reaction(['\u{1F44D}', '\u{1F44E}', '\u2764', '\u{1F389}', '\u{1F525}', '\u{1F4AF}'], async (ctx) => {
    try {
      const update = ctx.update as any;
      const reaction = update.message_reaction;
      if (!reaction) return;
      const messageId = reaction.message_id;
      const newReactions: any[] = reaction.new_reaction || [];
      if (newReactions.length === 0) return;

      const { getGoalForMessage } = await import('./telegram-goals.js');
      const mapping = getGoalForMessage(messageId);
      if (!mapping) return; // Not a goal completion message

      const emoji = newReactions[0]?.emoji || '';
      const isPositive = ['\u{1F44D}', '\u2764', '\u{1F389}', '\u{1F525}', '\u{1F4AF}'].includes(emoji);
      const isNegative = emoji === '\u{1F44E}';

      if (!isPositive && !isNegative) return;

      const { insertFeedback } = await import('../db/feedback.js');
      const { updateGoal, getGoal } = await import('../orchestration/goal-manager.js');
      insertFeedback({
        goalId: mapping.goalId,
        type: isPositive ? 'positive' : 'negative',
        comment: `[reaction] ${emoji}`,
      });

      // Update reviewStatus
      if (isPositive) {
        updateGoal(mapping.goalId, { reviewStatus: 'approved' });
        console.log(`[BOT] \u{1F44D} Approved goal ${mapping.goalId}`);
      } else {
        // Thumbs down reaction — ask for details before re-queuing
        // Don't re-queue immediately. Mark needs_work and prompt for feedback.
        // The reply-to handler (below) will pick up the user's text and re-queue with context.
        const goal = getGoal(mapping.goalId);
        if (goal && goal.status === 'completed') {
          updateGoal(mapping.goalId, { reviewStatus: 'needs_work' });
          console.log(`[BOT] \u{1F44E} Goal ${mapping.goalId} marked needs_work \u2014 awaiting feedback text`);

          // Reply to the completion message asking what's wrong
          // Also map this reply message to the goal so the user can reply to either message
          try {
            const chatId = reaction.chat?.id;
            if (chatId) {
              const sent = await bot.telegram.sendMessage(
                chatId,
                `\u{1F44E} Got it \u2014 what needs fixing?\n\nReply to this message with details, or say "redo" to retry as-is.`,
                { reply_parameters: { message_id: messageId } },
              );
              // Map the bot's follow-up message to the same goal
              const { saveTelegramGoalMapping } = await import('./telegram-goals.js');
              saveTelegramGoalMapping(sent.message_id, mapping.goalId, mapping.project);
            }
          } catch (replyErr) {
            console.error('[BOT] Failed to send feedback prompt:', replyErr);
            // Fallback: re-queue immediately if we can't prompt
            if (goal) recordLesson(goal, 'user-feedback', 'User rejected via \u{1F44E} (no details)');
            updateGoal(mapping.goalId, {
              status: 'pending',
              completedAt: undefined,
              lastRejectionReason: 'User rejected via \u{1F44E} (no details provided)',
            });
            console.log(`[BOT] \u{1F44E} Fallback: re-queued goal ${mapping.goalId} without context`);
          }
        }
      }
    } catch (err) {
      console.error('[BOT] Reaction handler error:', err);
    }
  });
}
