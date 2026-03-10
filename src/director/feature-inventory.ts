/**
 * Feature Inventory — Persistent per-project feature tracking
 *
 * Enriched from audits + goal completions.
 * Used by the Director for product-aware goal proposals.
 *
 * Stored at data/inventory/{project}-features.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { AppAudit } from './app-audit.js';
import type { Goal } from '../orchestration/goal-manager.js';
import type { StructuredDebrief } from '../orchestration/goal-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../../data');
const INVENTORY_DIR = join(DATA_DIR, 'inventory');

// ── Types ──────────────────────────────────────────────────

export interface FeatureInventory {
  project: string;
  lastUpdated: string;
  features: InventoryFeature[];
}

export interface InventoryFeature {
  name: string;
  category: string;
  status: 'working' | 'partial' | 'broken' | 'empty' | 'planned';
  pages: string[];
  lastVerified: string;
  goalHistory: string[];
  notes: string;
}

// ── Core Functions ──────────────────────────────────────────

export function getFeatureInventory(project: string): FeatureInventory | null {
  const filePath = join(INVENTORY_DIR, `${project}-features.json`);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveInventory(inventory: FeatureInventory): void {
  if (!existsSync(INVENTORY_DIR)) {
    mkdirSync(INVENTORY_DIR, { recursive: true });
  }
  inventory.lastUpdated = new Date().toISOString();
  writeFileSync(
    join(INVENTORY_DIR, `${inventory.project}-features.json`),
    JSON.stringify(inventory, null, 2)
  );
}

export function updateInventoryFromAudit(project: string, audit: AppAudit): void {
  const existing = getFeatureInventory(project) || {
    project,
    lastUpdated: new Date().toISOString(),
    features: [],
  };

  const now = new Date().toISOString();

  for (const auditFeature of audit.features) {
    const match = existing.features.find(
      (f) => f.name.toLowerCase() === auditFeature.name.toLowerCase()
    );

    if (match) {
      // Update existing feature
      match.status = auditFeature.status;
      match.pages = auditFeature.pages;
      match.lastVerified = now;
      if (auditFeature.category) match.category = auditFeature.category;
    } else {
      // Add new feature
      existing.features.push({
        name: auditFeature.name,
        category: auditFeature.category,
        status: auditFeature.status,
        pages: auditFeature.pages,
        lastVerified: now,
        goalHistory: [],
        notes: '',
      });
    }
  }

  // Note: features NOT seen in audit are preserved (may be behind auth)

  saveInventory(existing);
  console.log(`[Inventory] Updated ${project}: ${existing.features.length} features`);
}

export function updateInventoryFromGoal(
  project: string,
  goal: Goal,
  debrief: StructuredDebrief | null,
): void {
  const existing = getFeatureInventory(project);
  if (!existing) return; // No inventory yet — will be created on first audit

  const goalText = `${goal.title} ${goal.description || ''}`.toLowerCase();
  let updated = false;

  for (const feature of existing.features) {
    // Check if goal title/description mentions this feature
    if (goalText.includes(feature.name.toLowerCase())) {
      // Add goal to history
      if (!feature.goalHistory.includes(goal.id)) {
        feature.goalHistory.push(goal.id);
      }

      // Update status based on debrief
      if (debrief) {
        if (debrief.working && debrief.working.toLowerCase().includes(feature.name.toLowerCase())) {
          feature.status = 'working';
        } else if (debrief.broken && debrief.broken.toLowerCase().includes(feature.name.toLowerCase())) {
          feature.status = 'broken';
        }
      }

      updated = true;
    }
  }

  // Check if goal created a new feature
  if (debrief?.working) {
    const workingFeatures = debrief.working.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const desc of workingFeatures) {
      const alreadyTracked = existing.features.some(
        (f) => f.name.toLowerCase() === desc.toLowerCase() ||
               desc.toLowerCase().includes(f.name.toLowerCase())
      );
      if (!alreadyTracked && desc.length > 3 && desc.length < 80) {
        existing.features.push({
          name: desc,
          category: 'uncategorized',
          status: 'working',
          pages: [],
          lastVerified: new Date().toISOString(),
          goalHistory: [goal.id],
          notes: `Detected from goal completion: ${goal.title}`,
        });
        updated = true;
      }
    }
  }

  if (updated) {
    saveInventory(existing);
    console.log(`[Inventory] Updated ${project} from goal ${goal.id}`);
  }
}

export function formatInventoryForDirector(project: string): string | null {
  const inventory = getFeatureInventory(project);
  if (!inventory || inventory.features.length === 0) return null;

  // Group by category
  const byCategory = new Map<string, InventoryFeature[]>();
  for (const f of inventory.features) {
    const cat = f.category || 'uncategorized';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(f);
  }

  const statusIcon: Record<string, string> = {
    working: '✓',
    partial: '◐',
    broken: '✗',
    empty: '○',
    planned: '…',
  };

  const lines: string[] = [];
  for (const [category, features] of byCategory) {
    lines.push(`**${category}:**`);
    for (const f of features) {
      const icon = statusIcon[f.status] || '?';
      lines.push(`  ${icon} ${f.name} (${f.status})`);
    }
  }

  return lines.join('\n');
}
