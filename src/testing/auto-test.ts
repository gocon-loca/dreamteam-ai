/**
 * Auto Test Generator - Creates testing prompts for autonomous agents
 */

import { getCredentials, generateLoginScript, getCredentialsSummary } from './credentials.js';
import { getProject, getTailscaleIp } from '../projects/registry.js';

export interface AutoTestOptions {
  useMobileSafari?: boolean;
  multiUser?: boolean;
  specificFlow?: string;
}

/**
 * Generate a comprehensive auto-test prompt for a project
 */
export async function generateAutoTestPrompt(
  projectName: string,
  focus?: string,
  options: AutoTestOptions = {}
): Promise<string> {
  const project = getProject(projectName);
  const tailscaleIp = getTailscaleIp();

  // Get credentials info
  let credentialsSection = '';
  try {
    const creds = await getCredentials(projectName, 'user1');
    const { redactedScript } = generateLoginScript(projectName, creds);

    credentialsSection = `
## Test Credentials

You have access to test accounts for this project. Use them like this:

\`\`\`typescript
// In your Playwright test:
${redactedScript}
\`\`\`

The actual credentials are available via the credentials system - do not hardcode them.
`;

    if (options.multiUser) {
      credentialsSection += `
### Multi-User Testing

This project supports multi-user testing. You can create multiple browser contexts:

\`\`\`typescript
// Create separate browser contexts for each user
const context1 = await browser.newContext();
const context2 = await browser.newContext();

// Login as different users in each context
// Then test interactions between them
\`\`\`
`;
    }
  } catch {
    credentialsSection = await getCredentialsSummary(projectName);
  }

  // Mobile Safari section
  const mobileSection = options.useMobileSafari ? `
## Mobile Testing (Safari/WebKit)

Test on mobile Safari using Playwright WebKit with iPhone emulation:

\`\`\`typescript
const { webkit, devices } = require('playwright');
const iPhone = devices['iPhone 13 Pro'];

const browser = await webkit.launch();
const context = await browser.newContext({
  ...iPhone,
});
const page = await context.newPage();

// Now 'page' behaves like Safari on iPhone
await page.goto('${project.healthCheck || `http://${tailscaleIp}:${project.devPort}`}');
\`\`\`

Key mobile considerations:
- Touch events instead of clicks
- Viewport is narrower (390x844 for iPhone 13 Pro)
- Check responsive design breakpoints
- Test touch gestures (swipe, pinch if applicable)
` : '';

  // Build the full prompt
  const prompt = `# Autonomous Testing: ${projectName}

${focus ? `## Focus: ${focus}` : '## Goal: Comprehensive UI Testing'}

You are testing the ${projectName} application autonomously using Playwright.

## Project Info

- Path: ${project.path}
- Dev Server: ${project.healthCheck || `http://${tailscaleIp}:${project.devPort || 3000}`}
${credentialsSection}
${mobileSection}

## Testing Guidelines

1. **Start the dev server** if not already running
2. **Use Playwright MCP** for browser automation
3. **Test critical user flows**:
   - Authentication (login, logout, session persistence)
   - Main feature workflows
   - Error states and edge cases
   - Form validation
   - Navigation and routing

4. **Be thorough but focused**:
   - Test happy paths first
   - Then test error conditions
   - Document any bugs found

5. **Signal your status**:
   - Log progress as you test
   - Use ASSUMPTION: when making test decisions
   - Use GOAL_COMPLETE when testing is done
   - Use BLOCKED: <reason> if you hit a real blocker

## Completion Criteria

${focus
    ? `Complete when: "${focus}" has been thoroughly tested`
    : `Complete when: All major user flows have been tested and documented`}

Report any bugs found with:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots if possible
`;

  return prompt;
}

/**
 * Generate a quick smoke test prompt
 */
export async function generateSmokeTestPrompt(projectName: string): Promise<string> {
  const project = getProject(projectName);
  const tailscaleIp = getTailscaleIp();

  return `# Quick Smoke Test: ${projectName}

Run a quick smoke test to verify the application is working:

1. Start dev server if needed
2. Navigate to ${project.healthCheck || `http://${tailscaleIp}:${project.devPort || 3000}`}
3. Verify the page loads without errors
4. Check browser console for JavaScript errors
5. Test login if auth is present
6. Navigate to 2-3 main pages

Report: PASS (with summary) or FAIL (with details)
`;
}

/**
 * Generate a specific flow test prompt
 */
export function generateFlowTestPrompt(
  projectName: string,
  flowDescription: string
): string {
  const project = getProject(projectName);

  return `# Flow Test: ${projectName}

## Test This Specific Flow:

${flowDescription}

## Project: ${projectName}
Path: ${project.path}

## Instructions

1. Use Playwright MCP to automate this flow
2. Test both success and failure cases
3. Document the results

Signal GOAL_COMPLETE when done, or BLOCKED: <reason> if stuck.
`;
}
