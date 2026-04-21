// SPDX-License-Identifier: Apache-2.0
/**
 * JSONL-DAG reconciliation engine, real-time DAG ingestion hook, and DAG-mode
 * context engine factory.
 *
 * Wires reconciliation, integrity checking, and DAG layers into a coherent
 * engine that replaces the pipeline when config.version === "dag".
 *
 * Key components:
 * - {@link reconcileJsonlToDag}: Crash recovery -- imports JSONL messages missing
 *   from the DAG within a SQLite transaction using content_hash identity.
 * - {@link installDagIngestionHook}: Real-time dual-write -- patches sm.appendMessage
 *   to mirror messages into the DAG. Never blocks the JSONL path.
 * - {@link createDagContextEngine}: DAG-mode context engine with reconciliation,
 *   optional compaction, assembler, and annotator layers.
 *
 * DAG Integrity & Wiring.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextStore } from "@comis/memory";
import type { ComisLogger } from "@comis/infra";
import type { ContextEngineConfig } from "@comis/core";
import type {
  ContextEngine,
  ContextLayer,
  TokenBudget,
  DagContextEngineDeps,
  ReconciliationResult,
  IntegrityCheckDeps,
} from "./types.js";
import { checkIntegrity } from "./dag-integrity.js";
import { createDagAssemblerLayer } from "./dag-assembler.js";
import { createDagAnnotatorLayer } from "./dag-annotator.js";
import { createThinkingBlockCleaner } from "./thinking-block-cleaner.js";
import { shouldCompact, runDagCompaction } from "./dag-triggers.js";
import { computeTokenBudget } from "./token-budget.js";
import { LAYER_CIRCUIT_BREAKER_THRESHOLD } from "./constants.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Internal type for raw DB access
// ---------------------------------------------------------------------------

type RawDb = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  transaction<T>(fn: () => T): () => T;
};

// ---------------------------------------------------------------------------
// Section 1: Content Hash Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a 16-character hex content hash for duplicate detection.
 * Matches the truncated SHA-256 prefix used for content_hash in ctx_messages.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Extract text content from the SDK's AgentMessage format.
 *
 * - String content: used directly
 * - Array content: concatenate all `{ type: "text" }` blocks joined by newline
 * - No text content: returns empty string
 *
 * Role is NOT included in the hash (stored separately in ctx_messages).
 */
export function flattenMessageContent(message: AgentMessage): string {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const content = (message as any).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        textParts.push(block.text);
      }
    }
    return textParts.join("\n");
  }
  return "";
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Map SDK message roles to DAG storage roles.
 */
export function mapMessageRole(message: AgentMessage): string {
  const roleMap: Record<string, string> = {
    user: "user",
    assistant: "assistant",
    toolResult: "tool_result",
    tool_use: "tool_use",
  };
  return roleMap[message.role] ?? message.role;
}

// ---------------------------------------------------------------------------
// Section 2: Reconciliation Engine
// ---------------------------------------------------------------------------

/**
 * Reconcile JSONL session messages into the DAG context store.
 *
 * Runs within a SQLite transaction for atomicity. Two paths:
 * - **Full import** (lastDagSeq === 0): All messages imported (mode switch case).
 * - **Anchor-based** (lastDagSeq > 0): Only messages after the last matching
 *   content hash anchor are imported.
 *
 * The caller is responsible for ensuring the conversation exists before calling.
 *
 * @param messages - JSONL session messages (from buildSessionContext)
 * @param store - Context store for DAG operations
 * @param db - Raw better-sqlite3 Database for transactions
 * @param conversationId - Pre-existing conversation ID
 * @param estimateTokens - Token estimation function
 * @param logger - Structured logger
 * @returns ReconciliationResult with import statistics
 */
