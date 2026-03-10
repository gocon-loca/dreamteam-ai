/**
 * Test Sweep — Extracted from overnight.ts
 *
 * Checks test health across projects and creates fix goals
 * for any failing tests.
 */

import { getTestHealthSummary } from '../orchestration/cascade-retest.js';
import { listProjectNames } from '../projects/registry.js';
import { storePendingProposal } from '../orchestration/pending-proposals.js';

/**
 * Run a test sweep: check project health and create goals for test failures.
 * Returns the number of goals created.
 */
export async function runTestSweep(
  sendTelegram: (msg: string) => Promise<void>,
): Promise<number> {
  let goalsCreated = 0;

  try {
    const projects = listProjectNames();
    const testHealth = getTestHealthSummary();

    for (const projectName of projects) {
      if (projectName === 'dreamteam') continue;

      const projectHealth = testHealth.byProject?.[projectName];
      if (projectHealth && projectHealth.failed > 0) {
        const title = `Fix ${projectHealth.failed} failing test(s)`;
        const description = 'Tests failing. See test output for details.';
        storePendingProposal({ source: 'test-sweep', project: projectName, title, description });
        console.log(`[Test-sweep] [${projectName}] Proposed goal (awaiting approval): ${title}`);
        goalsCreated++;
      }
    }

    if (goalsCreated > 0) {
      console.log(`[Test-sweep] Created ${goalsCreated} fix goals`);
      await sendTelegram(`🔬 Test sweep: created ${goalsCreated} fix goal(s)`);
    }
  } catch (err) {
    console.error(`[Test-sweep] Error: ${err}`);
  }

  return goalsCreated;
}
