#!/usr/bin/env tsx
/**
 * DreamTeam Interactive Setup Wizard (CLI)
 *
 * Guides users through initial configuration:
 * 1. Prerequisites check (node, git, pnpm, CLI)
 * 2. AI provider & model hierarchy
 * 3. Telegram bot setup
 * 4. Project configuration
 * 5. Optional integrations
 * 6. Write config files
 *
 * Run: pnpm setup
 * Or with web UI: pnpm run setup:web
 */

import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const PROJECT_ROOT = join(import.meta.dirname, '..');

// ── Styling ────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';

const CHECK = `${GREEN}[ok]${RESET}`;
const CROSS = `${RED}[!!]${RESET}`;
const WARN = `${YELLOW}[??]${RESET}`;
const ARROW = `${CYAN}>>>${RESET}`;

function header(text: string): void {
  console.log();
  console.log(`${BOLD}${BLUE}--- ${text} ---${RESET}`);
  console.log();
}

function success(text: string): void {
  console.log(`  ${CHECK} ${text}`);
}

function fail(text: string): void {
  console.log(`  ${CROSS} ${text}`);
}

function warn(text: string): void {
  console.log(`  ${WARN} ${text}`);
}

function info(text: string): void {
  console.log(`  ${DIM}${text}${RESET}`);
}