export function reconcileJsonlToDag(
  messages: AgentMessage[],
  store: ContextStore,
  db: unknown,
  conversationId: string,
  estimateTokens: (text: string) => number,
  logger: ComisLogger,
): ReconciliationResult {
  const startTime = Date.now();

  if (messages.length === 0) {
    return { conversationId, imported: 0, fullImport: false, durationMs: 0 };
  }

  const rawDb = db as RawDb;

  const runInTransaction = rawDb.transaction(() => {
    const lastDagSeq = store.getLastMessageSeq(conversationId);

    // --- Full import path (mode switch) ---
    if (lastDagSeq === 0) {
      let importCount = 0;
      const importedMessageIds: number[] = [];

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i]!; // eslint-disable-line security/detect-object-injection
        const content = flattenMessageContent(message);
        const hash = computeContentHash(content);

        // Skip if already exists (defensive)
        const existing = store.getMessageByHash(conversationId, hash);
        if (existing) {
          importedMessageIds.push(existing.message_id);
          continue;
        }

        const messageId = store.insertMessage({
          conversationId,
          seq: i + 1,
          role: mapMessageRole(message),
          content,
          contentHash: hash,
          tokenCount: estimateTokens(content),
        });
        importedMessageIds.push(messageId);
        importCount++;
      }

      // Build context items for all messages (including pre-existing ones)
      store.replaceContextItems(
        conversationId,
        importedMessageIds.map((messageId, i) => ({
          ordinal: i,
          itemType: "message" as const,
          messageId,
        })),
      );

      return {
        conversationId,
        imported: importCount,
        fullImport: true,
        durationMs: Date.now() - startTime,
      };
    }

    // --- Anchor-based reconciliation ---
    const lastDagRow = rawDb
      .prepare(
        "SELECT content_hash FROM ctx_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(conversationId) as { content_hash: string } | undefined;

    if (!lastDagRow) {
      // Shouldn't happen if lastDagSeq > 0, but handle gracefully
      return {
        conversationId,
        imported: 0,
        fullImport: false,
        durationMs: Date.now() - startTime,
      };
    }

    // Compute hashes for all JSONL messages
    const jsonlHashes = messages.map((msg) =>
      computeContentHash(flattenMessageContent(msg)),
    );

    // Find the anchor: LAST position in JSONL where hash matches last DAG message
    let anchorIndex = -1;
    for (let i = jsonlHashes.length - 1; i >= 0; i--) {
      if (jsonlHashes[i] === lastDagRow.content_hash) { // eslint-disable-line security/detect-object-injection
        anchorIndex = i;
        break;
      }
    }

    if (anchorIndex === -1) {
      logger.warn(
        {
          conversationId,
          lastDagHash: lastDagRow.content_hash,
          hint: "JSONL-DAG anchor not found; gap too large or hash collision. Reconciliation skipped.",
          errorKind: "data" as const,
        },
        "DAG reconciliation anchor not found",
      );
      return {
        conversationId,
        imported: 0,
        fullImport: false,
        durationMs: Date.now() - startTime,
      };
    }

    // Import messages after the anchor
    let importCount = 0;
    const newMessageIds: number[] = [];

    for (let i = anchorIndex + 1; i < messages.length; i++) {
      const message = messages[i]!; // eslint-disable-line security/detect-object-injection
      const content = flattenMessageContent(message);
      const hash = jsonlHashes[i]!; // eslint-disable-line security/detect-object-injection

      // Skip duplicates
      const existing = store.getMessageByHash(conversationId, hash);
      if (existing) continue;

      const messageId = store.insertMessage({
        conversationId,
        seq: lastDagSeq + importCount + 1,
        role: mapMessageRole(message),
        content,
        contentHash: hash,
        tokenCount: estimateTokens(content),
      });
      newMessageIds.push(messageId);
      importCount++;
    }

    // Update context items: append new items after existing ones
    if (newMessageIds.length > 0) {
      const existingItems = store.getContextItems(conversationId);
      const newItems = newMessageIds.map((messageId, i) => ({
        ordinal: existingItems.length + i,
        itemType: "message" as const,
        messageId,
      }));

      store.replaceContextItems(conversationId, [
        ...existingItems.map((item, i) => ({
          ordinal: i,
          itemType: item.item_type as "message" | "summary",
          messageId: item.message_id ?? undefined,
          summaryId: item.summary_id ?? undefined,
        })),
        ...newItems,
      ]);
    }

    return {
      conversationId,
      imported: importCount,
      fullImport: false,
      durationMs: Date.now() - startTime,
    };
  });

  return runInTransaction();
}

