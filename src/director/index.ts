/**
 * Director Module - Strategic conversation layer
 */

export {
  initDirector,
  chat,
  getDirectorStatus,
  clearConversation,
  getRecentConversation,
  parseGoalProposals,
  stripGoalCommands,
} from './director.js';

export type { ChatResult } from './director.js';

export {
  initTranscription,
  isTranscriptionEnabled,
  transcribeAudio,
  transcribeTelegramVoice,
} from './transcribe.js';

export {
  addKnowledge,
  searchKnowledge,
  getRecentKnowledge,
  analyzePatterns,
  formatKnowledgeForDirector,
} from './knowledge.js';

export {
  runAppAudit,
  getLatestAudit,
  isAuditStale,
  formatAuditSummary,
} from './app-audit.js';

export type { AppAudit, PageAudit, FeatureEntry, UxIssue } from './app-audit.js';

export {
  getFeatureInventory,
  updateInventoryFromAudit,
  updateInventoryFromGoal,
  formatInventoryForDirector,
} from './feature-inventory.js';

export type { FeatureInventory, InventoryFeature } from './feature-inventory.js';

export {
  runProductResearch,
  getLatestResearch,
  isResearchStale,
  formatResearchSummary,
} from './product-research.js';

export type { UxResearch, Competitor, UxPattern } from './product-research.js';

export {
  generatePrototypes,
  generateFinalPrototype,
  getPrototypeBaseUrl,
} from './prototype-generator.js';

export type { PrototypeSet, PrototypeOption } from './prototype-generator.js';

export {
  runRedesignPipeline,
  getRedesignSession,
  getActiveRedesignSession,
  handleRedesignChoice,
  handleRedesignApproval,
} from './redesign.js';

export type { RedesignSession } from './redesign.js';

export {
  createDecision,
  logDecision,
  updateDecisionStatus,
  recordOutcome,
  getDecisionsByProject,
  getRecentDecisions,
  getPendingOutcomes,
  getCommitments,
  searchDecisions,
  analyzeDecisionPatterns,
  formatDecisionForTelegram,
  getDecisionsContextForDirector,
  exportForHabitTracking,
  parseDecisionCommands,
} from './decision-journal.js';