// ── Readline helpers ───────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(prompt: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` ${DIM}[${defaultValue}]${RESET}` : '';
  return new Promise((resolve) => {
    rl.question(`  ${ARROW} ${prompt}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function confirm(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`  ${ARROW} ${prompt} (${hint}): `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

function choose(prompt: string, options: string[], defaultIndex = 0): Promise<string> {
  console.log(`  ${ARROW} ${prompt}`);
  options.forEach((opt, i) => {
    const marker = i === defaultIndex ? `${GREEN}*${RESET}` : ' ';
    console.log(`    ${marker} ${i + 1}) ${opt}`);
  });
  return new Promise((resolve) => {
    rl.question(`  ${DIM}Enter number [${defaultIndex + 1}]:${RESET} `, (answer) => {
      const idx = parseInt(answer.trim()) - 1;
      if (idx >= 0 && idx < options.length) resolve(options[idx]);
      else resolve(options[defaultIndex]);
    });
  });
}

// ── Config state ───────────────────────────────────────────

interface SetupConfig {
  cliCommand: string;
  primary: string;
  secondary: string;
  ancillary: string;
  costPrimary: number;
  costSecondary: number;
  costAncillary: number;
  telegramToken: string;
  telegramChatId: string;
  projects: Array<{
    name: string;
    path: string;
    hasDevServer: boolean;
    devCommand: string;
    devPort: number;
  }>;
  jamApiKey: string;
  linearApiKey: string;
}

const config: SetupConfig = {
  cliCommand: 'claude',
  primary: 'opus',
  secondary: 'sonnet',
  ancillary: 'haiku',
  costPrimary: 0.79,
  costSecondary: 0.25,
  costAncillary: 0.05,
  telegramToken: '',
  telegramChatId: '',
  projects: [],
  jamApiKey: '',
  linearApiKey: '',
};

// ── Step 1: Prerequisites ──────────────────────────────────

async function checkPrerequisites(): Promise<boolean> {
  header('Step 1/6: Prerequisites');
  let allGood = true;

  // Node
  try {
    const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
    const major = parseInt(nodeVersion.replace('v', ''));
    if (major >= 20) {
      success(`Node.js ${nodeVersion}`);
    } else {
      fail(`Node.js ${nodeVersion} (need v20+)`);
      info('Install: https://nodejs.org or use nvm');
      allGood = false;
    }
  } catch {
    fail('Node.js not found');
    info('Install: https://nodejs.org');
    allGood = false;
  }

  // Git
  try {
    const gitVersion = execSync('git --version', { encoding: 'utf8' }).trim();
    success(gitVersion);
  } catch {
    fail('git not found');
    info('Install: https://git-scm.com');
    allGood = false;
  }

  // pnpm
  try {
    const pnpmVersion = execSync('pnpm --version', { encoding: 'utf8' }).trim();
    success(`pnpm ${pnpmVersion}`);
  } catch {
    fail('pnpm not found');
    info('Install: npm install -g pnpm');
    allGood = false;
  }

  // Claude CLI (or whatever CLI they'll use)
  try {
    const claudeVersion = execSync('claude --version 2>/dev/null || echo "not found"', { encoding: 'utf8' }).trim();
    if (claudeVersion !== 'not found') {
      success(`Claude CLI: ${claudeVersion}`);
    } else {
      warn('Claude CLI not found (can configure a different CLI later)');
    }
  } catch {
    warn('Claude CLI not found (can configure a different CLI later)');
  }

  if (!allGood) {
    console.log();
    fail('Some prerequisites are missing. Install them and re-run setup.');
  }

  return allGood;
}

// ── Step 2: AI Provider & Models ───────────────────────────

async function configureModels(): Promise<void> {
  header('Step 2/6: AI Provider & Model Hierarchy');

  console.log(`  DreamTeam uses a 3-tier model hierarchy:`);
  console.log(`    ${BOLD}Primary${RESET}   - Most capable. Complex goals, auth work, final escalation.`);
  console.log(`    ${BOLD}Secondary${RESET} - Balanced. Retries, code review, AI triage.`);
  console.log(`    ${BOLD}Ancillary${RESET} - Cheapest/fastest. Routine goals, first attempts.`);
  console.log();

  const provider = await choose('Choose your AI provider:', [
    'Claude (recommended)',
    'OpenAI',
    'Custom',
  ], 0);

  if (provider.startsWith('Claude')) {
    config.cliCommand = 'claude';
    config.primary = 'opus';
    config.secondary = 'sonnet';
    config.ancillary = 'haiku';
    config.costPrimary = 0.79;
    config.costSecondary = 0.25;
    config.costAncillary = 0.05;
    success('Claude preset loaded');
  } else if (provider.startsWith('OpenAI')) {
    config.cliCommand = await ask('CLI command for OpenAI', 'claude');
    config.primary = 'o1';
    config.secondary = 'gpt-4o';
    config.ancillary = 'gpt-4o-mini';
    config.costPrimary = 1.00;
    config.costSecondary = 0.30;
    config.costAncillary = 0.05;
    success('OpenAI preset loaded');
    info('Note: CLI must support --model and --print flags');
  } else {
    config.cliCommand = await ask('CLI command', 'claude');
    config.primary = await ask('Primary model name (most capable)');
    config.secondary = await ask('Secondary model name (balanced)');
    config.ancillary = await ask('Ancillary model name (cheapest)');
    config.costPrimary = parseFloat(await ask('Est. cost per invocation - primary ($)', '0.79'));
    config.costSecondary = parseFloat(await ask('Est. cost per invocation - secondary ($)', '0.25'));
    config.costAncillary = parseFloat(await ask('Est. cost per invocation - ancillary ($)', '0.05'));
  }

  // Allow customization even for presets
  if (!provider.startsWith('Custom')) {
    const customize = await confirm('Customize model names or costs?', false);
    if (customize) {
      config.primary = await ask('Primary model', config.primary);
      config.secondary = await ask('Secondary model', config.secondary);
      config.ancillary = await ask('Ancillary model', config.ancillary);
    }
  }

  console.log();
  console.log(`  ${BOLD}Escalation Ladders:${RESET}`);
  console.log(`    Routine goals: ${config.ancillary} -> ${config.secondary} -> ${config.primary}`);
  console.log(`    Complex goals: ${config.primary} -> ${config.primary} -> ${config.primary}`);
  console.log(`    Auth goals:    ${config.primary} -> ${config.primary} -> ${config.primary}`);
  console.log();
  console.log(`  ${BOLD}Estimated costs:${RESET}`);
  console.log(`    Routine goal (1 attempt):  ~$${config.costAncillary.toFixed(2)}`);
  console.log(`    Complex goal (1 attempt):  ~$${config.costPrimary.toFixed(2)}`);
  console.log(`    50 goals/day estimate:     ~$${(30 * config.costAncillary + 15 * config.costSecondary + 5 * config.costPrimary).toFixed(2)}`);

  // Test the CLI
  const testCli = await confirm(`Test ${config.cliCommand} CLI now?`, true);
  if (testCli) {
    console.log(`  Testing ${config.cliCommand} --print --model ${config.ancillary} ...`);
    try {
      const output = execSync(
        `${config.cliCommand} --print --model ${config.ancillary} -p "Say hello in exactly 5 words"`,
        { encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      success(`CLI responded: "${output.slice(0, 80)}"`);
    } catch (err: any) {
      fail(`CLI test failed: ${err.message?.slice(0, 100)}`);
      info(`Make sure "${config.cliCommand}" is installed and authenticated.`);
      const cont = await confirm('Continue anyway?', true);
      if (!cont) {
        console.log('  Setup paused. Fix CLI auth and re-run: pnpm setup');
        process.exit(1);
      }
    }
  }
}

// ── Step 3: Telegram Bot ───────────────────────────────────

async function configureTelegram(): Promise<void> {
  header('Step 3/6: Telegram Bot');

  console.log(`  DreamTeam sends notifications and receives commands via Telegram.`);
  console.log();
  console.log(`  To create a bot:`);
  console.log(`    1. Open Telegram and message ${BOLD}@BotFather${RESET}`);
  console.log(`    2. Send ${BOLD}/newbot${RESET} and follow the prompts`);
  console.log(`    3. Copy the bot token (looks like 123456789:ABC...)${RESET}`);
  console.log();

  const hasTelegram = await confirm('Set up Telegram now?', true);
  if (!hasTelegram) {
    warn('Skipping Telegram. You can add it later in .env');
    return;
  }

  config.telegramToken = await ask('Bot token');

  if (config.telegramToken) {
    // Test the token
    console.log('  Testing Telegram connection...');
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`);
      const data = await res.json() as any;
      if (data.ok) {
        success(`Connected to bot: @${data.result.username} (${data.result.first_name})`);
      } else {
        fail(`Invalid token: ${data.description}`);
        config.telegramToken = '';
      }
    } catch (err: any) {
      fail(`Connection failed: ${err.message}`);
      config.telegramToken = '';
    }
  }

  if (config.telegramToken) {
    console.log();
    console.log(`  To get your chat ID:`);
    console.log(`    1. Send any message to your bot in Telegram`);
    console.log(`    2. Visit: https://api.telegram.org/bot${config.telegramToken.slice(0, 10)}..../getUpdates`);
    console.log(`    3. Look for "chat":{"id":XXXXXXX}`);
    console.log();
    config.telegramChatId = await ask('Your Telegram chat ID (or press Enter to skip)');
  }
}