// ---------------------------------------------------------------------------
// Section 3: Ingestion Hook
// ---------------------------------------------------------------------------

/**
 * Install a DAG ingestion hook on a SessionManager instance.
 *
 * Patches `sm.appendMessage` to mirror messages into the DAG store in
 * real-time. The JSONL path is NEVER blocked -- DAG ingest errors are caught
 * and logged as WARN.
 *
 * **Installation ordering:** Must be installed BEFORE
 * `installMicrocompactionGuard` so that microcompaction wraps this hook.
 * Execution order: microcompaction (outer) -> DAG ingest (inner) -> real appendMessage.
 *
 * @param sm - SessionManager instance to patch
 * @param store - Context store for DAG writes
 * @param conversationId - Active conversation ID
 * @param logger - Structured logger
 * @param estimateTokens - Token estimation function
 */
export function installDagIngestionHook(
  sm: unknown,
  store: ContextStore,
  conversationId: string,
  logger: ComisLogger,
  estimateTokens: (text: string) => number,
): void {
  const typedSm = sm as { appendMessage: (msg: unknown) => string };
  const originalAppend = typedSm.appendMessage.bind(typedSm);

  typedSm.appendMessage = (message: unknown): string => {
    // JSONL write must succeed first
    const result = originalAppend(message);

    // DAG ingest in try/catch -- never block JSONL path
    try {
      const agentMsg = message as AgentMessage;
      const content = flattenMessageContent(agentMsg);
      const hash = computeContentHash(content);

      // Skip duplicates
      const existing = store.getMessageByHash(conversationId, hash);
      if (!existing) {
        const lastSeq = store.getLastMessageSeq(conversationId);
        const messageId = store.insertMessage({
          conversationId,
          seq: lastSeq + 1,
          role: mapMessageRole(agentMsg),
          content,
          contentHash: hash,
          tokenCount: estimateTokens(content),
        });

        // Update context items
        const existingItems = store.getContextItems(conversationId);
        store.replaceContextItems(conversationId, [
          ...existingItems.map((item, i) => ({
            ordinal: i,
            itemType: item.item_type as "message" | "summary",
            messageId: item.message_id ?? undefined,
            summaryId: item.summary_id ?? undefined,
          })),
          {
            ordinal: existingItems.length,
            itemType: "message" as const,
            messageId,
          },
        ]);
      }
    } catch (err) {
      logger.warn(
        {
          err,
          hint: "DAG ingest error; will reconcile on next transformContext",
          errorKind: "dependency" as const,
        },
        "DAG ingest failed",
      );
    }

    return result;
  };
}

// ---------------------------------------------------------------------------
// Section 4: DAG Context Engine Factory
// ---------------------------------------------------------------------------

/**
 * Per-layer circuit breaker for the DAG engine (same logic as pipeline engine).
 */
function createDagCircuitBreaker(
  threshold: number,
  logger: ComisLogger,
) {
  const state = new Map<string, { failures: number; disabled: boolean }>();

  function getOrCreate(name: string) {
    let entry = state.get(name);
    if (!entry) {
      entry = { failures: 0, disabled: false };
      state.set(name, entry);
    }
    return entry;
  }

  return {
    isDisabled(layerName: string): boolean {
      return getOrCreate(layerName).disabled;
    },
    recordSuccess(layerName: string): void {
      getOrCreate(layerName).failures = 0;
    },
    recordFailure(layerName: string): void {
      const entry = getOrCreate(layerName);
      entry.failures++;
      if (entry.failures >= threshold) {
        entry.disabled = true;
        logger.warn(
          {
            layerName,
            consecutiveFailures: entry.failures,
            hint: `DAG layer disabled after ${entry.failures} consecutive failures; will remain disabled for this session`,
            errorKind: "dependency" as const,
          },
          "DAG context engine layer circuit breaker tripped",
        );
      }
    },
  };
}

/**
 * Run a single DAG layer with error isolation and circuit breaker.
 */
