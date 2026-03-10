/**
 * Testing & QA commands: /smoketest, /autotest, /simulate, /retest, /testhealth, /discovertests
 */

import type { Telegraf, Context } from 'telegraf';
import { listProjectNames, getProject } from '../projects/registry.js';
import { runTask } from '../projects/task-runner.js';
import { generateAutoTestPrompt } from '../testing/auto-test.js';
import { sendLongMessage } from './core.js';

export function registerTestingCommands(bot: Telegraf<Context>) {
  // Command: /smoketest <project>
  bot.command('smoketest', async (ctx) => {
    const projectName = ctx.message.text.replace('/smoketest', '').trim();

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /smoketest <project>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      await ctx.reply(`Running smoke test on ${projectName}...`);
      const { runSmokeTest } = await import('../orchestration/smoke-test.js');
      const snapshot = await runSmokeTest(projectName);

      const lines: string[] = [];
      lines.push(`Smoke Test: ${projectName}`);
      lines.push(`Routes: ${snapshot.totalRoutes}`);
      lines.push(`Healthy: ${snapshot.healthyRoutes}`);
      lines.push(`Broken: ${snapshot.brokenRoutes}`);
      lines.push(`Errors: ${snapshot.errorRoutes}`);
      lines.push(`Placeholders: ${snapshot.placeholderRoutes}`);

      if (snapshot.brokenRoutes > 0 || snapshot.errorRoutes > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const r of snapshot.routes.filter(r => r.hasErrors || r.status >= 500 || r.status === 0)) {
          lines.push(`  ${r.path}: ${r.errorSnippet?.slice(0, 80) || `HTTP ${r.status}`}`);
        }
      }

      if (snapshot.placeholderRoutes > 0) {
        lines.push('');
        lines.push('Placeholder/fake data:');
        for (const r of snapshot.routes.filter(r => r.hasPlaceholders)) {
          lines.push(`  ${r.path}: ${r.placeholderSnippet?.slice(0, 80) || 'detected'}`);
        }
      }

      await sendLongMessage(ctx, lines.join('\n'));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /autotest <project> [focus]
  bot.command('autotest', async (ctx) => {
    const text = ctx.message.text.replace('/autotest', '').trim();
    const parts = text.split(' ');
    const projectName = parts[0];
    const focus = parts.slice(1).join(' ') || undefined;

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /autotest <project> [focus]\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      await ctx.reply(`Starting auto-test for ${projectName}${focus ? ` (${focus})` : ''}...`);

      const prompt = await generateAutoTestPrompt(projectName, focus, {
        useMobileSafari: text.includes('mobile'),
        multiUser: text.includes('multi'),
      });

      const result = await runTask(projectName, prompt, {
        autonomous: true,
        maxIterations: 30,
        onProgress: (output) => {
          // Only send significant updates
          if (output.includes('GOAL_COMPLETE') || output.includes('BLOCKED') || output.includes('ERROR')) {
            ctx.reply(output.slice(-500));
          }
        },
      });

      if (result.goalComplete) {
        await ctx.reply(`\u2705 Testing complete for ${projectName}`);
      } else if (result.blocked) {
        await ctx.reply(`\u26D4 Testing blocked: ${result.blockedReason}`);
      } else {
        await ctx.reply(`Testing finished after ${result.iterations} iterations`);
      }
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /simulate <project> — Run user simulation
  bot.command('simulate', async (ctx) => {
    const projectName = ctx.message.text.replace('/simulate', '').trim();

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /simulate <project>\n\nRuns a Haiku agent that tries natural language tasks (like a real user) via Playwright.\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      getProject(projectName); // Validate project exists
      await ctx.reply(`\u{1F9EA} Running user simulation for ${projectName}... (takes ~1-2 min)`);

      const { runProjectSimulation } = await import('../testing/user-simulation.js');
      const run = await runProjectSimulation(projectName, async (msg) => {
        if (msg.includes('PASS') || msg.includes('FAIL') || msg.includes('STUCK')) {
          await ctx.reply(msg).catch(() => {});
        }
      });

      const lines: string[] = [`\u{1F9EA} Simulation Results: ${projectName}\n`];
      let passed = 0;
      let failed = 0;
      for (const result of run.results) {
        const icon = result.success ? '\u2705' : '\u274C';
        if (result.success) passed++;
        else failed++;
        lines.push(`${icon} ${result.taskDescription.slice(0, 60)}`);
        if (!result.success && result.stuckPoints.length > 0) {
          lines.push(`   Stuck: ${result.stuckPoints[0].slice(0, 80)}`);
        }
      }
      lines.push(`\n${passed} passed, ${failed} failed`);

      await sendLongMessage(ctx, lines.join('\n'));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /retest <project> - Run cascade retest for a project
  bot.command('retest', async (ctx) => {
    const projectName = ctx.message.text.replace('/retest', '').trim();

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /retest <project>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      const { runCascadeRetest, formatRetestResult } = await import('../orchestration/cascade-retest.js');

      await ctx.reply(`\u{1F504} Running cascade retest for ${projectName}...`);

      const { analysis, result } = await runCascadeRetest(projectName, async (msg) => {
        // Send progress updates for significant messages
        if (msg.includes('FAILED') || msg.includes('passed')) {
          await ctx.reply(msg);
        }
      });

      if (result) {
        await ctx.reply(formatRetestResult(result));
      } else {
        await ctx.reply(`\u{1F4CA} ${analysis.reason}`);
      }
    } catch (error) {
      await ctx.reply(`\u274C Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /testhealth - View test health summary
  bot.command('testhealth', async (ctx) => {
    const { getTestHealthSummary, discoverDependencies } = await import('../orchestration/cascade-retest.js');
    const health = getTestHealthSummary();

    const lines = [
      '\u{1F9EA} Test Health Summary',
      '',
      `\u{1F4CA} ${health.totalTests} registered tests`,
      `\u2705 Recently passed: ${health.recentlyPassed}`,
      `\u274C Recently failed: ${health.recentlyFailed}`,
      `\u2753 Never run: ${health.neverRun}`,
    ];

    if (Object.keys(health.byProject).length > 0) {
      lines.push('', 'By Project:');
      for (const [project, stats] of Object.entries(health.byProject)) {
        const emoji = stats.failed > 0 ? '\u26A0\uFE0F' : stats.passed > 0 ? '\u2705' : '\u2753';
        lines.push(`  ${emoji} ${project}: ${stats.passed}\u2705 ${stats.failed}\u274C ${stats.notRun}\u2753`);
      }
    }

    if (health.totalTests === 0) {
      lines.push('', '\u{1F4A1} Run /discovertests <project> to discover test dependencies');
    }

    await ctx.reply(lines.join('\n'));
  });

  // Command: /discovertests <project> - Discover test dependencies
  bot.command('discovertests', async (ctx) => {
    const projectName = ctx.message.text.replace('/discovertests', '').trim();

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /discovertests <project>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      const { discoverDependencies } = await import('../orchestration/cascade-retest.js');

      await ctx.reply(`\u{1F50D} Discovering test dependencies for ${projectName}...`);
      const discovered = await discoverDependencies(projectName);

      await ctx.reply(`\u2705 Discovered ${discovered.length} tests with ${discovered.reduce((sum, d) => sum + d.dependsOn.length, 0)} total dependencies`);
    } catch (error) {
      await ctx.reply(`\u274C Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });
}
