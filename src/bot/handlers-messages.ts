/**
 * Message handlers: voice messages, text messages (director conversation, reply-to routing)
 */

import type { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import type { ChatResult } from '../director/index.js';
import {
  isTranscriptionEnabled,
  transcribeTelegramVoice,
  chat as directorChat,
} from '../director/index.js';
import {
  getGoal,
  updateGoal,
  recordLesson,
} from '../orchestration/goal-manager.js';
import {
  getActiveBatch,
} from '../orchestration/proposal-store.js';
import { sendLongMessage } from './core.js';

/**
 * Handle a ChatResult from the Director — send text, proposals, or goal confirmations.
 */
export async function handleChatResult(ctx: Context, result: ChatResult) {
  // Send conversational text
  if (result.text) {
    let text = result.text;
    if (result.learned > 0) text += `\n\n\u{1F9E0} Remembered ${result.learned} thing(s)`;
    if (result.decisions > 0) text += `\n\n\u{1F4CB} Logged ${result.decisions} decision(s)`;
    await sendLongMessage(ctx, text);
  }

  // Show proposal cards (interactive mode)
  if (result.proposals.length > 0 && result.batchId) {
    // Import showProposals from handlers-callbacks to avoid circular deps
    const { showProposals } = await import('./handlers-callbacks.js');
    const batch = getActiveBatch();
    if (batch) await showProposals(ctx, batch);
  }

  // Show created goals (autonomous mode)
  if (result.goalsCreated.length > 0) {
    await ctx.reply(
      `\u2705 Created ${result.goalsCreated.length} goal(s):\n` +
      result.goalsCreated.map(g => `  [${g.project}] ${g.title}`).join('\n')
    );
  }

  // Show held goals (autonomous mode)
  if (result.goalsHeld.length > 0) {
    await ctx.reply(
      `\u23F8 Held ${result.goalsHeld.length} for review. Use /held to see.`
    );
  }
}

export function registerMessageHandlers(bot: Telegraf<Context>, botToken: string) {
  // Handle voice messages - transcribe and send to Director
  bot.on(message('voice'), async (ctx) => {
    console.log(`[BOT] Voice message received from ${ctx.from?.username || ctx.from?.id}`);

    if (!isTranscriptionEnabled()) {
      await ctx.reply('Voice transcription not enabled (missing OpenAI key)');
      return;
    }

    await ctx.reply('\u{1F3A4} Transcribing voice note...');

    try {
      // Get file URL from Telegram
      const fileId = ctx.message.voice.file_id;
      const file = await ctx.telegram.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      // Transcribe
      const transcript = await transcribeTelegramVoice(fileUrl);
      await ctx.reply(`\u{1F4DD} "${transcript}"\n\n\u{1F914} Thinking...`);

      // Send to Director
      const result = await directorChat(transcript, 'voice');

      // Handle structured result
      await handleChatResult(ctx, result);
    } catch (error) {
      console.error('Voice transcription error:', error);
      await ctx.reply(`\u274C Failed to transcribe: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });

  // Handle text messages - route to Director for conversation
  bot.on(message('text'), async (ctx) => {
    console.log(`[BOT] Text message from ${ctx.from?.username || ctx.from?.id}: "${ctx.message.text.slice(0, 50)}..."`);

    // Ignore if it starts with /
    if (ctx.message.text.startsWith('/')) {
      await ctx.reply('Unknown command. Use /start for help.');
      return;
    }

    // Check if this is a reply to a goal completion message
    const replyTo = ctx.message.reply_to_message;
    if (replyTo && 'message_id' in replyTo) {
      try {
        const { getGoalForMessage, classifyFeedback } = await import('./telegram-goals.js');
        const mapping = getGoalForMessage(replyTo.message_id);
        if (mapping) {
          const { insertFeedback } = await import('../db/feedback.js');
          const { updateGoal, getGoal } = await import('../orchestration/goal-manager.js');
          const sentiment = classifyFeedback(ctx.message.text);

          const goal = getGoal(mapping.goalId);
          const isAwaitingFeedback = goal?.reviewStatus === 'needs_work';
          const userText = ctx.message.text.trim();
          const isRedo = /^redo$/i.test(userText);

          // If goal is awaiting feedback (after thumbs down), treat any reply as the feedback
          if (isAwaitingFeedback && goal) {
            const feedbackText = isRedo
              ? 'User requested redo (no specific feedback)'
              : userText;
            insertFeedback({ goalId: mapping.goalId, type: 'negative', comment: feedbackText });
            recordLesson(goal, 'user-feedback', feedbackText);
            updateGoal(mapping.goalId, {
              status: 'pending',
              completedAt: undefined,
              lastRejectionReason: `User feedback: ${feedbackText}`.slice(0, 500),
            });
            await ctx.reply(`\u{1F504} Re-queued with your feedback. Agent will address: "${feedbackText.slice(0, 100)}"`);
            return;
          }

          if (sentiment === 'positive') {
            insertFeedback({ goalId: mapping.goalId, type: 'positive', comment: userText });
            updateGoal(mapping.goalId, { reviewStatus: 'approved' });
            await ctx.reply('\u{1F44D} Approved \u2014 goal marked as reviewed.');
            return;
          } else if (sentiment === 'negative') {
            insertFeedback({ goalId: mapping.goalId, type: 'negative', comment: userText });
            if (goal) recordLesson(goal, 'user-feedback', userText);
            // Re-queue the goal with user feedback
            if (goal && goal.status === 'completed') {
              updateGoal(mapping.goalId, {
                status: 'pending',
                reviewStatus: 'needs_work',
                completedAt: undefined,
                lastRejectionReason: `User feedback: ${userText}`.slice(0, 500),
              });
              await ctx.reply(`\u{1F504} Re-queued with your feedback. Goal will be reworked.`);
            } else {
              await ctx.reply('\u{1F4DD} Negative feedback recorded.');
            }
            return;
          } else {
            // Neutral — record as context
            insertFeedback({ goalId: mapping.goalId, type: 'positive', comment: `[context] ${userText}` });
            await ctx.reply('\u{1F4DD} Context noted.');
            return;
          }
        }
      } catch (err) {
        console.error('[BOT] Reply feedback error:', err);
      }
    }

    await ctx.reply('\u{1F914} Thinking... (may take a few minutes for complex questions)');

    // Progress indicator for long-running requests
    let thinkingDots = 0;
    const progressInterval = setInterval(async () => {
      thinkingDots++;
      if (thinkingDots <= 5) { // Max 5 updates over ~2.5 minutes
        try {
          await ctx.reply(`\u{1F4AD} Still thinking${'.'.repeat(thinkingDots)}`);
        } catch { /* ignore send errors */ }
      }
    }, 30000); // Every 30 seconds

    try {
      // Send to Director for full conversation (can take up to 10 min)
      const result = await directorChat(ctx.message.text, 'text');
      clearInterval(progressInterval);

      // Handle structured result
      await handleChatResult(ctx, result);
    } catch (error) {
      clearInterval(progressInterval);
      console.error('Director chat error:', error);
      await ctx.reply(`\u274C Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });
}
