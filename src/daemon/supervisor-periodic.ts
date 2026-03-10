/**
 * Supervisor Periodic Tasks — heartbeat, meta-review, test sweep, PM sweep,
 * feedback processing, goal archival, morning digest, and proposal flushing.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { logEvent } from '../db/supervisor-events.js';
import { countEventsSince } from '../db/supervisor-events.js';
import {
  getActiveItems,
  getQueuedCount,
} from '../db/work-queue.js';
import { getPendingGoals } from '../orchestration/goal-manager.js';
import { runMetaReview } from '../scheduler/meta-review.js';
import { runTestSweep } from '../scheduler/test-sweep.js';
import { runPMSweepAll, formatPMReport } from '../pm/pm-agent.js';
import { processPendingFeedback } from '../orchestration/feedback-processor.js';
import { getUnsentProposals, markProposalSent } from '../orchestration/pending-proposals.js';
import { recordDailySnapshot } from '../analytics/time-series.js';
import { generateDigest, formatDigestForTelegram } from '../orchestration/digest.js';
import { archiveOldGoals } from '../orchestration/goal-archival.js';
import { preflight } from './preflight.js';
import { createLogger } from '../utils/logger.js';

import { config, isSessionLimitPaused, getSessionLimitPauseUntil, getClaudeWeeklyUsagePct } from './supervisor-config.js';
import { getCachedWeeklyUsagePct, getRealWeeklyUsagePct } from '../orchestration/usage-scraper.js';

const slog = createLogger('supervisor-periodic');
import {
  lastMetaReview, setLastMetaReview,
  lastTestSweep, setLastTestSweep,
  lastHeartbeat, setLastHeartbeat,
  lastPMSweep, setLastPMSweep,
  lastFeedbackProcess, setLastFeedbackProcess,
  lastGoalArchival, setLastGoalArchival,
  lastMorningDigest, setLastMorningDigest,
  getLastPreflight, setLastPreflight,
  getLastPreflightTime, setLastPreflightTime,
  getLastPreflightHealthy, setLastPreflightHealthy,
  PREFLIGHT_INTERVAL_MS,
  rateLimitPauseUntil,
} from './supervisor-state.js';
import { log, withTimeout } from './supervisor-utils.js';
import { sendTelegram, getTelegramBot, getTelegramChatId } from './supervisor-telegram.js';
import { isRateLimitPaused } from './supervisor-capacity.js';

const __filename_periodic = fileURLToPath(import.meta.url);
const __dirname_periodic = dirname(__filename_periodic);

// ── Periodic Tasks ─────────────────────────────────────────

export async function runPeriodicTasks(): Promise<void> {
  const now = Date.now();

  // Preflight (every 5 min)
  if (now - getLastPreflightTime() >= PREFLIGHT_INTERVAL_MS) {
    setLastPreflightTime(now);
    try {
      const preflightResult = await withTimeout(preflight(log), 90_000, 'preflight');
      if (preflightResult) {
        setLastPreflight(preflightResult);
        const lastPreflight = getLastPreflight();
        const currentlyHealthy = lastPreflight.ready;
        const wasHealthy = getLastPreflightHealthy();
        if (!currentlyHealthy && wasHealthy) {
          // State changed: healthy → unhealthy — notify
          const msg = `🔴 Preflight failed:\n${lastPreflight.issues.map(i => `• ${i}`).join('\n')}`;
          log(msg, 'warn');
          sendTelegram(msg).catch((e) => slog.swallow('send-telegram', e));
        } else if (currentlyHealthy && !wasHealthy) {
          // State changed: unhealthy → healthy — notify recovery
          log('Preflight recovered — all checks passing');
          sendTelegram('✅ Preflight recovered — all checks passing').catch((e) => slog.swallow('send-telegram', e));
        } else if (!currentlyHealthy) {
          // Still unhealthy — log only, don't spam Telegram
          log(`Preflight still failing: ${lastPreflight.issues.join('; ')}`, 'warn');
        }
        setLastPreflightHealthy(currentlyHealthy);
      } else {
        log('Preflight timed out — keeping previous state', 'warn');
      }
    } catch (e) {
      log(`Preflight error: ${e}`, 'error');
      setLastPreflight({ ready: false, issues: [`Preflight crashed: ${e}`], projectHealth: new Map() });
    }
  }

  // Scrape real usage from claude.ai (every heartbeat cycle, cache handles dedup)
  try {
    await withTimeout(getRealWeeklyUsagePct(), 45_000, 'scrape-usage');
  } catch (e) { slog.swallow('scrape-usage', e); }

  // Hourly heartbeat
  if (now - lastHeartbeat >= config.heartbeatIntervalMs) {
    setLastHeartbeat(now);
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const events = countEventsSince(todayStart.toISOString());
      const active = getActiveItems().length;
      const queued = getQueuedCount();
      const pending = getPendingGoals().length;

      // Token usage from execution log
      let tokenInfo = '';
      try {
        const { getCostSummary } = await import('../db/execution-log.js');
        const summary = getCostSummary(todayStart.toISOString());
        const inK = Math.round(summary.totalInputTokens / 1000);
        const outK = Math.round(summary.totalOutputTokens / 1000);
        tokenInfo = `, ~${inK}K in / ~${outK}K out`;
      } catch (e) { slog.swallow('get-token-usage', e); }

      const sessionLimitPauseUntil = getSessionLimitPauseUntil();
      const rateLimitStatus = isSessionLimitPaused()
        ? ` ⛔ session-limited until ${new Date(sessionLimitPauseUntil).toLocaleTimeString()}`
        : isRateLimitPaused()
          ? ` ⚠️ rate-limited until ${new Date(rateLimitPauseUntil).toLocaleTimeString()}`
          : '';

      // Weekly usage percentage — prefer real scraped data from claude.ai
      let providerSplit = '';
      try {
        const realPct = getCachedWeeklyUsagePct();
        if (realPct !== null && realPct >= 0) {
          providerSplit = `, ${Math.round(realPct)}% weekly usage`;
        } else {
          // Fall back to self-estimated budget tracking
          const usagePct = Math.round(getClaudeWeeklyUsagePct() * 100);
          if (usagePct > 0) {
            providerSplit = `, ~${usagePct}% weekly budget (est)`;
          }
        }
      } catch (e) { slog.swallow('get-weekly-usage-pct', e); }

      const heartbeatMsg = `💓 Heartbeat: ${events['goal_complete'] || 0} completed, ${events['goal_failed'] || 0} failed, ${active} active, ${queued} queued, ${pending} pending${tokenInfo}${providerSplit}${rateLimitStatus}`;
      log(heartbeatMsg);
      logEvent('heartbeat', { details: heartbeatMsg });
    } catch (e) {
      log(`Heartbeat error: ${e}`, 'warn');
    }
  }

  // Meta-review (hourly)
  if (now - lastMetaReview >= config.metaReviewIntervalMs) {
    setLastMetaReview(now);
    try {
      await withTimeout(runMetaReview(async (msg) => { log(`[meta-review] ${msg}`); }), 60_000, 'runMetaReview');
    } catch (e) {
      log(`Meta-review error: ${e}`, 'warn');
    }
  }

  // Test sweep (every 30 min)
  if (now - lastTestSweep >= config.testSweepIntervalMs) {
    setLastTestSweep(now);
    try {
      await withTimeout(runTestSweep(async (msg) => { log(`[test-sweep] ${msg}`); }), 60_000, 'runTestSweep');
    } catch (e) {
      log(`Test sweep error: ${e}`, 'warn');
    }
  }

  // PM sweep (disabled — post-completion smoke test + TEST_COMMANDS cover verification)
  // Re-enable after writing per-project flow configs
  if (config.pmSweepIntervalMs > 0 && now - lastPMSweep >= config.pmSweepIntervalMs) {
    setLastPMSweep(now);
    try {
      const allFindings = await withTimeout(runPMSweepAll(), 120_000, 'runPMSweepAll');
      for (const findings of allFindings || []) {
        if (findings.issues.length > 0 || findings.goalsCreated.length > 0) {
          const report = formatPMReport(findings);
          log(`[PM] ${report}`);
        }

        // Notify about critical/high PM findings
        const critical = findings.issues.filter((i: any) => i.severity === 'critical');
        const high = findings.issues.filter((i: any) => i.severity === 'high');

        if (critical.length > 0 || high.length > 0) {
          const lines = [`🔍 PM Sweep: ${findings.project}`];
          if (critical.length > 0) {
            lines.push(`🔴 CRITICAL (${critical.length}):`);
            for (const i of critical.slice(0, 3)) {
              lines.push(`  • ${i.title}`);
            }
          }
          if (high.length > 0) {
            lines.push(`🟡 HIGH (${high.length}):`);
            for (const i of high.slice(0, 3)) {
              lines.push(`  • ${i.title}`);
            }
          }
          if (findings.goalsCreated.length > 0) {
            lines.push(`Goals proposed: ${findings.goalsCreated.length}`);
          }
          await sendTelegram(lines.join('\n')).catch((e) => slog.swallow('send-telegram', e));
        }
      }
    } catch (e) {
      log(`PM sweep error: ${e}`, 'warn');
    }
  }

  // Feedback processing (every 2 hours — turn user complaints into goals)
  if (now - lastFeedbackProcess >= config.feedbackProcessIntervalMs) {
    setLastFeedbackProcess(now);
    try {
      const fbResult = await withTimeout(processPendingFeedback(), 120_000, 'processPendingFeedback');
      if (fbResult && fbResult.goalsCreated.length > 0) {
        const goalList = fbResult.goalsCreated.map(g => `• ${g.title}`).join('\n');
        await sendTelegram(`📋 Feedback processed → ${fbResult.goalsCreated.length} new goal(s):\n${goalList}`).catch((e) => slog.swallow('send-telegram', e));
        log(`Feedback processing: ${fbResult.goalsCreated.length} goals created from ${fbResult.feedbackCount} feedback items`);
      }
    } catch (e) {
      log(`Feedback processing error: ${e}`, 'warn');
    }
  }

  // Goal archival (daily — move old completed goals to archive)
  if (now - lastGoalArchival >= config.goalArchivalIntervalMs) {
    setLastGoalArchival(now);
    try {
      const archiveResult = archiveOldGoals(30);
      if (archiveResult.archived > 0) {
        log(`Archived ${archiveResult.archived} old goals (${archiveResult.remaining} remaining)`);
      }
    } catch (e) {
      log(`Goal archival error: ${e}`, 'warn');
    }

    // Checkpoint cleanup — remove stale checkpoints alongside archival
    try {
      const { cleanupStaleCheckpoints } = await import('../db/checkpoints.js');
      const cleaned = cleanupStaleCheckpoints(48 * 60 * 60 * 1000); // 48h
      if (cleaned > 0) {
        log(`Cleaned up ${cleaned} stale execution checkpoint(s)`);
      }
    } catch (e) {
      log(`Checkpoint cleanup error: ${e}`, 'warn');
    }
  }

  // Morning digest (only at configured hour, once per day)
  const currentHour = new Date().getHours();
  const today = new Date().toISOString().split('T')[0];
  if (currentHour === config.morningDigestHour && lastMorningDigest !== today) {
    setLastMorningDigest(today);
    // Persist so restarts don't re-trigger
    try {
      const ctrlPath = join(__dirname_periodic, '../../data/supervisor-state-extra.json');
      const extra = existsSync(ctrlPath) ? JSON.parse(readFileSync(ctrlPath, 'utf-8')) : {};
      extra.lastDigestDate = today;
      writeFileSync(ctrlPath, JSON.stringify(extra, null, 2));
    } catch (e) { slog.swallow('persist-digest-date', e); }
    try {
      await withTimeout(sendMorningDigest(), 30_000, 'sendMorningDigest');
    } catch (e) {
      log(`Morning digest error: ${e}`, 'warn');
    }
    // Record daily metrics snapshot alongside morning digest
    try { recordDailySnapshot(); } catch (e) { log(`Daily metrics error: ${e}`, 'warn'); }
    // Daily debrief condensation — compress old debriefs into project summaries
    try {
      const { condenseAll } = await import('../orchestration/debrief-condenser.js');
      const condensed = condenseAll();
      if (condensed.size > 0) {
        log(`Condensed debriefs for ${[...condensed.keys()].join(', ')}`);
      }
    } catch (e) {
      log(`Debrief condensation error: ${e}`, 'warn');
    }
  }

  // Flush pending proposals as Telegram messages with approve/reject buttons
  try {
    const telegramBot = getTelegramBot();
    const telegramChatId = getTelegramChatId();
    const unsent = getUnsentProposals();
    for (const p of unsent) {
      const emoji = p.source === 'pm-agent' ? '🏥' : p.source === 'meta-review' ? '🧠' : p.source === 'test-sweep' ? '🔬' : '🤖';
      const text = `${emoji} *Goal proposal* (${p.source})\n\n*Project:* ${p.project}\n*Title:* ${p.title}\n\n${p.description.slice(0, 500)}`;
      if (telegramBot && telegramChatId) {
        try {
          const sent = await telegramBot.telegram.sendMessage(telegramChatId, text, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Approve', callback_data: `auto_approve:${p.id}` },
                { text: '❌ Reject', callback_data: `auto_reject:${p.id}` },
              ]],
            },
          });
          markProposalSent(p.id, sent.message_id);
        } catch (e) {
          // Retry without Markdown if parse fails
          try {
            const plainText = `${emoji} Goal proposal (${p.source})\n\nProject: ${p.project}\nTitle: ${p.title}\n\n${p.description.slice(0, 500)}`;
            const sent = await telegramBot.telegram.sendMessage(telegramChatId, plainText, {
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Approve', callback_data: `auto_approve:${p.id}` },
                  { text: '❌ Reject', callback_data: `auto_reject:${p.id}` },
                ]],
              },
            });
            markProposalSent(p.id, sent.message_id);
          } catch (e2) {
            log(`Failed to send proposal ${p.id}: ${e2}`, 'warn');
          }
        }
      }
    }
  } catch (e) {
    log(`Proposal flush error: ${e}`, 'warn');
  }
}

export async function sendMorningDigest(): Promise<void> {
  try {
    const digest = await generateDigest();
    const formatted = formatDigestForTelegram(digest);

    // Append live project links
    let links = '';
    try {
      const { getAllTunnelUrls } = await import('../projects/tunnel-manager.js');
      const urls = getAllTunnelUrls();
      const entries = Object.entries(urls).filter(([k]) => k !== 'prototypes');
      if (entries.length > 0) {
        links = '\n\n🔗 Live:\n' + entries.map(([name, url]) => `• ${name}: ${url}`).join('\n');
      }
    } catch (e) { slog.swallow('get-tunnel-urls-digest', e); }

    // Append weekly optimization summary (actionable recommendations only)
    let optimizerSummary = '';
    try {
      const { generateOptimizationReport, formatOptimizationReport } = await import('../analytics/optimizer.js');
      const report = generateOptimizationReport(7);
      if (report.recommendations.length > 0) {
        const actionItems = report.recommendations.filter(r => r.severity !== 'info');
        if (actionItems.length > 0) {
          const lines = ['\n\n📊 Optimization'];
          for (const rec of actionItems.slice(0, 5)) {
            const emoji = rec.severity === 'action' ? '🚨' : '⚠️';
            lines.push(`${emoji} ${rec.title}: ${rec.detail.slice(0, 150)}`);
          }
          optimizerSummary = lines.join('\n');
        }
      }
    } catch (e) { slog.swallow('optimizer-digest', e); }

    await sendTelegram(`☀️ Morning Digest${links}\n\n${formatted}${optimizerSummary}`);
    logEvent('digest_sent', { details: 'Morning digest sent' });
    log('Morning digest sent');
  } catch (e) {
    log(`Digest generation error: ${e}`, 'error');
  }
}
