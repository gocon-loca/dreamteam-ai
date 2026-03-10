/**
 * Langfuse Tracing — Structured observability for agent executions.
 *
 * Creates traces for each goal execution with spans for:
 * - Agent iterations (Claude CLI invocations)
 * - Quality gates (validation, test_commands, review, smoke test)
 * - Post-completion hooks (merge, push, retest)
 *
 * Configuration via environment variables:
 *   LANGFUSE_PUBLIC_KEY  — Langfuse project public key
 *   LANGFUSE_SECRET_KEY  — Langfuse project secret key
 *   LANGFUSE_HOST        — Langfuse server URL (default: https://cloud.langfuse.com)
 *
 * When keys are not set, all functions are no-ops (zero overhead).
 */

import { Langfuse } from 'langfuse';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tracing');

// ── Singleton Client ────────────────────────────────────────

let client: Langfuse | null = null;
let initialized = false;

function getClient(): Langfuse | null {
  if (initialized) return client;
  initialized = true;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !secretKey) {
    log.debug('Langfuse not configured — tracing disabled');
    return null;
  }

  try {
    client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
      flushAt: 5,       // Flush after 5 events
      flushInterval: 10000, // Or every 10 seconds
    });
    log.info('Langfuse tracing initialized');
  } catch (e) {
    log.error('Failed to initialize Langfuse', e);
    client = null;
  }

  return client;
}

// ── Types ───────────────────────────────────────────────────

export interface GoalTraceContext {
  traceId: string;
  goalId: string;
  project: string;
  /** End the trace and flush to Langfuse */
  end: (metadata?: Record<string, unknown>) => void;
  /** Create a span for a phase of execution */
  span: (name: string, metadata?: Record<string, unknown>) => SpanContext;
  /** Record an LLM generation (iteration) */
  generation: (name: string, opts: GenerationOpts) => GenerationContext;
  /** Log a simple event */
  event: (name: string, metadata?: Record<string, unknown>) => void;
  /** Update trace-level metadata */
  update: (data: { output?: string; metadata?: Record<string, unknown>; statusMessage?: string }) => void;
}

export interface SpanContext {
  spanId: string;
  /** Create a child span */
  span: (name: string, metadata?: Record<string, unknown>) => SpanContext;
  /** Record an LLM generation within this span */
  generation: (name: string, opts: GenerationOpts) => GenerationContext;
  /** Log an event within this span */
  event: (name: string, metadata?: Record<string, unknown>) => void;
  /** End the span with optional output */
  end: (metadata?: Record<string, unknown>) => void;
}

export interface GenerationContext {
  generationId: string;
  /** End the generation with output and usage */
  end: (opts: GenerationEndOpts) => void;
}

export interface GenerationOpts {
  model?: string;
  input?: string;
  metadata?: Record<string, unknown>;
}

export interface GenerationEndOpts {
  output?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalCostUsd?: number;
  };
  metadata?: Record<string, unknown>;
  statusMessage?: string;
}

// ── No-op implementations ───────────────────────────────────

const noopSpan: SpanContext = {
  spanId: '',
  span: () => noopSpan,
  generation: () => noopGeneration,
  event: () => {},
  end: () => {},
};

const noopGeneration: GenerationContext = {
  generationId: '',
  end: () => {},
};

const noopTrace: GoalTraceContext = {
  traceId: '',
  goalId: '',
  project: '',
  end: () => {},
  span: () => noopSpan,
  generation: () => noopGeneration,
  event: () => {},
  update: () => {},
};

// ── Trace Factory ───────────────────────────────────────────

/**
 * Create a trace for a goal execution. Returns a context object
 * with methods to add spans, generations, and events.
 *
 * If Langfuse is not configured, returns no-op context (zero overhead).
 */
