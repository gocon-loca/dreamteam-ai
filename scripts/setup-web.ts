/**
 * Setup Wizard — Web-based configuration UI for DreamTeam.
 *
 * Serves a single-page wizard at http://localhost:3456 that walks users
 * through prerequisite checks, model configuration, Telegram bot setup,
 * project registration, and optional integrations.
 *
 * Usage: pnpm run setup:web  (or: npx tsx scripts/setup-web.ts)
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { execSync, exec } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const CONFIG_DIR = join(PROJECT_ROOT, 'config');
const UI_DIR = join(__dirname, 'setup-ui');

const PORT = 3456;
const app = new Hono();

// ── Helpers ─────────────────────────────────────────────────

function commandExists(cmd: string): { exists: boolean; version: string } {
  try {
    const version = execSync(`${cmd} --version 2>&1`, {
      timeout: 10_000,
      encoding: 'utf-8',
    }).trim();
    return { exists: true, version };
  } catch {
    return { exists: false, version: '' };
  }
}

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p.replace('~', process.env.HOME || '');
  }
  return p;
}

// ── Routes ──────────────────────────────────────────────────

// Serve the wizard UI
app.get('/', (c) => {
  const htmlPath = join(UI_DIR, 'index.html');
  if (!existsSync(htmlPath)) {
    return c.text('Setup UI not found. Expected at: ' + htmlPath, 500);
  }
  const html = readFileSync(htmlPath, 'utf-8');
  return c.html(html);
});

// Check prerequisites
app.get('/api/prerequisites', async (c) => {
  const checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
    help?: string;
  }> = [];

  // Node version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  checks.push({
    name: 'Node.js >= 22',
    passed: nodeMajor >= 22,
    detail: `Found ${nodeVersion}`,
    help: nodeMajor < 22 ? 'Install Node 22+: https://nodejs.org' : undefined,
  });

  // Git
  const git = commandExists('git');
  checks.push({
    name: 'Git',
    passed: git.exists,
    detail: git.exists ? git.version.split('\n')[0] : 'Not found',
    help: git.exists ? undefined : 'Install Git: https://git-scm.com',
  });

  // pnpm
  const pnpm = commandExists('pnpm');
  checks.push({
    name: 'pnpm',
    passed: pnpm.exists,
    detail: pnpm.exists ? `pnpm ${pnpm.version}` : 'Not found',
    help: pnpm.exists ? undefined : 'Install pnpm: npm install -g pnpm',
  });

  // Claude CLI
  const claude = commandExists('claude');
  checks.push({
    name: 'Claude CLI',
    passed: claude.exists,
    detail: claude.exists ? claude.version.split('\n')[0] : 'Not found',
    help: claude.exists
      ? undefined
      : 'Install Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code',
  });

  // PM2 (optional but recommended)
  const pm2 = commandExists('pm2');
  checks.push({
    name: 'PM2 (optional)',
    passed: pm2.exists,
    detail: pm2.exists ? pm2.version.split('\n')[0] : 'Not found — optional process manager',
    help: pm2.exists ? undefined : 'Install PM2: npm install -g pm2',
  });

  return c.json({ checks });
});

// Run an install command (for missing prerequisites)
app.post('/api/run-install', async (c) => {
  const body = await c.req.json();
  const command: string = body.command || '';

  // Only allow known safe install commands
  const ALLOWED_PREFIXES = [
    'brew install',
    'npm install -g',
    'xcode-select --install',
    'curl',
  ];
  const isSafe = ALLOWED_PREFIXES.some(p => command.startsWith(p));
  if (!isSafe) {
    return c.json({ success: false, error: 'Command not allowed' }, 400);
  }

  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return c.json({ success: true, output: output.slice(0, 2000) });
  } catch (err: any) {
    return c.json({
      success: false,
      error: (err.stderr || err.message || '').slice(0, 1000),
    });
  }
});

// Test a CLI model
app.post('/api/test-cli', async (c) => {
  const body = await c.req.json();
  const command: string = body.command || 'claude';
  const model: string = body.model || '';

  const modelFlag = model ? `--model ${model}` : '';
  const fullCmd = `${command} --print ${modelFlag} -p "Say hello in exactly 5 words"`;

  try {
    const output = execSync(fullCmd, {
      timeout: 30_000,
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
    }).trim();

    return c.json({
      success: true,
      output: output.slice(0, 500),
      command: fullCmd,
    });
  } catch (e: any) {
    return c.json({
      success: false,
      error: e.message?.slice(0, 500) || 'Command failed',
      command: fullCmd,
    });
  }
});

// Test Telegram bot token
app.post('/api/test-telegram', async (c) => {
  const body = await c.req.json();
  const token: string = body.token || '';

  if (!token) {
    return c.json({ success: false, error: 'No token provided' });
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await resp.json();

    if (data.ok) {
      return c.json({
        success: true,
        bot: {
          id: data.result.id,
          name: data.result.first_name,
          username: data.result.username,
        },
      });
    } else {
      return c.json({
        success: false,
        error: data.description || 'Invalid token',
      });
    }
  } catch (e: any) {
    return c.json({
      success: false,
      error: e.message || 'Network error',
    });
  }
});

// Detect project framework from path
app.post('/api/detect-project', async (c) => {
  const body = await c.req.json();
  const rawPath: string = body.path || '';
  const projectPath = expandTilde(rawPath);

  if (!existsSync(projectPath)) {
    return c.json({
      success: false,
      error: `Path not found: ${projectPath}`,
    });
  }

  const stat = statSync(projectPath);
  if (!stat.isDirectory()) {
    return c.json({
      success: false,
      error: 'Path is not a directory',
    });
  }

  const result: {
    success: boolean;
    framework: string;
    hasDevServer: boolean;
    devCommand: string;
    suggestedPort: number;
    description: string;
  } = {
    success: true,
    framework: 'unknown',
    hasDevServer: false,
    devCommand: '',
    suggestedPort: 3000,
    description: '',
  };

  // Check package.json (Node.js project)
  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      result.description = pkg.description || '';

      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      const scripts = pkg.scripts || {};

      if (deps['next']) {
        result.framework = 'Next.js';
        result.hasDevServer = true;
        result.devCommand = scripts.dev || 'npm run dev';
        result.suggestedPort = 3000;
      } else if (deps['vite'] || deps['@vitejs/plugin-react']) {
        result.framework = 'Vite';
        result.hasDevServer = true;
        result.devCommand = scripts.dev || 'npm run dev';
        result.suggestedPort = 5173;
      } else if (deps['react-scripts']) {
        result.framework = 'Create React App';
        result.hasDevServer = true;
        result.devCommand = scripts.start || 'npm start';
        result.suggestedPort = 3000;
      } else if (deps['express'] || deps['hono'] || deps['fastify'] || deps['koa']) {
        const serverLib = deps['express']
          ? 'Express'
          : deps['hono']
            ? 'Hono'
            : deps['fastify']
              ? 'Fastify'
              : 'Koa';
        result.framework = serverLib;
        result.hasDevServer = true;
        result.devCommand = scripts.dev || scripts.start || 'npm start';
        result.suggestedPort = 3000;
      } else if (scripts.dev) {
        result.framework = 'Node.js';
        result.hasDevServer = true;
        result.devCommand = scripts.dev;
        result.suggestedPort = 3000;
      } else {
        result.framework = 'Node.js';
        result.hasDevServer = false;
      }

      return c.json(result);
    } catch {
      // Fall through to other checks
    }
  }

  // Check pyproject.toml (Python project)
  const pyprojectPath = join(projectPath, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    const content = readFileSync(pyprojectPath, 'utf-8');

    if (content.includes('fastapi') || content.includes('FastAPI')) {
      result.framework = 'FastAPI';
      result.hasDevServer = true;
      result.devCommand = 'uvicorn main:app --reload --port 8000';
      result.suggestedPort = 8000;
    } else if (content.includes('django') || content.includes('Django')) {
      result.framework = 'Django';
      result.hasDevServer = true;
      result.devCommand = 'python manage.py runserver 8000';
      result.suggestedPort = 8000;
    } else if (content.includes('flask') || content.includes('Flask')) {
      result.framework = 'Flask';
      result.hasDevServer = true;
      result.devCommand = 'flask run --port 8000';
      result.suggestedPort = 8000;
    } else {
      result.framework = 'Python';
      result.hasDevServer = false;
    }

    return c.json(result);
  }

  // Check manage.py (Django)
  if (existsSync(join(projectPath, 'manage.py'))) {
    result.framework = 'Django';
    result.hasDevServer = true;
    result.devCommand = 'python manage.py runserver 8000';
    result.suggestedPort = 8000;
    return c.json(result);
  }

  // Check requirements.txt (generic Python)
  if (existsSync(join(projectPath, 'requirements.txt'))) {
    const content = readFileSync(
      join(projectPath, 'requirements.txt'),
      'utf-8',
    );
    if (content.includes('fastapi')) {
      result.framework = 'FastAPI';
      result.hasDevServer = true;
      result.devCommand = 'uvicorn main:app --reload --port 8000';
      result.suggestedPort = 8000;
    } else if (content.includes('flask')) {
      result.framework = 'Flask';
      result.hasDevServer = true;
      result.devCommand = 'flask run --port 8000';
      result.suggestedPort = 8000;
    } else {
      result.framework = 'Python';
      result.hasDevServer = false;
    }
    return c.json(result);
  }

  return c.json(result);
});

// Save all configuration
app.post('/api/save-config', async (c) => {
  const body = await c.req.json();
  const errors: string[] = [];

  // ── models.yaml ─────────────────────────────────────────
  try {
    const models = body.models || {};
    const modelsYaml = `# Model Configuration
# Generated by DreamTeam Setup Wizard
#
# Tiers:
#   primary   — Most capable. Complex goals, auth work, final escalation.
#   secondary — Balanced. Retries, code review, AI triage.
#   ancillary — Cheapest/fastest. Routine goals, first attempts.

# Model names (passed as --model flag to the CLI)
primary: ${models.primary || 'opus'}
secondary: ${models.secondary || 'sonnet'}
ancillary: ${models.ancillary || 'haiku'}

# CLI backend command
cliCommand: ${models.cliCommand || 'claude'}

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
  primary: ${models.costPrimary ?? 0.79}
  secondary: ${models.costSecondary ?? 0.25}
  ancillary: ${models.costAncillary ?? 0.05}
`;
    writeFileSync(join(CONFIG_DIR, 'models.yaml'), modelsYaml, 'utf-8');
  } catch (e: any) {
    errors.push(`models.yaml: ${e.message}`);
  }

  // ── projects.yaml ───────────────────────────────────────
  try {
    const projects: Array<{
      name: string;
      path: string;
      description: string;
      hasDevServer: boolean;
      devCommand: string;
      devPort: number;
    }> = body.projects || [];

    let projectsYaml = `# DreamTeam Project Registry
# Generated by DreamTeam Setup Wizard

projects:
  # DreamTeam itself (always present)
  dreamteam:
    path: ${PROJECT_ROOT}
    description: "Multi-project orchestration system"
    hasDevServer: false
`;

    for (const proj of projects) {
      if (!proj.name || proj.name === 'dreamteam') continue;

      const safePath = proj.path.includes(' ')
        ? `"${proj.path}"`
        : proj.path;
      const safeDesc = proj.description
        ? `"${proj.description.replace(/"/g, '\\"')}"`
        : `"${proj.name} project"`;

      projectsYaml += `
  ${proj.name}:
    path: ${safePath}
    description: ${safeDesc}
    hasDevServer: ${proj.hasDevServer}`;

      if (proj.hasDevServer) {
        const safeCmd = proj.devCommand
          ? `"${proj.devCommand.replace(/"/g, '\\"')}"`
          : '"npm run dev"';
        projectsYaml += `
    devCommand: ${safeCmd}
    devPort: ${proj.devPort || 3000}
    healthCheck: "http://localhost:${proj.devPort || 3000}"`;
      }

      projectsYaml += '\n';
    }

    const tailscaleIp = body.tailscaleIp || 'localhost';
    projectsYaml += `
# Tailscale/LAN IP for remote access
tailscaleIp: "${tailscaleIp}"
`;

    writeFileSync(join(CONFIG_DIR, 'projects.yaml'), projectsYaml, 'utf-8');
  } catch (e: any) {
    errors.push(`projects.yaml: ${e.message}`);
  }

  // ── .env ────────────────────────────────────────────────
  try {
    const telegram = body.telegram || {};
    const integrations = body.integrations || {};

    let envContent = `# DreamTeam Environment Variables
# Generated by DreamTeam Setup Wizard

# SOPS Age Key
SOPS_AGE_KEY_FILE=./config/age-key.txt

# Node environment
NODE_ENV=development

# Tailscale IP
TAILSCALE_IP=${body.tailscaleIp || 'localhost'}
`;

    if (telegram.token) {
      envContent += `
# Telegram Bot
TELEGRAM_BOT_TOKEN=${telegram.token}
TELEGRAM_ALLOWED_USERS=${telegram.chatId || ''}
`;
    }

    if (integrations.jamApiKey) {
      envContent += `
# Jam.dev
JAM_API_KEY=${integrations.jamApiKey}
`;
    }

    if (integrations.linearApiKey) {
      envContent += `
# Linear
LINEAR_API_KEY=${integrations.linearApiKey}
`;
    }

    writeFileSync(join(PROJECT_ROOT, '.env'), envContent, 'utf-8');
  } catch (e: any) {
    errors.push(`.env: ${e.message}`);
  }

  if (errors.length > 0) {
    return c.json({
      success: false,
      errors,
    });
  }

  return c.json({
    success: true,
    message: 'Configuration saved successfully.',
    files: ['config/models.yaml', 'config/projects.yaml', '.env'],
  });
});

// Run preflight check
app.post('/api/preflight', async (c) => {
  try {
    const checks: Array<{
      name: string;
      passed: boolean;
      detail: string;
    }> = [];

    // Node
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    checks.push({
      name: 'Node.js',
      passed: nodeMajor >= 22,
      detail: nodeVersion,
    });

    // Claude CLI
    const claude = commandExists('claude');
    checks.push({
      name: 'Claude CLI',
      passed: claude.exists,
      detail: claude.exists ? claude.version.split('\n')[0] : 'Not found',
    });

    // Config files exist
    checks.push({
      name: 'config/models.yaml',
      passed: existsSync(join(CONFIG_DIR, 'models.yaml')),
      detail: existsSync(join(CONFIG_DIR, 'models.yaml'))
        ? 'Present'
        : 'Missing',
    });
    checks.push({
      name: 'config/projects.yaml',
      passed: existsSync(join(CONFIG_DIR, 'projects.yaml')),
      detail: existsSync(join(CONFIG_DIR, 'projects.yaml'))
        ? 'Present'
        : 'Missing',
    });
    checks.push({
      name: '.env',
      passed: existsSync(join(PROJECT_ROOT, '.env')),
      detail: existsSync(join(PROJECT_ROOT, '.env'))
        ? 'Present'
        : 'Missing',
    });

    // Dependencies installed
    checks.push({
      name: 'node_modules',
      passed: existsSync(join(PROJECT_ROOT, 'node_modules')),
      detail: existsSync(join(PROJECT_ROOT, 'node_modules'))
        ? 'Installed'
        : 'Run: pnpm install',
    });

    // Built
    checks.push({
      name: 'dist/ (compiled)',
      passed: existsSync(join(PROJECT_ROOT, 'dist')),
      detail: existsSync(join(PROJECT_ROOT, 'dist'))
        ? 'Present'
        : 'Run: pnpm build',
    });

    const allPassed = checks.every((ch) => ch.passed);
    return c.json({ success: true, ready: allPassed, checks });
  } catch (e: any) {
    return c.json({
      success: false,
      error: e.message,
    });
  }
});

// ── Start Server ────────────────────────────────────────────

console.log(`
 ____                        _____
|  _ \\  _ __  ___  __ _ _ __|_   _|__  __ _ _ __ ___
| | | || '__|/ _ \\/ _\` | '_ \\ | |/ _ \\/ _\` | '_ \` _ \\
| |_| || |  |  __/ (_| | | | || |  __/ (_| | | | | | |
|____/ |_|   \\___|\\__,_|_| |_||_|\\___|\\__,_|_| |_| |_|

  Setup Wizard - http://localhost:${PORT}
`);

const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  () => {
    console.log(`Setup wizard running at http://localhost:${PORT}`);
    console.log('Press Ctrl+C to stop.\n');

    // Auto-open browser on macOS
    exec(`open http://localhost:${PORT}`, (err) => {
      if (err) {
        console.log(
          'Could not auto-open browser. Please navigate to the URL above.',
        );
      }
    });
  },
);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down setup wizard...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});
