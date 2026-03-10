/**
 * Cascading Retest System
 *
 * Tracks which tests/areas are affected by changes and re-runs them.
 *
 * Features:
 * - Dependency graph: maps files -> tests that cover them
 * - Change detection: identifies what changed since last checkpoint
 * - Cascade logic: when X changes, run tests that depend on X
 * - Regression prevention: catches issues before they propagate
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execSync } from 'child_process';
import { getProject, listProjectNames } from '../projects/registry.js';
import { Checkpoint, compareCheckpoints, getLatestCheckpoint, createCheckpoint } from './checkpoint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const DEPS_FILE = join(DATA_DIR, 'test-dependencies.json');

export interface TestDependency {
  testFile: string;
  testName?: string;
  dependsOn: string[]; // Files or patterns this test covers
  project: string;
  lastRun?: string;
  lastResult?: 'pass' | 'fail' | 'skip';
}

export interface DependencyGraph {
  dependencies: TestDependency[];
  lastUpdated: string;
}

export interface RetestResult {
  project: string;
  testsRun: string[];
  passed: number;
  failed: number;
  errors: string[];
  duration: number;
}

export interface CascadeAnalysis {
  changedFiles: string[];
  affectedTests: TestDependency[];
  testsToRun: string[];
  reason: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadDependencies(): DependencyGraph {
  ensureDataDir();
  if (existsSync(DEPS_FILE)) {
    return JSON.parse(readFileSync(DEPS_FILE, 'utf-8'));
  }
  return { dependencies: [], lastUpdated: new Date().toISOString() };
}

function saveDependencies(graph: DependencyGraph): void {
  ensureDataDir();
  graph.lastUpdated = new Date().toISOString();
  writeFileSync(DEPS_FILE, JSON.stringify(graph, null, 2));
}

/**
 * Register a test's dependencies
 */
export function registerTestDependency(
  project: string,
  testFile: string,
  dependsOn: string[],
  testName?: string
): TestDependency {
  const graph = loadDependencies();

  // Find existing or create new
  let existing = graph.dependencies.find(
    d => d.project === project && d.testFile === testFile && d.testName === testName
  );

  if (existing) {
    // Merge dependencies
    const uniqueDeps = new Set([...existing.dependsOn, ...dependsOn]);
    existing.dependsOn = Array.from(uniqueDeps);
  } else {
    existing = {
      testFile,
      testName,
      dependsOn,
      project,
    };
    graph.dependencies.push(existing);
  }

  saveDependencies(graph);
  return existing;
}

/**
 * Auto-discover test dependencies by analyzing imports
 */
export async function discoverDependencies(project: string): Promise<TestDependency[]> {
  const projectConfig = getProject(project);
  const discovered: TestDependency[] = [];

  try {
    // Find test files
    const testFiles = execSync(
      `find . -type f \\( -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" -o -name "*.spec.tsx" -o -name "test_*.py" -o -name "*_test.py" \\) | head -100`,
      {
        cwd: projectConfig.path,
        encoding: 'utf-8',
        timeout: 30000,
      }
    ).trim().split('\n').filter(f => f.length > 0);

    for (const testFile of testFiles) {
      try {
        const content = readFileSync(join(projectConfig.path, testFile), 'utf-8');

        // Extract imports (simple regex, works for most cases)
        const imports: string[] = [];

        // TypeScript/JavaScript imports
        const tsImports = content.matchAll(/from ['"]([^'"]+)['"]/g);
        for (const match of tsImports) {
          const importPath = match[1];
          if (importPath.startsWith('.') || importPath.startsWith('@/')) {
            imports.push(importPath);
          }
        }

        // Python imports
        const pyImports = content.matchAll(/from ([\w.]+) import/g);
        for (const match of pyImports) {
          imports.push(match[1]);
        }

        if (imports.length > 0) {
          const dep = registerTestDependency(project, testFile, imports);
          discovered.push(dep);
        }
      } catch {
        // Skip files we can't read
      }
    }
  } catch (error) {
    console.error(`Failed to discover dependencies for ${project}:`, error);
  }

  return discovered;
}

/**
 * Get files changed between two git commits
 */
