/**
 * Dev server & utility commands: /dev, /stopdev, /run, /links, /newchat
 */

import type { Telegraf, Context } from 'telegraf';
import { listProjectNames } from '../projects/registry.js';
import { startDevServer, stopDevServer } from '../projects/dev-server.js';
import { runQuickCommand } from '../projects/task-runner.js';

export function registerDevCommands(bot: Telegraf<Context>) {
  // Command: /dev <project>
  bot.command('dev', async (ctx) => {
    const projectName = ctx.message.text.replace('/dev', '').trim();

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /dev <project>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      await ctx.reply(`Starting dev server for ${projectName}...`);
      const result = await startDevServer(projectName);
      await ctx.reply(result.message);
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /stopdev <project>
  bot.command('stopdev', async (ctx) => {
    const projectName = ctx.message.text.replace('/stopdev', '').trim();

    if (!projectName) {
      await ctx.reply('Usage: /stopdev <project>');
      return;
    }

    try {
      const result = await stopDevServer(projectName);
      await ctx.reply(result.message);
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /run <project> <task>
  bot.command('run', async (ctx) => {
    const text = ctx.message.text.replace('/run', '').trim();
    const parts = text.split(' ');

    if (parts.length < 2) {
      await ctx.reply('Usage: /run <project> <task description>');
      return;
    }

    const projectName = parts[0];
    const task = parts.slice(1).join(' ');

    try {
      await ctx.reply(`Running task on ${projectName}...`);
      const output = await runQuickCommand(projectName, task);
      await ctx.reply(output.slice(0, 4000) || 'Task completed (no output)');
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /links — show all active app tunnel URLs
  bot.command('links', async (ctx) => {
    try {
      const { getAllTunnelUrls } = await import('../projects/tunnel-manager.js');
      const urls = getAllTunnelUrls();
      const entries = Object.entries(urls);
      if (entries.length === 0) {
        await ctx.reply('No active tunnels. Dev servers may not be running.');
        return;
      }
      const lines = entries.map(([name, url]) => `\u2022 ${name}: ${url}`);
      await ctx.reply(`\u{1F517} Active apps:\n${lines.join('\n')}`);
    } catch (err) {
      await ctx.reply(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  });
}
