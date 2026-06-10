// SPDX-License-Identifier: Apache-2.0
/**
 * LCD→LTM distillation runner (Phase 172, DIST-01..04).
 *
 * Fires after `store.appendCondensedSummary` returns a summaryId (via the
 * `onCondensed` callback seam on `lcd-condense-trigger.ts`). Gate-heavy,
 * fail-closed write path: validates, deduplicates, then writes an episodic
 * "learned" memory row + a provenance row + queues an embedding. Walks the
 * LCD DAG BFS to mark descendant provenance rows superseded (pyramid rule).
 *
 * Architecture cut (agent↛memory): this module imports ONLY TYPE-only ports
 * from @comis/core and agent-side helpers. It NEVER imports @comis/memory.
 * The concrete ContextStorePort and MemoryPort implementations are daemon-injected.
 * It NEVER logs summary content — ids/counts/durations/errorKinds only (T-130-09).
 *
 * @module
 */

import type {
  ContextStorePort,
  ContextStoreScope,
  ComisLogger,
  ErrorKind,
  TypedEventBus,
  MemoryPort,
  AppendProvenanceInput,
  SessionKey,
} from "@comis/core";
import { validateMemoryWrite } from "@comis/core";
import { randomUUID } from "node:crypto";
import {
  LEAF_FALLBACK_SUMMARY_MARKER,
  CONDENSED_FALLBACK_SUMMARY_MARKER,
} from "../context-engine/constants.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parameters for one distillation pass after a condense turn.
 *
 * The `deps` object is injected at the call site (executor-post-execution.ts)
 * from the daemon's composition root — the runner never resolves concrete
 * adapters itself (agent↛memory cut).
 */
