/**
 * Project Registry - Loads and manages project configurations
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ProjectConfig {
  path: string;
  description: string;
  hasDevServer: boolean;
  devCommand?: string;
  devPort?: number;
  healthCheck?: string;
  /** Max concurrent goals for this project (overrides global maxWorkersPerProject) */
  maxConcurrentGoals?: number;
  testAuth?: {
    email: string;
    password: string;
    loginPath: string;
  };
}

interface ProjectsYaml {
  projects: Record<string, ProjectConfig>;
  tailscaleIp: string;
}

let cachedConfig: ProjectsYaml | null = null;

export function loadProjectConfig(): ProjectsYaml {
  if (cachedConfig) {
    return cachedConfig;
  }

  const localPath = join(__dirname, '../../config/projects.local.yaml');
  const defaultPath = join(__dirname, '../../config/projects.yaml');
  const configPath = existsSync(localPath) ? localPath : defaultPath;

  if (!existsSync(configPath)) {
    throw new Error(`Projects config not found. Copy config/projects.yaml to config/projects.local.yaml and customize.`);
  }

  const content = readFileSync(configPath, 'utf-8');
  cachedConfig = parseYaml(content) as ProjectsYaml;

  // Resolve ~ to $HOME in all project paths so config is portable across machines
  const home = homedir();
  for (const project of Object.values(cachedConfig.projects)) {
    if (project.path.startsWith('~/')) {
      project.path = join(home, project.path.slice(2));
    }
  }

  return cachedConfig;
}

export function getProject(name: string): ProjectConfig {
  const config = loadProjectConfig();
  const project = config.projects[name];

  if (!project) {
    const available = Object.keys(config.projects).join(', ');
    throw new Error(`Project '${name}' not found. Available: ${available}`);
  }

  return project;
}

export function getAllProjects(): Record<string, ProjectConfig> {
  return loadProjectConfig().projects;
}

export function listProjectNames(): string[] {
  return Object.keys(loadProjectConfig().projects);
}

export function getTailscaleIp(): string {
  return loadProjectConfig().tailscaleIp;
}

export function clearProjectCache(): void {
  cachedConfig = null;
}
