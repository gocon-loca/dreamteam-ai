/**
 * Test Credentials Manager - Secure access to test accounts
 */

import { getSecrets, getTestAccount } from '../bot/secrets.js';

export interface LoginCredentials {
  email: string;
  password: string;
  baseUrl: string;
}

export interface LoginScript {
  script: string;
  redactedScript: string;
}

/**
 * Get test credentials for a project and role
 */
export async function getCredentials(
  projectName: string,
  role: string = 'user1'
): Promise<LoginCredentials> {
  return getTestAccount(projectName, role);
}

/**
 * Generate a Playwright login script for the given credentials
 */
export function generateLoginScript(
  projectName: string,
  credentials: LoginCredentials
): LoginScript {
  const script = `
// Login script for ${projectName}
await page.goto('${credentials.baseUrl}/login');

// Wait for login form
await page.waitForSelector('input[type="email"], input[name="email"]');

// Fill credentials
await page.fill('input[type="email"], input[name="email"]', '${credentials.email}');
await page.fill('input[type="password"], input[name="password"]', '${credentials.password}');

// Submit
await page.click('button[type="submit"]');

// Wait for navigation
await page.waitForNavigation({ waitUntil: 'networkidle' });
`.trim();

  const redactedScript = script
    .replace(credentials.email, '[EMAIL]')
    .replace(credentials.password, '[PASSWORD]');

  return { script, redactedScript };
}

/**
 * Generate Playwright script for multi-user testing
 */
export function generateMultiUserScript(
  projectName: string,
  users: Array<{ role: string; credentials: LoginCredentials }>
): LoginScript {
  const contextScripts = users.map((user, index) => `
// User ${index + 1}: ${user.role}
const context${index + 1} = await browser.newContext();
const page${index + 1} = await context${index + 1}.newPage();
await page${index + 1}.goto('${user.credentials.baseUrl}/login');
await page${index + 1}.fill('input[type="email"], input[name="email"]', '${user.credentials.email}');
await page${index + 1}.fill('input[type="password"], input[name="password"]', '${user.credentials.password}');
await page${index + 1}.click('button[type="submit"]');
await page${index + 1}.waitForNavigation({ waitUntil: 'networkidle' });
`.trim());

  const script = `
// Multi-user test setup for ${projectName}
${contextScripts.join('\n\n')}

// Now you can interact with page1, page2, etc. as different users
`.trim();

  let redactedScript = script;
  for (const user of users) {
    redactedScript = redactedScript
      .replace(new RegExp(user.credentials.email, 'g'), `[${user.role.toUpperCase()}_EMAIL]`)
      .replace(new RegExp(user.credentials.password, 'g'), `[${user.role.toUpperCase()}_PASSWORD]`);
  }

  return { script, redactedScript };
}

/**
 * Get all available test accounts for a project
 */
export async function getAvailableRoles(projectName: string): Promise<string[]> {
  const secrets = await getSecrets();
  const projectConfig = secrets.testAccounts[projectName];

  if (!projectConfig) {
    return [];
  }

  return Object.keys(projectConfig.accounts);
}

/**
 * Generate credentials summary for inclusion in prompts (no actual secrets)
 */
export async function getCredentialsSummary(projectName: string): Promise<string> {
  const roles = await getAvailableRoles(projectName);

  if (roles.length === 0) {
    return `No test accounts configured for ${projectName}`;
  }

  const secrets = await getSecrets();
  const projectConfig = secrets.testAccounts[projectName];

  const lines = [
    `Test accounts for ${projectName}:`,
    `Base URL: ${projectConfig.baseUrl}`,
    `Available roles: ${roles.join(', ')}`,
    '',
    'To get credentials, use:',
    '  const creds = await getCredentials("' + projectName + '", "user1");',
  ];

  return lines.join('\n');
}