// ── Step 4: Projects ───────────────────────────────────────

async function configureProjects(): Promise<void> {
  header('Step 4/6: Projects');

  console.log(`  Add the projects DreamTeam will manage.`);
  console.log(`  Each project needs a name and filesystem path.`);
  console.log();

  let addMore = true;
  while (addMore) {
    const name = await ask('Project name (e.g., "myapp")');
    if (!name) break;

    let path = await ask('Project path', `~/Projects/${name}`);
    path = path.replace(/^~/, homedir());
    path = resolve(path);

    // Auto-detect project settings
    let hasDevServer = false;
    let devCommand = '';
    let devPort = 3000;

    if (existsSync(join(path, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf-8'));
        info(`Detected: ${pkg.name || name} (Node.js)`);

        // Detect dev command
        if (pkg.scripts?.dev) {
          devCommand = 'npm run dev';
          hasDevServer = true;

          // Detect framework and default port
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps['next']) { devPort = 3000; info('Framework: Next.js'); }
          else if (deps['vite'] || deps['@vitejs/plugin-react']) { devPort = 5173; info('Framework: Vite'); }
          else if (deps['gatsby']) { devPort = 8000; info('Framework: Gatsby'); }
          else if (deps['astro']) { devPort = 4321; info('Framework: Astro'); }
        }
      } catch { /* ignore */ }
    } else if (existsSync(join(path, 'pyproject.toml'))) {
      info('Detected: Python project');
      hasDevServer = await confirm('Does this project have a dev server?', false);
      if (hasDevServer) {
        devCommand = await ask('Dev server command', 'python manage.py runserver');
        devPort = parseInt(await ask('Dev server port', '8000'));
      }
    } else if (existsSync(join(path, 'manage.py'))) {
      info('Detected: Django project');
      hasDevServer = true;
      devCommand = 'python manage.py runserver';
      devPort = 8000;
    } else if (!existsSync(path)) {
      warn(`Path does not exist: ${path}`);
      const cont = await confirm('Add anyway?', false);
      if (!cont) continue;
    }

    if (hasDevServer) {
      const useDetected = await confirm(`Dev server: "${devCommand}" on port ${devPort}?`, true);
      if (!useDetected) {
        devCommand = await ask('Dev command', devCommand);
        devPort = parseInt(await ask('Dev port', String(devPort)));
      }
    } else {
      hasDevServer = await confirm('Does this project have a dev server?', false);
      if (hasDevServer) {
        devCommand = await ask('Dev command');
        devPort = parseInt(await ask('Dev port', '3000'));
      }
    }

    config.projects.push({ name, path, hasDevServer, devCommand, devPort });
    success(`Added: ${name} (${path})`);

    console.log();
    addMore = await confirm('Add another project?', false);
  }

  if (config.projects.length === 0) {
    warn('No projects added. You can configure them later in config/projects.yaml');
  }
}

