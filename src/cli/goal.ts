#!/usr/bin/env tsx
/**
 * DreamTeam CLI — manage goals without Telegram
 *
 * Usage:
 *   pnpm goal add <project> <title> [--desc "..."] [--complexity routine|complex] [--archetype frontend|backend|...]
 *   pnpm goal show <id>
 *   pnpm goal list [status]
 *   pnpm goal status
 */

import { addGoal, updateGoal, getGoal, getAllGoals, getGoalsSummary } from '../orchestration/goal-manager.js';
import { listProjectNames } from '../projects/registry.js';

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];

/** Parse --flag value pairs from args, return { flags, positional } */
function parseArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1];
      i += 2;
    } else {
      positional.push(args[i]);
      i++;
    }
  }
  return { flags, positional };
}

function printHelp() {
  console.log(`
DreamTeam CLI — manage goals without Telegram

Usage:
  pnpm goal add <project> <title> [options]   Add a new goal
  pnpm goal show <id>                         Show goal details + result
  pnpm goal list [status]                     List goals (pending|completed|blocked|all)
  pnpm goal status                            System overview

Options for 'add':
  --desc "description"           Detailed description (supports TEST_COMMANDS: blocks)
  --complexity routine|complex   Goal complexity (default: auto-detected)
  --archetype frontend|backend   Force archetype (default: auto-classified)

Examples:
  pnpm goal add nlac "Fix broken zoom on nested diagrams"
  pnpm goal add my-api "Add rate limiting to /api/users endpoint" --desc "Add express-rate-limit middleware. Limit: 100 req/15min per IP. TEST_COMMANDS: curl -sf localhost:3001/api/users | head -1"
  pnpm goal add my-web-app "Build user settings page" --complexity complex --archetype frontend
  pnpm goal show goal-abc123
  pnpm goal list pending
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help') {
    printHelp();
    process.exit(0);
  }

  if (command === 'add') {
    const { flags, positional } = parseArgs(rawArgs.slice(1));
    const project = positional[0];
    const title = positional.slice(1).join(' ');

    if (!project || !title) {
      console.error('Usage: pnpm goal add <project> <title> [--desc "..."] [--complexity routine|complex]');
      process.exit(1);
    }

    const projects = listProjectNames();
    if (!projects.includes(project)) {
      console.error(`Unknown project "${project}". Available: ${projects.join(', ')}`);
      process.exit(1);
    }

    const description = flags.desc || flags.description || undefined;
    const goal = addGoal(project, title, description, 'cli');

    // Apply optional overrides
    const updates: Record<string, unknown> = {};
    if (flags.complexity && ['routine', 'complex'].includes(flags.complexity)) {
      updates.complexity = flags.complexity;
    }
    if (flags.archetype) {
      updates.archetype = flags.archetype;
    }
    if (Object.keys(updates).length > 0) {
      updateGoal(goal.id, updates);
    }

    console.log(`Goal created: ${goal.id}`);
    console.log(`  Project:    ${project}`);
    console.log(`  Title:      ${title}`);
    if (description) console.log(`  Description: ${description.slice(0, 100)}${description.length > 100 ? '...' : ''}`);
    if (flags.complexity) console.log(`  Complexity: ${flags.complexity}`);
    if (flags.archetype) console.log(`  Archetype:  ${flags.archetype}`);
    console.log(`  Status:     pending`);
    console.log(`\nThe supervisor will pick this up automatically.`);
  }

  else if (command === 'show') {
    const goalId = rawArgs[1];
    if (!goalId) {
      console.error('Usage: pnpm goal show <goal-id>');
      console.error('Tip: use "pnpm goal list" to find goal IDs');
      process.exit(1);
    }

    // Try exact match first, then prefix match
    let goal = getGoal(goalId);
    if (!goal) {
      const all = getAllGoals();
      const matches = all.filter(g => g.id.startsWith(goalId));
      if (matches.length === 1) goal = matches[0];
      else if (matches.length > 1) {
        console.error(`Ambiguous ID "${goalId}" — matches ${matches.length} goals:`);
        matches.forEach(g => console.error(`  ${g.id}  ${g.title.slice(0, 50)}`));
        process.exit(1);
      }
    }

    if (!goal) {
      console.error(`Goal not found: ${goalId}`);
      process.exit(1);
    }

    console.log(`Goal: ${goal.id}`);
    console.log(`  Title:       ${goal.title}`);
    console.log(`  Project:     ${goal.project}`);
    console.log(`  Status:      ${goal.status}`);
    console.log(`  Complexity:  ${goal.complexity || 'auto'}`);
    console.log(`  Archetype:   ${goal.archetype || 'auto'}`);
    console.log(`  Attempts:    ${goal.attemptCount || 0}`);
    console.log(`  Created:     ${goal.createdAt || 'n/a'}`);
    if (goal.completedAt) console.log(`  Completed:   ${goal.completedAt}`);
    if (goal.description) {
      console.log(`\n--- Description ---`);
      console.log(goal.description.slice(0, 2000));
    }
    if (goal.lastRejectionReason) {
      console.log(`\n--- Last Rejection ---`);
      console.log(goal.lastRejectionReason.slice(0, 500));
    }
    if (goal.output) {
      console.log(`\n--- Output ---`);
      console.log(goal.output.slice(0, 2000));
    }
    // Show debrief if available
    const debrief = goal.debrief;
    if (debrief && typeof debrief === 'object') {
      console.log(`\n--- Debrief ---`);
      const d = debrief as Record<string, unknown>;
      if (d.working) console.log(`  Working: ${d.working}`);
      if (d.broken) console.log(`  Broken:  ${d.broken}`);
      if (d.commits) console.log(`  Commits: ${d.commits}`);
      if (d.confidence) console.log(`  Confidence: ${d.confidence}`);
    }
  }

  else if (command === 'list') {
    const filterStatus = rawArgs[1] || 'all';
    const goals = getAllGoals();
    const filtered = filterStatus === 'all' ? goals : goals.filter(g => g.status === filterStatus);

    if (filtered.length === 0) {
      console.log(filterStatus === 'all' ? 'No goals found.' : `No ${filterStatus} goals.`);
      return;
    }

    // Group by status
    const byStatus: Record<string, typeof filtered> = {};
    for (const g of filtered) {
      (byStatus[g.status] ??= []).push(g);
    }

    for (const [status, goals] of Object.entries(byStatus)) {
      console.log(`\n${status.toUpperCase()} (${goals.length})`);
      for (const g of goals.slice(0, 10)) {
        console.log(`  ${g.id.slice(0, 12)}  [${g.project}] ${g.title.slice(0, 60)}`);
      }
      if (goals.length > 10) console.log(`  ... and ${goals.length - 10} more`);
    }
  }

  else if (command === 'status') {
    const goals = getAllGoals();
    const byStatus: Record<string, number> = {};
    goals.forEach(g => { byStatus[g.status] = (byStatus[g.status] || 0) + 1; });

    console.log('DreamTeam Status');
    console.log('-'.repeat(40));
    console.log(`  Pending:     ${byStatus['pending'] || 0}`);
    console.log(`  In Progress: ${byStatus['in-progress'] || 0}`);
    console.log(`  Completed:   ${byStatus['completed'] || 0}`);
    console.log(`  Blocked:     ${byStatus['blocked'] || 0}`);
    console.log(`  Failed:      ${byStatus['failed'] || 0}`);
    console.log(`  Total:       ${goals.length}`);
    console.log('-'.repeat(40));

    const projects = listProjectNames();
    console.log(`  Projects:    ${projects.join(', ')}`);
  }

  else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
