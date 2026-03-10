/**
 * Design & research commands: /design, /roadmap, /audit, /research, /redesign, /designResearch
 */

import type { Telegraf, Context } from 'telegraf';
import { listProjectNames } from '../projects/registry.js';
import { sendLongMessage } from './core.js';
import { addGoal, updateGoal } from '../orchestration/goal-crud.js';

export function registerDesignCommands(bot: Telegraf<Context>) {
  // Command: /design <project> - View project DESIGN.md
  bot.command('design', async (ctx) => {
    const projectName = ctx.message.text.replace('/design', '').trim();
    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /design <project>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      const { loadDesignDoc } = await import('../orchestration/archetypes.js');
      const doc = loadDesignDoc(projectName);
      if (doc) {
        await sendLongMessage(ctx, `DESIGN.md for ${projectName}:\n\n${doc}`);
      } else {
        await ctx.reply(`No DESIGN.md found for "${projectName}". Create one at the project root.`);
      }
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /roadmap - View project roadmap
  bot.command('roadmap', async (ctx) => {
    const projectName = ctx.message.text.replace('/roadmap', '').trim();
    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /roadmap <project>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      const { loadRoadmapDoc } = await import('../orchestration/roadmap.js');
      const doc = loadRoadmapDoc(projectName);
      if (doc) {
        await sendLongMessage(ctx, `ROADMAP.md for ${projectName}:\n\n${doc}`);
      } else {
        await ctx.reply(`No ROADMAP.md found for "${projectName}". Create one at the project root.`);
      }
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /audit <project>
  bot.command('audit', async (ctx) => {
    const projectName = ctx.message.text.replace('/audit', '').trim();

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /audit <project>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      await ctx.reply(`Running audit on ${projectName}...`);
      const { runAppAudit, formatAuditSummary } = await import('../director/app-audit.js');
      const audit = await runAppAudit(projectName);
      await sendLongMessage(ctx, formatAuditSummary(audit));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /research <project>
  bot.command('research', async (ctx) => {
    const projectName = ctx.message.text.replace('/research', '').trim();

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /research <project>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      await ctx.reply(`Researching UX patterns for ${projectName}... (this takes ~1-2 min)`);
      const { runProductResearch, formatResearchSummary } = await import('../director/product-research.js');
      const research = await runProductResearch(projectName);
      await sendLongMessage(ctx, formatResearchSummary(research));
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /redesign <project>
  bot.command('redesign', async (ctx) => {
    const projectName = ctx.message.text.replace('/redesign', '').trim();

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(`Usage: /redesign <project>\n\nProjects: ${projects.join(', ')}`);
      return;
    }

    try {
      await ctx.reply(`Starting redesign pipeline for ${projectName}... (audit \u2192 research \u2192 prototypes, ~2-3 min)`);
      const { runRedesignPipeline } = await import('../director/redesign.js');
      await runRedesignPipeline(projectName, async (msg) => { await ctx.reply(msg); });
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /designResearch <project> [phase] — Launch design research (Phase 1 or Phase 2)
  bot.command('designResearch', async (ctx) => {
    const args = ctx.message.text.replace('/designResearch', '').trim().split(/\s+/);
    const projectName = args[0];
    const phase = parseInt(args[1] || '1', 10);

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(
        `Usage: /designResearch <project> [1|2]\n\n` +
        `Phase 1: Competitor audit & UX research\n` +
        `Phase 2: STYLE.md + goal templates from Phase 1 findings\n\n` +
        `Projects: ${projects.join(', ')}`
      );
      return;
    }

    if (phase !== 1 && phase !== 2) {
      await ctx.reply('Phase must be 1 or 2.');
      return;
    }

    try {
      const projects = listProjectNames();
      if (!projects.includes(projectName)) {
        await ctx.reply(`Unknown project "${projectName}". Available: ${projects.join(', ')}`);
        return;
      }

      if (phase === 1) {
        const goal = addGoal(
          projectName,
          `Design Research Phase 1: Competitor Audit for ${projectName}`,
          `## Design Research — Phase 1: Competitive Audit

Research 5-8 competitor and best-in-class apps in the ${projectName} domain.

### Deliverables
1. **Competitor Matrix** — For each app: name, URL, standout UX patterns, navigation structure, design tokens (colors, fonts, spacing), strengths, weaknesses
2. **Top UX Patterns** — Identify the top 3-5 patterns worth adopting with clear rationale
3. **Screenshot References** — URLs or descriptions of key screens/flows
4. **Gap Analysis** — What our app is missing vs. the best competitors

### Output
Save research document to \`docs/design-research/phase1-competitor-audit.md\`
Create the \`docs/design-research/\` directory if it doesn't exist.

TEST_COMMANDS:
test -f docs/design-research/phase1-competitor-audit.md
grep -c "##" docs/design-research/phase1-competitor-audit.md | xargs test 3 -le`,
          'design-research'
        );
        await ctx.reply(
          `Design Research Phase 1 created!\n\n` +
          `Goal: ${goal.id}\n` +
          `Project: ${projectName}\n` +
          `Task: Competitor audit & UX pattern research\n\n` +
          `The goal will be picked up by the next supervisor dispatch cycle.`
        );
      } else {
        const goal = addGoal(
          projectName,
          `Design Research Phase 2: STYLE.md & Goal Templates for ${projectName}`,
          `## Design Research — Phase 2: Implementation Proposal

Read the Phase 1 research at \`docs/design-research/phase1-competitor-audit.md\` and synthesize findings into actionable artifacts.

### Deliverables
1. **STYLE.md** — Complete design system document at project root:
   - Color palette (primary, secondary, accent, semantic colors with hex/HSL values)
   - Typography scale (font families, sizes, weights, line heights)
   - Spacing scale (consistent spacing values)
   - Border radius, shadow tokens
   - Component patterns (buttons, cards, forms, badges, tables)
   - Dark mode considerations

2. **Goal Templates** — Save to \`docs/design-research/goal-templates.md\`:
   - 8-12 prioritized implementation goals
   - Each with: title, full description, archetype (frontend), TEST_COMMANDS
   - Ordered by impact (highest first)
   - Goals should reference STYLE.md tokens

### Output
- Save STYLE.md to project root
- Save goal templates to \`docs/design-research/goal-templates.md\`

TEST_COMMANDS:
test -f STYLE.md
test -f docs/design-research/goal-templates.md
grep -c "TEST_COMMANDS" docs/design-research/goal-templates.md | xargs test 1 -le`,
          'design-research'
        );
        await ctx.reply(
          `Design Research Phase 2 created!\n\n` +
          `Goal: ${goal.id}\n` +
          `Project: ${projectName}\n` +
          `Task: STYLE.md + implementation goal templates\n\n` +
          `Make sure Phase 1 research exists at docs/design-research/phase1-competitor-audit.md first.\n` +
          `The goal will be picked up by the next supervisor dispatch cycle.`
        );
      }
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });

  // Command: /uxresearch <project> — Full UX research pipeline (Phase 1 → Phase 2 with dependencies)
  bot.command('uxresearch', async (ctx) => {
    const projectName = ctx.message.text.replace('/uxresearch', '').trim();

    if (!projectName) {
      const projects = listProjectNames();
      await ctx.reply(
        `Usage: /uxresearch <project>\n\n` +
        `Launches a 2-phase UX research pipeline:\n` +
        `Phase 1: Competitor audit & UX pattern research\n` +
        `Phase 2: STYLE.md + goal templates (depends on Phase 1)\n\n` +
        `Projects: ${projects.join(', ')}`
      );
      return;
    }

    try {
      const projects = listProjectNames();
      if (!projects.includes(projectName)) {
        await ctx.reply(`Unknown project "${projectName}". Available: ${projects.join(', ')}`);
        return;
      }

      // Phase 1: Competitor audit
      const phase1 = addGoal(
        projectName,
        `Design Research Phase 1: Competitor Audit for ${projectName}`,
        `## Design Research — Phase 1: Competitive Audit

Research 5-8 competitor and best-in-class apps in the ${projectName} domain.

### Deliverables
1. **Competitor Matrix** — For each app: name, URL, standout UX patterns, navigation structure, design tokens (colors, fonts, spacing), strengths, weaknesses
2. **Top UX Patterns** — Identify the top 3-5 patterns worth adopting with clear rationale
3. **Screenshot References** — URLs or descriptions of key screens/flows
4. **Gap Analysis** — What our app is missing vs. the best competitors

### Output
Save research document to \`docs/design-research/phase1-competitor-audit.md\`
Create the \`docs/design-research/\` directory if it doesn't exist.

TEST_COMMANDS:
- test -f docs/design-research/phase1-competitor-audit.md
- grep -c "##" docs/design-research/phase1-competitor-audit.md | xargs test 3 -le`,
        'design-research'
      );

      // Phase 2: STYLE.md + goal templates (depends on Phase 1)
      const phase2 = addGoal(
        projectName,
        `Design Research Phase 2: STYLE.md & Goal Templates for ${projectName}`,
        `## Design Research — Phase 2: Implementation Proposal

Read the Phase 1 research at \`docs/design-research/phase1-competitor-audit.md\` and synthesize findings into actionable artifacts.

### Deliverables
1. **STYLE.md** — Complete design system document at project root:
   - Color palette (primary, secondary, accent, semantic colors with hex/HSL values)
   - Typography scale (font families, sizes, weights, line heights)
   - Spacing scale (consistent spacing values)
   - Border radius, shadow tokens
   - Component patterns (buttons, cards, forms, badges, tables)
   - Dark mode considerations

2. **Goal Templates** — Save to \`docs/design-research/goal-templates.md\`:
   - 8-12 prioritized implementation goals
   - Each with: title, full description, archetype (frontend), TEST_COMMANDS
   - Ordered by impact (highest first)
   - Goals should reference STYLE.md tokens

### Output
- Save STYLE.md to project root
- Save goal templates to \`docs/design-research/goal-templates.md\`

TEST_COMMANDS:
- test -f STYLE.md
- test -f docs/design-research/goal-templates.md
- grep -c "TEST_COMMANDS" docs/design-research/goal-templates.md | xargs test 1 -le`,
        'design-research'
      );

      // Set Phase 2 dependency on Phase 1
      updateGoal(phase2.id, { dependsOn: [phase1.id] });

      await ctx.reply(
        `UX Research Pipeline created for ${projectName}!\n\n` +
        `Phase 1: ${phase1.id}\n` +
        `  Competitor audit & UX pattern research\n\n` +
        `Phase 2: ${phase2.id}\n` +
        `  STYLE.md + implementation goal templates\n` +
        `  (depends on Phase 1)\n\n` +
        `Both goals will be picked up by the supervisor.\n` +
        `Phase 2 won't start until Phase 1 completes.`
      );
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  });
}