async function runDagLayer(
  layer: ContextLayer,
  messages: AgentMessage[],
  budget: TokenBudget,
  breaker: ReturnType<typeof createDagCircuitBreaker>,
  logger: ComisLogger,
): Promise<{ messages: AgentMessage[]; durationMs: number; errored: boolean }> {
  if (breaker.isDisabled(layer.name)) {
    return { messages, durationMs: 0, errored: false };
  }

  const start = Date.now();
  try {
    const result = await layer.apply(messages, budget);
    breaker.recordSuccess(layer.name);
    const durationMs = Date.now() - start;
    logger.debug(
      { layerName: layer.name, messagesIn: messages.length, messagesOut: result.length, durationMs },
      "DAG context engine layer applied",
    );
    return { messages: result, durationMs, errored: false };
  } catch (err) {
    breaker.recordFailure(layer.name);
    const durationMs = Date.now() - start;
    logger.warn(
      {
        layerName: layer.name,
        err,
        durationMs,
        hint: `DAG layer '${layer.name}' failed; continuing with unmodified context`,
        errorKind: "dependency" as const,
      },
      "DAG context engine layer error",
    );
    return { messages, durationMs, errored: true };
  }
}

/**
 * Create a DAG-mode context engine.
 *
 * Returns a ContextEngine with a transformContext that runs:
 * 1. Reconciliation (JSONL -> DAG import for crash recovery)
 * 2. Optional compaction check
 * 3. DAG-specific layers (thinking cleaner, assembler, annotator)
 *
 * This is a separate factory -- the pipeline engine is NOT modified.
 *
 * @param config - Context engine configuration
 * @param deps - DAG-specific dependencies (extends ContextEngineDeps)
 * @returns ContextEngine with DAG-aware transformContext
 */
