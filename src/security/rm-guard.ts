/**
 * RM Guard - Protection against dangerous rm commands
 *
 * This module provides safeguards to prevent accidental deletion of important directories.
 * Use this as a pre-hook for any bash commands involving rm.
 */

import { existsSync, statSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';

export interface RmGuardResult {
  allowed: boolean;
  reason?: string;
  warnings: string[];
}

// Directories that should NEVER be deleted
const PROTECTED_PATHS = [
  '/Users',
  '/System',
  '/Applications',
  '/Library',
  '/bin',
  '/sbin',
  '/usr',
  '/var',
  '/etc',
  '/tmp', // Still protected from rm -rf /tmp itself
  process.env.HOME,
];

// Project directories that need extra protection
const PROJECT_ROOTS = [
  process.env.HOME + '/projects',
];

// Patterns that indicate dangerous commands
const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?-[a-zA-Z]*r/, // rm -rf or rm -fr
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f/,   // rm -r -f
  /rm\s+--force\s+--recursive/,
  /rm\s+--recursive\s+--force/,
];

/**
 * Check if an rm command is safe to execute
 */
export function checkRmCommand(command: string): RmGuardResult {
  const warnings: string[] = [];

  // Check if this is even an rm command
  if (!command.trim().startsWith('rm ')) {
    return { allowed: true, warnings };
  }

  // Check for dangerous patterns
  const isDangerous = DANGEROUS_PATTERNS.some(pattern => pattern.test(command));

  // Extract paths from the command
  const paths = extractPaths(command);

  for (const path of paths) {
    const resolvedPath = resolve(path);

    // Check against protected paths
    for (const protected_path of PROTECTED_PATHS) {
      if (protected_path && resolvedPath === protected_path) {
        return {
          allowed: false,
          reason: `BLOCKED: Cannot delete protected system path: ${resolvedPath}`,
          warnings,
        };
      }

      // Check if trying to delete parent of protected path
      if (protected_path && protected_path.startsWith(resolvedPath + '/')) {
        return {
          allowed: false,
          reason: `BLOCKED: Cannot delete path containing protected directory: ${resolvedPath}`,
          warnings,
        };
      }
    }

    // Check project roots
    for (const projectRoot of PROJECT_ROOTS) {
      if (resolvedPath === projectRoot) {
        return {
          allowed: false,
          reason: `BLOCKED: Cannot delete project root: ${resolvedPath}`,
          warnings,
        };
      }

      // Check if it's a project directory (direct child of project root)
      if (dirname(resolvedPath) === projectRoot) {
        // This is a top-level project - require extra confirmation
        if (isDangerous) {
          warnings.push(`WARNING: About to recursively delete project: ${resolvedPath}`);

          // Check if directory has significant content
          if (existsSync(resolvedPath)) {
            try {
              const contents = readdirSync(resolvedPath);
              if (contents.length > 5) {
                return {
                  allowed: false,
                  reason: `BLOCKED: Refusing to rm -rf project directory with ${contents.length} items: ${resolvedPath}. Use explicit file paths instead.`,
                  warnings,
                };
              }
            } catch {
              // Can't read directory, be cautious
              warnings.push(`Cannot verify contents of ${resolvedPath}`);
            }
          }
        }
      }
    }

    // General dangerous rm -rf warnings
    if (isDangerous && existsSync(resolvedPath)) {
      try {
        const stats = statSync(resolvedPath);
        if (stats.isDirectory()) {
          const contents = readdirSync(resolvedPath);
          if (contents.length > 20) {
            warnings.push(`WARNING: Directory ${resolvedPath} has ${contents.length} items`);
          }
        }
      } catch {
        // Continue with other checks
      }
    }
  }

  // If we have warnings but no blocking reason, still allow but warn
  if (warnings.length > 0) {
    return {
      allowed: true,
      warnings,
    };
  }

  return { allowed: true, warnings: [] };
}

/**
 * Extract file paths from an rm command
 */
function extractPaths(command: string): string[] {
  const paths: string[] = [];

  // Remove 'rm' and flags, then split remaining as paths
  const withoutRm = command.replace(/^rm\s+/, '');
  const parts = withoutRm.split(/\s+/);

  for (const part of parts) {
    // Skip flags
    if (part.startsWith('-')) continue;

    // Handle quoted paths
    const cleanPath = part.replace(/^["']|["']$/g, '');

    if (cleanPath) {
      paths.push(cleanPath);
    }
  }

  return paths;
}

/**
 * Create a safe rm wrapper that checks before executing
 */
export function createSafeRm(
  originalExec: (cmd: string) => Promise<string>
): (cmd: string) => Promise<string> {
  return async (cmd: string) => {
    if (cmd.trim().startsWith('rm ')) {
      const check = checkRmCommand(cmd);

      if (!check.allowed) {
        throw new Error(check.reason);
      }

      if (check.warnings.length > 0) {
        console.warn('RM Guard warnings:', check.warnings);
      }
    }

    return originalExec(cmd);
  };
}

/**
 * Validate a path is safe to delete
 */
export function isSafeToDelete(path: string): { safe: boolean; reason?: string } {
  const resolvedPath = resolve(path);

  // Never delete home directory
  if (resolvedPath === process.env.HOME) {
    return { safe: false, reason: 'Cannot delete home directory' };
  }

  // Never delete root
  if (resolvedPath === '/') {
    return { safe: false, reason: 'Cannot delete root directory' };
  }

  // Check protected paths
  for (const protected_path of PROTECTED_PATHS) {
    if (protected_path && resolvedPath === protected_path) {
      return { safe: false, reason: `Protected system path: ${resolvedPath}` };
    }
  }

  // Check project roots
  for (const projectRoot of PROJECT_ROOTS) {
    if (resolvedPath === projectRoot) {
      return { safe: false, reason: `Project root directory: ${resolvedPath}` };
    }

    // Warn about project directories
    if (dirname(resolvedPath) === projectRoot) {
      return { safe: false, reason: `Top-level project directory: ${resolvedPath}. Delete contents explicitly instead.` };
    }
  }

  return { safe: true };
}
