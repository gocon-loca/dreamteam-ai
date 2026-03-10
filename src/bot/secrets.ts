/**
 * Secrets management using SOPS + age encryption
 * Loads encrypted secrets at runtime
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get project root (handles both src and dist directories)
function getProjectRoot(): string {
  // __dirname is either src/bot or dist/bot
  // Go up two levels to get project root
  return resolve(__dirname, '../..');
}

interface TestAccount {
  email: string;
  password: string;
}

interface ProjectTestConfig {
  baseUrl: string;
  accounts: Record<string, TestAccount>;
}

interface LinearConfig {
  apiKey: string;
  teamId: string;
  projectId?: string;
}

interface OpenAIConfig {
  apiKey: string;
}

export interface Secrets {
  telegram: {
    botToken: string;
    allowedUsers: string[];
  };
  testAccounts: Record<string, ProjectTestConfig>;
  // Optional Linear integration
  linear?: LinearConfig;
  // OpenAI for voice transcription
  openai?: OpenAIConfig;
}

let cachedSecrets: Secrets | null = null;

export async function getSecrets(): Promise<Secrets> {
  if (cachedSecrets) {
    return cachedSecrets;
  }

  const projectRoot = getProjectRoot();
  const configDir = join(projectRoot, 'config');
  const encryptedPath = join(configDir, 'secrets.enc.yaml');
  const plainPath = join(configDir, 'secrets.yaml');
  const ageKeyPath = join(configDir, 'age-key.txt');

  // Try encrypted file first (production)
  if (existsSync(encryptedPath)) {
    try {
      console.log(`Decrypting secrets from ${encryptedPath} with key ${ageKeyPath}`);
      const decrypted = execSync(`sops --decrypt "${encryptedPath}"`, {
        encoding: 'utf-8',
        env: {
          ...process.env,
          SOPS_AGE_KEY_FILE: ageKeyPath,
        },
      });
      cachedSecrets = parseYaml(decrypted) as Secrets;
      return cachedSecrets;
    } catch (error) {
      console.error('Failed to decrypt secrets:', error);
      throw new Error('Could not decrypt secrets.enc.yaml');
    }
  }

  // Fall back to plain file (development only - should not exist in prod)
  if (existsSync(plainPath)) {
    console.warn('WARNING: Using unencrypted secrets.yaml - encrypt before production!');
    const content = readFileSync(plainPath, 'utf-8');
    cachedSecrets = parseYaml(content) as Secrets;
    return cachedSecrets;
  }

  // Fall back to environment variables (setup wizard writes these to .env)
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envUsers = process.env.TELEGRAM_ALLOWED_USERS;
  if (envToken) {
    console.log('Using secrets from environment variables (.env)');
    cachedSecrets = {
      telegram: {
        botToken: envToken,
        allowedUsers: envUsers ? envUsers.split(',').map(s => s.trim()) : [],
      },
      testAccounts: {},
      linear: process.env.LINEAR_API_KEY ? { apiKey: process.env.LINEAR_API_KEY, teamId: process.env.LINEAR_TEAM_ID || '' } : undefined,
      openai: process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : undefined,
    };
    return cachedSecrets;
  }

  throw new Error('No secrets found. Run "pnpm run setup:web" to configure, or create config/secrets.yaml, or set TELEGRAM_BOT_TOKEN in .env');
}

export async function getTestAccount(
  projectName: string,
  role: string = 'user1'
): Promise<TestAccount & { baseUrl: string }> {
  const secrets = await getSecrets();
  const projectConfig = secrets.testAccounts[projectName];

  if (!projectConfig) {
    throw new Error(`No test accounts configured for project: ${projectName}`);
  }

  const account = projectConfig.accounts[role];
  if (!account) {
    throw new Error(`No test account '${role}' for project: ${projectName}`);
  }

  return {
    ...account,
    baseUrl: projectConfig.baseUrl,
  };
}

export function clearSecretsCache(): void {
  cachedSecrets = null;
}