export function createDagContextEngine(
  config: ContextEngineConfig,
  deps: DagContextEngineDeps,
): ContextEngine {
  const model = deps.getModel();
  const breaker = createDagCircuitBreaker(LAYER_CIRCUIT_BREAKER_THRESHOLD, deps.logger);

  // Build DAG-specific layers
  const layers: ContextLayer[] = [];

  // Thinking block cleaner (same condition as pipeline)
  if (model.reasoning) {
    layers.push(createThinkingBlockCleaner(config.thinkingKeepTurns));
  }

  // DAG assembler: fetches from store, applies budget-aware selection
  const systemTokensEstimate = deps.getSystemTokensEstimate?.() ?? 0;
  const budget = computeTokenBudget(model.contextWindow, systemTokensEstimate);
  layers.push(
    createDagAssemblerLayer(
      {
        freshTailTurns: deps.dagCompactionConfig?.freshTailTurns ?? 3,
        availableHistoryTokens: budget.availableHistoryTokens,
      },
      {
        store: deps.contextStore,
        logger: deps.logger,
        conversationId: deps.conversationId,
        estimateTokens: deps.estimateTokens,
      },
    ),
  );

  // DAG annotator: replaces old tool results with placeholders
  const annotationKeepWindow = config.observationKeepWindow ?? 25;
  const annotationTriggerChars = config.observationTriggerChars ?? 120_000;
  const ephemeralAnnotationKeepWindow = config.ephemeralKeepWindow;
  layers.push(
    createDagAnnotatorLayer(
      { annotationKeepWindow, annotationTriggerChars, ephemeralAnnotationKeepWindow },
      { estimateTokens: deps.estimateTokens },
    ),
  );

  deps.logger.info(
    {
      conversationId: deps.conversationId,
      layerCount: layers.length,
      version: "dag",
    },
    "DAG context engine active",
  );

  const engine: ContextEngine = {
    lastTrimOffset: 0,
    async transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
      const pipelineStart = Date.now();

      // Step 1: Reconciliation (before any layers)
      const reconcileResult = reconcileJsonlToDag(
        messages,
        deps.contextStore,
        deps.db,
        deps.conversationId,
        deps.estimateTokens,
        deps.logger,
      );

      deps.logger.debug(
        {
          conversationId: reconcileResult.conversationId,
          imported: reconcileResult.imported,
          fullImport: reconcileResult.fullImport,
          durationMs: reconcileResult.durationMs,
        },
        "DAG reconciliation complete",
      );

      // Run integrity check if imports occurred or full import (mode switch)
      if (reconcileResult.imported > 0 || reconcileResult.fullImport) {
        const integrityDeps: IntegrityCheckDeps = {
          store: deps.contextStore,
          db: deps.db,
          logger: deps.logger,
          eventBus: deps.eventBus as IntegrityCheckDeps["eventBus"],
          agentId: deps.agentId ?? "",
          sessionKey: deps.sessionKey ?? "",
        };
        const integrityReport = checkIntegrity(integrityDeps, deps.conversationId);
        deps.logger.debug(
          {
            conversationId: deps.conversationId,
            issueCount: integrityReport.issues.length,
            repairsApplied: integrityReport.repairsApplied,
            durationMs: integrityReport.durationMs,
          },
          "DAG integrity check after reconciliation",
        );
      }

      // Step 2: Compaction check (if configured)
      if (deps.dagCompactionConfig && deps.dagCompactionDeps) {
        const sysTokens = deps.getSystemTokensEstimate?.() ?? 0;
        const currentBudget = computeTokenBudget(deps.getModel().contextWindow, sysTokens);
        const needsCompaction = shouldCompact(
          deps.contextStore,
          deps.conversationId,
          { contextThreshold: deps.dagCompactionConfig.contextThreshold },
          currentBudget,
        );
        if (needsCompaction) {
          try {
            const fullDeps = {
              ...deps.dagCompactionDeps,
              store: deps.contextStore,
              logger: deps.logger,
            };
            await runDagCompaction(
              deps.conversationId,
              deps.dagCompactionConfig,
              fullDeps,
            );
          } catch (err) {
            deps.logger.warn(
              {
                err,
                conversationId: deps.conversationId,
                hint: "DAG compaction failed; continuing without compaction",
                errorKind: "dependency" as const,
              },
              "DAG compaction error",
            );
          }
        }
      }

      // Step 3: Run DAG layers
      const currentModel = deps.getModel();
      const dagSysTokens = deps.getSystemTokensEstimate?.() ?? 0;
      const currentBudget = computeTokenBudget(currentModel.contextWindow, dagSysTokens);
      let result = messages;
      let layerErrors = 0;
      const layerTimings: Array<{ name: string; durationMs: number }> = [];

      for (const layer of layers) {
        const outcome = await runDagLayer(layer, result, currentBudget, breaker, deps.logger);
        result = outcome.messages;
        layerTimings.push({ name: layer.name, durationMs: outcome.durationMs });
        if (outcome.errored) layerErrors++;
      }

      const durationMs = Date.now() - pipelineStart;

      // Emit context:pipeline event for consistency with pipeline engine
      if (deps.eventBus) {
        deps.eventBus.emit("context:pipeline", {
          agentId: deps.agentId ?? "",
          sessionKey: deps.sessionKey ?? "",
          tokensLoaded: 0,
          tokensEvicted: 0,
          tokensMasked: 0,
          tokensCompacted: 0,
          thinkingBlocksRemoved: 0,
          budgetUtilization: 0,
          evictionCategories: {},
          rereadCount: 0,
          rereadTools: [],
          sessionDepth: 0,
          sessionToolResults: 0,
          cacheHitTokens: 0,
          cacheWriteTokens: 0,
          cacheMissTokens: 0,
          durationMs,
          layerCount: layers.length,
          layers: layerTimings.map(t => ({ ...t, messagesIn: 0, messagesOut: 0 })),
          timestamp: Date.now(),
        });
      }

      // DEBUG summary: fires N times per request (demoted from INFO)
      deps.logger.debug(
        {
          conversationId: deps.conversationId,
          reconciled: reconcileResult.imported,
          layerCount: layers.length,
          layerErrors,
          durationMs,
          version: "dag",
        },
        "DAG context engine pipeline complete",
      );

      return result;
    },
  };

  return engine;
}