function getChangedFiles(projectPath: string, fromCommit: string, toCommit: string): string[] {
  try {
    const diff = execSync(`git diff --name-only ${fromCommit}..${toCommit}`, {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    return diff.split('\n').filter(f => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Get files changed since last checkpoint
 */
export function getFilesChangedSinceCheckpoint(
  project: string,
  checkpoint: Checkpoint
): string[] {
  const projectConfig = getProject(project);
  const projectState = checkpoint.state.projects.find(p => p.project === project);

  if (!projectState) return [];

  // Get current HEAD
  const currentCommit = execSync('git rev-parse HEAD', {
    cwd: projectConfig.path,
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();

  if (currentCommit === projectState.gitCommit) {
    // No new commits, check for dirty files
    return projectState.modifiedFiles;
  }

  return getChangedFiles(
    projectConfig.path,
    projectState.gitCommit,
    currentCommit
  );
}

/**
 * Analyze which tests need to run based on changed files
 */
export function analyzeAffectedTests(
  project: string,
  changedFiles: string[]
): CascadeAnalysis {
  const graph = loadDependencies();
  const projectDeps = graph.dependencies.filter(d => d.project === project);

  const affectedTests: TestDependency[] = [];

  for (const dep of projectDeps) {
    const isAffected = changedFiles.some(changedFile => {
      // Check if any dependency matches the changed file
      return dep.dependsOn.some(depPattern => {
        // Normalize paths for comparison
        const normalizedChange = changedFile.replace(/^\.\//, '');
        const normalizedDep = depPattern.replace(/^\.\//, '');

        // Direct match
        if (normalizedChange === normalizedDep) return true;

        // Pattern match (simple glob-like)
        if (normalizedDep.includes('*')) {
          const regex = new RegExp(
            normalizedDep.replace(/\*/g, '.*').replace(/\//g, '\\/')
          );
          if (regex.test(normalizedChange)) return true;
        }

        // Partial path match
        if (normalizedChange.includes(normalizedDep)) return true;
        if (normalizedDep.includes(normalizedChange)) return true;

        return false;
      });
    });

    if (isAffected) {
      affectedTests.push(dep);
    }
  }

  return {
    changedFiles,
    affectedTests,
    testsToRun: affectedTests.map(t => t.testFile),
    reason:
      affectedTests.length > 0
        ? `${changedFiles.length} files changed, ${affectedTests.length} tests affected`
        : `${changedFiles.length} files changed, no registered tests affected`,
  };
}

/**
 * Run affected tests for a project
 */
export async function runAffectedTests(
  project: string,
  testsToRun: string[],
  onProgress?: (msg: string) => void
): Promise<RetestResult> {
  const projectConfig = getProject(project);
  const startTime = Date.now();
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  onProgress?.(`Running ${testsToRun.length} affected tests for ${project}...`);

  for (const testFile of testsToRun) {
    try {
      // Determine test command based on file extension
      let testCmd: string;
      if (testFile.endsWith('.py')) {
        testCmd = `pytest ${testFile} -v`;
      } else {
        testCmd = `npm test -- ${testFile}`;
      }

      onProgress?.(`  Running: ${testFile}`);

      execSync(testCmd, {
        cwd: projectConfig.path,
        encoding: 'utf-8',
        timeout: 120000, // 2 minute timeout per test
        stdio: 'pipe',
      });

      passed++;
      updateTestResult(project, testFile, 'pass');
    } catch (error) {
      failed++;
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(`${testFile}: ${errMsg.slice(0, 200)}`);
      updateTestResult(project, testFile, 'fail');
      onProgress?.(`  FAILED: ${testFile}`);
    }
  }

  const duration = Date.now() - startTime;

  return {
    project,
    testsRun: testsToRun,
    passed,
    failed,
    errors,
    duration,
  };
}

/**
 * Update test result in dependency graph
 */
function updateTestResult(
  project: string,
  testFile: string,
  result: 'pass' | 'fail' | 'skip'
): void {
  const graph = loadDependencies();
  const dep = graph.dependencies.find(
    d => d.project === project && d.testFile === testFile
  );

  if (dep) {
    dep.lastRun = new Date().toISOString();
    dep.lastResult = result;
    saveDependencies(graph);
  }
}

/**
 * Full cascade retest flow
 * 1. Get latest checkpoint
 * 2. Find what changed
 * 3. Analyze affected tests
 * 4. Run them
 * 5. Create new checkpoint
 */
export async function runCascadeRetest(
  project: string,
  onProgress?: (msg: string) => void
): Promise<{
  analysis: CascadeAnalysis;
  result?: RetestResult;
  checkpoint?: Checkpoint;
}> {
  onProgress?.(`🔄 Starting cascade retest for ${project}`);

  // Get baseline checkpoint
  const latestCheckpoint = getLatestCheckpoint();
  if (!latestCheckpoint) {
    onProgress?.(`No checkpoint found, creating baseline...`);
    const baseline = await createCheckpoint('manual', {
      description: 'Baseline for cascade retest',
      tags: [project],
    });
    return {
      analysis: {
        changedFiles: [],
        affectedTests: [],
        testsToRun: [],
        reason: 'Created baseline checkpoint, no changes to analyze',
      },
      checkpoint: baseline,
    };
  }

  // Find what changed
  const changedFiles = getFilesChangedSinceCheckpoint(project, latestCheckpoint);

  if (changedFiles.length === 0) {
    onProgress?.(`No changes detected since last checkpoint`);
    return {
      analysis: {
        changedFiles: [],
        affectedTests: [],
        testsToRun: [],
        reason: 'No files changed since last checkpoint',
      },
    };
  }

  onProgress?.(`Found ${changedFiles.length} changed files`);

  // Analyze affected tests
  const analysis = analyzeAffectedTests(project, changedFiles);

  if (analysis.testsToRun.length === 0) {
    onProgress?.(`No registered tests affected by these changes`);

    // Still create a checkpoint to track the change
    const checkpoint = await createCheckpoint('manual', {
      description: `Retest: no tests affected by ${changedFiles.length} file changes`,
      tags: [project, 'retest'],
    });

    return { analysis, checkpoint };
  }

  // Run the affected tests
  const result = await runAffectedTests(project, analysis.testsToRun, onProgress);

  // Create checkpoint after retest
  const checkpoint = await createCheckpoint('after_risky', {
    description: `Retest: ${result.passed} passed, ${result.failed} failed`,
    tags: [project, 'retest', result.failed > 0 ? 'has-failures' : 'all-passed'],
    metadata: {
      testsRun: result.testsRun.length,
      passed: result.passed,
      failed: result.failed,
    },
  });

  onProgress?.(`✅ Cascade retest complete: ${result.passed} passed, ${result.failed} failed`);

  return { analysis, result, checkpoint };
}

/**
 * Run cascade retest for all projects with changes
 */
export async function runFullCascadeRetest(
  onProgress?: (msg: string) => void
): Promise<Map<string, RetestResult>> {
  const results = new Map<string, RetestResult>();
  const latestCheckpoint = getLatestCheckpoint();

  if (!latestCheckpoint) {
    onProgress?.(`No checkpoint found, skipping cascade retest`);
    return results;
  }

  for (const project of listProjectNames()) {
    const changedFiles = getFilesChangedSinceCheckpoint(project, latestCheckpoint);

    if (changedFiles.length > 0) {
      const { result } = await runCascadeRetest(project, onProgress);
      if (result) {
        results.set(project, result);
      }
    }
  }

  return results;
}

/**
 * Format retest result for display
 */
export function formatRetestResult(result: RetestResult): string {
  const lines = [
    `🧪 Retest Results: ${result.project}`,
    `   Tests run: ${result.testsRun.length}`,
    `   Passed: ${result.passed}`,
    `   Failed: ${result.failed}`,
    `   Duration: ${(result.duration / 1000).toFixed(1)}s`,
  ];

  if (result.errors.length > 0) {
    lines.push('   Errors:');
    for (const err of result.errors.slice(0, 3)) {
      lines.push(`     • ${err.slice(0, 100)}`);
    }
    if (result.errors.length > 3) {
      lines.push(`     ... and ${result.errors.length - 3} more`);
    }
  }

  return lines.join('\n');
}

/**
 * Get test health summary
 */
export function getTestHealthSummary(): {
  totalTests: number;
  recentlyPassed: number;
  recentlyFailed: number;
  neverRun: number;
  byProject: Record<string, { passed: number; failed: number; notRun: number }>;
} {
  const graph = loadDependencies();
  const byProject: Record<string, { passed: number; failed: number; notRun: number }> = {};

  let recentlyPassed = 0;
  let recentlyFailed = 0;
  let neverRun = 0;

  for (const dep of graph.dependencies) {
    if (!byProject[dep.project]) {
      byProject[dep.project] = { passed: 0, failed: 0, notRun: 0 };
    }

    if (!dep.lastResult) {
      neverRun++;
      byProject[dep.project].notRun++;
    } else if (dep.lastResult === 'pass') {
      recentlyPassed++;
      byProject[dep.project].passed++;
    } else if (dep.lastResult === 'fail') {
      recentlyFailed++;
      byProject[dep.project].failed++;
    }
  }

  return {
    totalTests: graph.dependencies.length,
    recentlyPassed,
    recentlyFailed,
    neverRun,
    byProject,
  };
}