export function createGoalTrace(opts: {
  goalId: string;
  project: string;
  title: string;
  model?: string;
  archetype?: string;
  attemptNumber?: number;
  complexity?: string;
}): GoalTraceContext {
  const lf = getClient();
  if (!lf) return noopTrace;

  try {
    const trace = lf.trace({
      name: `goal:${opts.title.slice(0, 100)}`,
      userId: opts.project,
      sessionId: opts.goalId,
      metadata: {
        goalId: opts.goalId,
        project: opts.project,
        model: opts.model,
        archetype: opts.archetype,
        attemptNumber: opts.attemptNumber,
        complexity: opts.complexity,
      },
      tags: [
        opts.project,
        opts.archetype || 'unknown',
        opts.model || 'unknown',
        `attempt-${opts.attemptNumber || 1}`,
      ].filter(Boolean),
    });

    const traceId = trace.id;

    function wrapSpan(langfuseSpan: ReturnType<typeof trace.span>): SpanContext {
      return {
        spanId: langfuseSpan.id,
        span: (name, metadata) => {
          try {
            return wrapSpan(langfuseSpan.span({ name, metadata }));
          } catch { return noopSpan; }
        },
        generation: (name, genOpts) => {
          try {
            return wrapGeneration(langfuseSpan.generation({
              name,
              model: genOpts.model,
              input: genOpts.input,
              metadata: genOpts.metadata,
            }));
          } catch { return noopGeneration; }
        },
        event: (name, metadata) => {
          try { langfuseSpan.event({ name, metadata }); } catch { /* ignore */ }
        },
        end: (metadata) => {
          try { langfuseSpan.end({ metadata }); } catch { /* ignore */ }
        },
      };
    }

    function wrapGeneration(langfuseGen: ReturnType<typeof trace.generation>): GenerationContext {
      return {
        generationId: langfuseGen.id,
        end: (endOpts) => {
          try {
            langfuseGen.end({
              output: endOpts.output,
              usage: endOpts.usage ? {
                input: endOpts.usage.inputTokens,
                output: endOpts.usage.outputTokens,
                total: (endOpts.usage.inputTokens || 0) + (endOpts.usage.outputTokens || 0),
                unit: 'TOKENS' as const,
              } : undefined,
              metadata: {
                ...endOpts.metadata,
                cacheReadTokens: endOpts.usage?.cacheReadTokens,
                cacheCreationTokens: endOpts.usage?.cacheCreationTokens,
                totalCostUsd: endOpts.usage?.totalCostUsd,
              },
              statusMessage: endOpts.statusMessage,
            });
          } catch { /* ignore */ }
        },
      };
    }

    return {
      traceId,
      goalId: opts.goalId,
      project: opts.project,

      end: (metadata) => {
        try {
          trace.update({ metadata });
          lf.flushAsync().catch(() => {});
        } catch { /* ignore */ }
      },

      span: (name, metadata) => {
        try {
          return wrapSpan(trace.span({ name, metadata }));
        } catch { return noopSpan; }
      },

      generation: (name, genOpts) => {
        try {
          return wrapGeneration(trace.generation({
            name,
            model: genOpts.model,
            input: genOpts.input,
            metadata: genOpts.metadata,
          }));
        } catch { return noopGeneration; }
      },

      event: (name, metadata) => {
        try { trace.event({ name, metadata }); } catch { /* ignore */ }
      },

      update: (data) => {
        try {
          trace.update({
            output: data.output,
            metadata: {
              ...data.metadata,
              statusMessage: data.statusMessage,
            },
          });
        } catch { /* ignore */ }
      },
    };
  } catch (e) {
    log.error('Failed to create goal trace', e);
    return noopTrace;
  }
}

// ── Shutdown ────────────────────────────────────────────────

/**
 * Flush pending events and shut down the Langfuse client.
 * Call this on process exit.
 */
export async function shutdownTracing(): Promise<void> {
  if (client) {
    try {
      await client.shutdownAsync();
      log.info('Langfuse tracing shut down');
    } catch (e) {
      log.swallow('shutdown-tracing', e);
    }
    client = null;
    initialized = false;
  }
}