export interface RunDistillationPassParams {
  /** The summaryId returned by store.appendCondensedSummary — the hook point. */
  summaryId: string;
  /** SECURITY scope columns (conversationId/tenantId/agentId/sessionKey). */
  scope: ContextStoreScope;
  /** The condensed summary text (NEVER logged by this module). */
  content: string;
  /** True ⇒ content is a deterministic truncation, not a real summary. */
  fallback: boolean;
  /** Condense depth (0 = leaf, 1+ = condensed). */
  depth: number;
  /** Injected wall-clock epoch milliseconds (NEVER Date.now() directly). */
  now: number;
  deps: {
    /** Memory write port (daemon-injected concrete adapter). */
    memoryPort: MemoryPort;
    /** LCD context store port (daemon-injected concrete adapter). */
    lcdStore: ContextStorePort;
    /** Fire-and-forget embedding queue. Optional — absent ⇒ no embedding. */
    embeddingEnqueue?: (entryId: string, content: string) => void;
    /** Logger — content-free, ids/counts/errorKinds only. */
    logger: ComisLogger;
    /** Optional event bus for observable skip + complete events. */
    eventBus?: TypedEventBus;
    /** Distillation config block from config.contextEngine.memory.distillFromLcd. */
    distillConfig?: {
      enabled: boolean;
      minDepth?: number;
      dedupCosineThreshold?: number;
    };
    /** Capability class of the model that produced the summary. */
    modelProfile?: { capabilityClass: "frontier" | "mid" | "small" | "nano" };
    /** When set, allows small/nano models to distill (override the weak-model gate). */
    strongerSummarizerModel?: string;
    /** True when this is a subagent or ephemeral session — distillation is skipped. */
    isSubagentSession: boolean;
  };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Non-fatal distillation pass (T-130-07 pattern). Gate-heavy; returns early on
 * every gate miss. The outer try/catch degrades the ENTIRE pass to a WARN on
 * unexpected failure — the live turn is NEVER affected.
 */
export async function runDistillationPassAfterTurn(params: RunDistillationPassParams): Promise<void> {
  const { summaryId, scope, content, fallback, depth, now, deps } = params;

  // GATE 1: R4 fail-closed — incomplete scope → return without any write.
  // An empty agentId, tenantId, or conversationId is a misconfigured session;
  // never write cross-scope memory rows from an unknown scope.
  if (!scope.tenantId || !scope.agentId || !scope.conversationId) {
    return;
  }

  // GATE 2: fallback-marker gate — LEAF_FALLBACK or CONDENSED_FALLBACK content
  // are deterministic truncations, not real abstractions. Never distill them.
  if (
    fallback ||
    content.startsWith(LEAF_FALLBACK_SUMMARY_MARKER) ||
    content.startsWith(CONDENSED_FALLBACK_SUMMARY_MARKER)
  ) {
    deps.eventBus?.emit("memory:distillation_skipped", {
      reason: "fallback_marker",
      summaryId,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    });
    return;
  }

  // GATE 3: subagent gate — subagent and ephemeral sessions produce intermediate
  // results not suitable for long-term memory.
  if (deps.isSubagentSession) {
    deps.eventBus?.emit("memory:distillation_skipped", {
      reason: "subagent_session",
      summaryId,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    });
    return;
  }

  // GATE 4: config gate — silent fast-path when distillation is disabled.
  // This is normal operation (default OFF) — no event emitted (avoids noise
  // on every turn for configurations that haven't opted in).
  if (!deps.distillConfig?.enabled) {
    return;
  }

  // GATE 5: depth gate — only distill at the configured minimum depth.
  const minDepth = deps.distillConfig?.minDepth ?? 1;
  if (depth < minDepth) {
    deps.eventBus?.emit("memory:distillation_skipped", {
      reason: "depth_below_min",
      summaryId,
      depth,
      minDepth,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    });
    return;
  }

  // GATE 6: weak-model gate — small/nano without a strongerSummarizerModel
  // configured → auto-disable distillation. Observable INFO (not WARN — this is
  // expected in mixed-model configs). The operator can override by setting
  // strongerSummarizerModel.
  const capabilityClass = deps.modelProfile?.capabilityClass;
  if (
    (capabilityClass === "small" || capabilityClass === "nano") &&
    !deps.strongerSummarizerModel
  ) {
    deps.logger.info(
      {
        step: "distillation_gate",
        reason: "weak_model_no_override",
        capabilityClass,
        summaryId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        hint: "distillation auto-disabled: configure strongerSummarizerModel to enable for this model class",
      },
      "LCD distillation skipped",
    );
    deps.eventBus?.emit("memory:distillation_skipped", {
      reason: "weak_model_no_override",
      summaryId,
      capabilityClass,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    });
    return;
  }

  // All gates passed — enter the write path (non-fatal).
  try {
    // GATE 7: validateMemoryWrite (secret-egress firewall — mirrors
    // storePairedConversationMemory:496-511 EXACTLY). A non-clean verdict
    // (secret OR dangerous/suspicious pattern) SKIPS the write — the learned-trust
    // distilled memory has no reduced-weight tier, so "warn" is skipped like
    // "critical". The skip is CONTENT-FREE: never log the content or matched text.
    const verdict = validateMemoryWrite(content);
    if (verdict.severity !== "clean") {
      deps.logger.warn(
        {
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          severity: verdict.severity,
          // Pattern-source tags only (e.g. "secret-egress-guard") — NEVER the
          // matched secret text. The verdict carries source names, not content.
          patterns: verdict.patterns,
          hint: "LCD distillation skipped: condensed summary matched a secret/dangerous/suspicious pattern",
          errorKind: "validation" as ErrorKind,
        },
        "LCD distillation skipped: failed the memory-write security scan",
      );
      return;
    }

    // GATE 8: dedup check (DIST-02) — cosine when vec present, FTS/lexical fallback.
    // Uses memoryPort.search with a SessionKey scoped to the agent for R4 isolation.
    // The SessionKey carries tenantId + agentId so search returns ONLY this agent's
    // memories (not cross-agent or cross-tenant rows).
    const dedupThreshold = deps.distillConfig?.dedupCosineThreshold ?? 0.92;
    // Construct a synthetic SessionKey from the ContextStoreScope. The search
    // path uses tenantId + agentId for row filtering; userId and channelId are
    // required fields so we use the agentId as a stable proxy channel identifier.
    const searchSessionKey: SessionKey = {
      tenantId: scope.tenantId,
      userId: scope.agentId,         // stable tenant-agent scoping identity
      channelId: scope.conversationId, // scopes to this conversation's memories
      agentId: scope.agentId,
    };
    const searchResult = await deps.memoryPort.search(
      searchSessionKey,
      content,
      { limit: 1, minScore: dedupThreshold },
    );
    if (searchResult.ok && searchResult.value.length > 0) {
      const topScore = searchResult.value[0]?.score ?? 0;
      if (topScore >= dedupThreshold) {
        deps.eventBus?.emit("memory:distillation_skipped", {
          reason: "near_duplicate",
          summaryId,
          score: topScore,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
        });
        return;
      }
    }

    // STEP 9: WRITE — store the distilled episodic memory row.
    const entryId = randomUUID();
    const storeResult = await deps.memoryPort.store({
      id: entryId,
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      userId: scope.tenantId, // distillation writes at the tenant scope (§14)
      content,
      trustLevel: "learned",    // LOCKED: §14 decision 2
      memoryType: "episodic",    // LOCKED: §14 decision 2
      source: {
        who: "lcd_distillation",
        sessionKey: scope.sessionKey,
      },
      tags: ["lcd_distilled", `depth:${depth}`],
      createdAt: now,
    });
    if (!storeResult.ok) {
      deps.logger.warn(
        {
          err: storeResult.error.message,
          summaryId,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          hint: "LCD distillation memory write failed; check database connectivity and disk space",
          errorKind: "dependency" as ErrorKind,
        },
        "LCD distillation store write failed",
      );
      return;
    }

    // STEP 10: EMBED — fire-and-forget (non-blocking; the embedding queue retries).
    deps.embeddingEnqueue?.(entryId, content);

    // STEP 11: PROVENANCE — link the distilled memory to its LCD source summary.
    // Optional method gate (172-03 adds the concrete SQL impl; 172-02 calls via ?.).
    const provenanceInput: AppendProvenanceInput = {
      provenanceId: randomUUID(),
      memoryId: entryId,
      summaryId,
      sourceSessionKey: scope.sessionKey,
      conversationId: scope.conversationId,
      agentId: scope.agentId,
      tenantId: scope.tenantId,
      createdAt: now,
    };
    deps.lcdStore.appendProvenance?.(provenanceInput);

    // STEP 12: SUPERSESSION BFS — mark descendant provenance rows superseded by
    // the new distilled memory (pyramid rule). Do NOT walk the rootSummaryId
    // itself — only its descendants. See markDescendantsSuperseded below.
    await markDescendantsSuperseded(summaryId, entryId, scope, deps);

    // STEP 13: emit completion event (content-free, ids/counts/depth only).
    deps.eventBus?.emit("memory:distillation_complete", {
      summaryId,
      memoryId: entryId,
      depth,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    });
  } catch (err) {
    // Non-fatal (T-130-07): any failure degrades to a WARN + return — the live
    // turn is NEVER affected. errorKind "dependency" (store/queue failure).
    deps.logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        summaryId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        hint: "LCD distillation failed; the turn is unaffected — check the memory store and LCD store connectivity",
        errorKind: "dependency" as ErrorKind,
      },
      "LCD distillation failed (non-fatal)",
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * BFS over the LCD condensed DAG, marking each DESCENDANT provenance row as
 * superseded by the new distilled memory. Does NOT walk the rootSummaryId
 * itself (the new memory IS the superseder; only existing distilled memories
 * whose summaryId appears in the descendant set are superseded).
 *
 * Non-fatal: if the BFS or any mark call throws, it is caught by the outer
 * try/catch in runDistillationPassAfterTurn.
 */
async function markDescendantsSuperseded(
  rootSummaryId: string,
  supersededByMemoryId: string,
  scope: ContextStoreScope,
  deps: {
    lcdStore: ContextStorePort;
    logger: ComisLogger;
  },
): Promise<void> {
  // BFS — never revisit a summaryId (cycle guard).
  const visited = new Set<string>();
  const queue: string[] = [rootSummaryId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    // getSummaryChildren is synchronous (better-sqlite3).
    const children = deps.lcdStore.getSummaryChildren(scope, id);
    for (const child of children) {
      // markProvenanceSuperseded is optional (172-03 adds concrete SQL impl).
      deps.lcdStore.markProvenanceSuperseded?.(child.summaryId, supersededByMemoryId);
      queue.push(child.summaryId);
    }
  }
}