// ── Step 5: Optional Integrations ──────────────────────────

async function configureIntegrations(): Promise<void> {
  header('Step 5/6: Optional Integrations');

  // Jam.dev
  console.log(`  ${BOLD}Jam.dev${RESET} — Bug reports from browser extension, analyzed by AI agents`);
  const useJam = await confirm('Configure Jam.dev integration?', false);
  if (useJam) {
    config.jamApiKey = await ask('Jam.dev API key');
    if (config.jamApiKey) success('Jam.dev configured');
  }

  console.log();

  // Linear
  console.log(`  ${BOLD}Linear${RESET} — Kanban board sync for goal tracking`);
  const useLinear = await confirm('Configure Linear integration?', false);
  if (useLinear) {
    config.linearApiKey = await ask('Linear API key');
    if (config.linearApiKey) success('Linear configured');
  }
}

// ── Step 6: Write Config ───────────────────────────────────

async function writeConfig(): Promise<void> {
  header('Step 6/6: Review & Save');

  // Generate models.yaml
  const modelsYaml = `# Model Configuration
# DreamTeam uses a 3-tier model hierarchy.

# Model names (passed as --model flag to the CLI)
primary: ${config.primary}
secondary: ${config.secondary}
ancillary: ${config.ancillary}

# CLI backend command
cliCommand: ${config.cliCommand}

# Escalation ladders
routineLadder:
  - ancillary
  - secondary
  - primary

complexLadder:
  - primary
  - primary
  - primary

authLadder:
  - primary
  - primary
  - primary

# Approximate cost per invocation by tier (USD)
estimatedCost:
  primary: ${config.costPrimary}
  secondary: ${config.costSecondary}
  ancillary: ${config.costAncillary}
`;

  // Generate projects.yaml
  let projectsYaml = `# Project Registry\n# Each project DreamTeam manages.\n\nprojects:\n`;
  for (const p of config.projects) {
    projectsYaml += `  ${p.name}:\n`;
    projectsYaml += `    path: "${p.path}"\n`;
    projectsYaml += `    hasDevServer: ${p.hasDevServer}\n`;
    if (p.hasDevServer) {
      projectsYaml += `    devCommand: "${p.devCommand}"\n`;
      projectsYaml += `    devPort: ${p.devPort}\n`;
      projectsYaml += `    healthCheck: "http://localhost:${p.devPort}"\n`;
    }
    projectsYaml += '\n';
  }

  // Generate .env
  let envContent = `# DreamTeam Environment Configuration\n`;
  envContent += `# Generated by setup wizard\n\n`;
  if (config.telegramToken) {
    envContent += `TELEGRAM_BOT_TOKEN=${config.telegramToken}\n`;
  }
  if (config.telegramChatId) {
    envContent += `TELEGRAM_CHAT_ID=${config.telegramChatId}\n`;
  }
  if (config.jamApiKey) {
    envContent += `JAM_API_KEY=${config.jamApiKey}\n`;
  }
  if (config.linearApiKey) {
    envContent += `LINEAR_API_KEY=${config.linearApiKey}\n`;
  }

  // Show preview
  console.log(`  ${BOLD}config/models.yaml:${RESET}`);
  console.log(DIM);
  modelsYaml.split('\n').forEach(line => console.log(`    ${line}`));
  console.log(RESET);

  if (config.projects.length > 0) {
    console.log(`  ${BOLD}config/projects.yaml:${RESET}`);
    console.log(DIM);
    projectsYaml.split('\n').slice(0, 20).forEach(line => console.log(`    ${line}`));
    console.log(RESET);
  }

  const save = await confirm('Save configuration?', true);
  if (!save) {
    warn('Configuration not saved. Re-run: pnpm setup');
    return;
  }

  // Ensure directories exist
  const configDir = join(PROJECT_ROOT, 'config');
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  // Write files
  writeFileSync(join(configDir, 'models.yaml'), modelsYaml);
  success('Wrote config/models.yaml');

  if (config.projects.length > 0) {
    writeFileSync(join(configDir, 'projects.yaml'), projectsYaml);
    success('Wrote config/projects.yaml');
  }

  // Write .env (don't overwrite existing — merge)
  const envPath = join(PROJECT_ROOT, '.env');
  if (existsSync(envPath)) {
    const existing = readFileSync(envPath, 'utf-8');
    // Append new vars that don't already exist
    const lines = envContent.split('\n').filter(line => {
      if (!line || line.startsWith('#')) return false;
      const key = line.split('=')[0];
      return !existing.includes(key + '=');
    });
    if (lines.length > 0) {
      writeFileSync(envPath, existing.trimEnd() + '\n\n' + lines.join('\n') + '\n');
      success(`Updated .env (added ${lines.length} new variable(s))`);
    } else {
      info('.env already has all variables');
    }
  } else {
    writeFileSync(envPath, envContent);
    success('Wrote .env');
  }

  console.log();
  console.log(`  ${BOLD}${GREEN}Setup complete!${RESET}`);
  console.log();
  console.log(`  Next steps:`);
  console.log(`    1. ${BOLD}pnpm build${RESET}        Build the project`);
  console.log(`    2. ${BOLD}pnpm start${RESET}        Start supervisor + workers`);
  console.log();
  console.log(`  Or start the bot only: ${BOLD}node dist/bot/index.js${RESET}`);
  console.log();

  if (!config.telegramToken) {
    info('Reminder: Add TELEGRAM_BOT_TOKEN to .env for Telegram commands.');
  }
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log();
  console.log(`${BOLD}${BLUE}  DreamTeam Setup${RESET}`);
  console.log(`${DIM}  Autonomous coding system configuration wizard${RESET}`);
  console.log();

  // Step 1
  const prereqsOk = await checkPrerequisites();
  if (!prereqsOk) {
    const cont = await confirm('Continue with missing prerequisites?', false);
    if (!cont) {
      rl.close();
      process.exit(1);
    }
  }

  // Step 2
  await configureModels();

  // Step 3
  await configureTelegram();

  // Step 4
  await configureProjects();

  // Step 5
  await configureIntegrations();

  // Step 6
  await writeConfig();

  rl.close();
}

main().catch((err) => {
  console.error('Setup error:', err);
  rl.close();
  process.exit(1);
});
