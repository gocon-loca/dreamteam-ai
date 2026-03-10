/**
 * Analytics commands: /costs, /efficiency, /patterns, /optimize, /calibration, /knowledge, /decisions
 */

import type { Telegraf, Context } from 'telegraf';
import { sendLongMessage } from './core.js';

export function registerAnalyticsCommands(bot: Telegraf<Context>) {
  // Command: /patterns - Show success patterns from historical data
  bot.command('patterns', async (ctx) => {
    try {
      const { getSuccessPatterns, formatPatternsReport } = await import('../analytics/patterns.js');
      const report = getSuccessPatterns();
      await ctx.reply(formatPatternsReport(report));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /costs [day|week|month] - Cost breakdown
  bot.command('costs', async (ctx) => {
    const period = (ctx.message.text.replace('/costs', '').trim() || 'day') as 'day' | 'week' | 'month';
    if (!['day', 'week', 'month'].includes(period)) {
      await ctx.reply('Usage: /costs [day|week|month]');
      return;
    }

    try {
      const { getCostBreakdown, formatCostReport } = await import('../analytics/patterns.js');
      const report = getCostBreakdown(period);
      await ctx.reply(formatCostReport(report));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /efficiency - Model efficiency report
  bot.command('efficiency', async (ctx) => {
    try {
      const { getModelEfficiency, formatEfficiencyReport } = await import('../analytics/patterns.js');
      const report = getModelEfficiency();
      await ctx.reply(formatEfficiencyReport(report));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /optimize [days] - Weekly optimization report
  bot.command('optimize', async (ctx) => {
    const daysArg = ctx.message.text.replace('/optimize', '').trim();
    const days = daysArg ? parseInt(daysArg, 10) : 7;
    if (isNaN(days) || days < 1 || days > 90) {
      await ctx.reply('Usage: /optimize [days] (1-90, default 7)');
      return;
    }

    try {
      await ctx.reply(`Generating ${days}-day optimization report...`);
      const { generateOptimizationReport, formatOptimizationReport } = await import('../analytics/optimizer.js');
      const report = generateOptimizationReport(days);
      await sendLongMessage(ctx, formatOptimizationReport(report));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /calibration - View calibration stats
  bot.command('calibration', async (ctx) => {
    const { getCalibrationStats, getUncalibratedAssessments } = await import('../orchestration/quality.js');
    const stats = getCalibrationStats();
    const uncalibrated = getUncalibratedAssessments();

    const lines = [
      '\u{1F4CA} Calibration Stats',
      '',
      `Total assessments: ${stats.totalAssessments}`,
      `Calibrated: ${stats.calibrated} | Pending: ${stats.uncalibrated}`,
      '',
      `Accuracy rate: ${(stats.accuracyRate * 100).toFixed(0)}%`,
      `Overconfidence: ${(stats.overconfidenceRate * 100).toFixed(0)}%`,
      `Underconfidence: ${(stats.underconfidenceRate * 100).toFixed(0)}%`,
    ];

    if (Object.keys(stats.byProject).length > 0) {
      lines.push('', 'By Project:');
      for (const [project, ps] of Object.entries(stats.byProject)) {
        lines.push(`  ${project}: ${(ps.accuracyRate * 100).toFixed(0)}% accurate (${ps.total} samples)`);
      }
    }

    if (uncalibrated.length > 0) {
      lines.push('', `\u23F3 ${uncalibrated.length} assessments awaiting calibration`);
    }

    await ctx.reply(lines.join('\n'));
  });

  // Command: /knowledge - View Director's knowledge graph
  bot.command('knowledge', async (ctx) => {
    const { getRecentKnowledge, analyzePatterns } = await import('../director/knowledge.js');
    const recent = getRecentKnowledge(10);
    const patterns = analyzePatterns();

    if (recent.length === 0) {
      await ctx.reply('\u{1F9E0} No knowledge stored yet. I learn as we talk!');
      return;
    }

    const lines = [
      '\u{1F9E0} Director Knowledge Graph',
      '',
      `\u{1F4DA} ${recent.length} entries stored`,
      '',
    ];

    // Group by type
    const byType: Record<string, typeof recent> = {};
    for (const entry of recent) {
      byType[entry.type] = byType[entry.type] || [];
      byType[entry.type].push(entry);
    }

    for (const [type, entries] of Object.entries(byType)) {
      const emoji = type === 'decision' ? '\u{1F3AF}' : type === 'pattern' ? '\u{1F4CA}' : type === 'preference' ? '\u{1F4A1}' : '\u{1F4DD}';
      lines.push(`${emoji} ${type.toUpperCase()}:`);
      for (const e of entries.slice(0, 3)) {
        lines.push(`  \u2022 ${e.content.slice(0, 60)}...`);
      }
      if (entries.length > 3) {
        lines.push(`  ... and ${entries.length - 3} more`);
      }
      lines.push('');
    }

    if (patterns.crossProjectThemes.length > 0) {
      lines.push('\u{1F517} Cross-Project Themes:');
      lines.push(`  ${patterns.crossProjectThemes.join(', ')}`);
    }

    await ctx.reply(lines.join('\n'));
  });

  // Command: /decisions - View recent decisions from journal
  bot.command('decisions', async (ctx) => {
    const { getRecentDecisions, formatDecisionForTelegram, analyzeDecisionPatterns } = await import('../director/decision-journal.js');
    const recent = getRecentDecisions(5);
    const patterns = analyzeDecisionPatterns();

    if (recent.length === 0) {
      await ctx.reply('\u{1F4CB} No decisions logged yet. The Director logs decisions during conversations.');
      return;
    }

    const lines = [
      '\u{1F4CB} Decision Journal',
      '',
      `\u{1F4CA} ${patterns.totalDecisions} total | ${patterns.outcomeStats.pending} pending outcomes`,
      '',
    ];

    for (const d of recent) {
      lines.push(formatDecisionForTelegram(d));
      lines.push('');
    }

    if (patterns.outcomeStats.failure > 0) {
      lines.push(`\u26A0\uFE0F ${patterns.outcomeStats.failure} decisions had failed outcomes`);
    }

    await ctx.reply(lines.join('\n'));
  });
}
