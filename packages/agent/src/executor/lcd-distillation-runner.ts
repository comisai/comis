// SPDX-License-Identifier: Apache-2.0
/**
 * LCD→LTM distillation runner.
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
 * It NEVER logs summary content — ids/counts/durations/errorKinds only.
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
    /**
     * Optional injected clock CALLABLE for the write-path completion
     * timing (entry → emit two reads → durationMs). Bound to the daemon's
     * ClockPort — NEVER Date.now(). Absent ⇒ durationMs is omitted from the INFO
     * line (timing degrades, the pass still runs).
     */
    nowFn?: () => number;
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
 * Non-fatal distillation pass. Gate-heavy; returns early on
 * every gate miss. The outer try/catch degrades the ENTIRE pass to a WARN on
 * unexpected failure — the live turn is NEVER affected.
 */
export async function runDistillationPassAfterTurn(params: RunDistillationPassParams): Promise<void> {
  const { summaryId, scope, content, fallback, depth, now, deps } = params;

  // GATE 1: fail-closed scope isolation — incomplete scope → return without any write.
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
  // Time the whole write boundary via the injected clock (entry read);
  // the completion read happens at the INFO line below. `now` is the entry value
  // when no clock callable is injected (durationMs then degrades to 0/omitted).
  const startMs = deps.nowFn ? deps.nowFn() : now;
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
      // Emit the documented reason:"validation" skip so the
      // security-relevant secret-egress block is system-observable (consistent
      // with every other gate). CONTENT-FREE: ids/agentId/sessionKey only —
      // NEVER the matched secret text or the verdict patterns.
      deps.eventBus?.emit("memory:distillation_skipped", {
        reason: "validation",
        summaryId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
      });
      return;
    }

    // GATE 8: dedup check — cosine when vec present, FTS/lexical fallback.
    // Agent read-isolation: SqliteMemoryAdapter.search() filters rows by
    // sessionKey.tenantId for the TENANT boundary, but applies the load-bearing
    // `agent_id = ?` AGENT predicate ONLY when options.agentId is set (it ignores
    // sessionKey.agentId/.userId/.channelId entirely). So the agent filter MUST
    // ride in the options object — passing it on the SessionKey alone is a no-op
    // and would let a different agent's near-duplicate in the same tenant suppress
    // this agent's write (a cross-agent dedup false positive + a read-isolation gap).
    const dedupThreshold = deps.distillConfig?.dedupCosineThreshold ?? 0.92;
    // The SessionKey only carries the tenant filter into search(); userId and
    // channelId are required-by-type fields the adapter does NOT consume here.
    const searchSessionKey: SessionKey = {
      tenantId: scope.tenantId,
      userId: scope.agentId, // unused by search() — kept only to satisfy the type
      channelId: scope.conversationId, // unused by search()
      agentId: scope.agentId, // unused by search() — the real filter is the option below
    };
    const searchResult = await deps.memoryPort.search(
      searchSessionKey,
      content,
      { limit: 1, minScore: dedupThreshold, agentId: scope.agentId }, // <-- the actual agent-isolation filter
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
      userId: scope.tenantId, // distillation writes at the tenant scope (deliberate: not per-user)
      content,
      trustLevel: "learned",    // LOCKED: distilled rows always carry learned trust
      memoryType: "episodic",    // LOCKED: distilled rows are always episodic
      source: {
        who: "lcd_distillation",
        sessionKey: scope.sessionKey,
      },
      // The summary:<id> tag keys the recall
      // provenance pass's PROVENANCE-PRECISE branch (recall-provenance.ts:88,
      // SUMMARY_TAG_PREFIX="summary:") so it can query getProvenanceForSummary for
      // the EXACT linked memoryIds this distilled summary subsumes. It adds an id
      // only — NO content ever rides in a tag.
      tags: ["lcd_distilled", `depth:${depth}`, `summary:${summaryId}`],
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
    // Optional method gate — the concrete SQL impl is daemon-wired and may be absent.
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
    if (deps.lcdStore.appendProvenance == null) {
      // A write occurred but provenance cannot be linked (a realistic
      // partial-wire: memoryPort present, appendProvenance not implemented). Do
      // NOT silently optional-chain past it — surface it so an operator can see
      // the distilled memory has no provenance row (recall down-weighting will be
      // unavailable for it). DEBUG (not WARN): the memory write itself succeeded.
      deps.logger.debug(
        {
          summaryId,
          memoryId: entryId,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          errorKind: "precondition" as ErrorKind,
          hint: "lcdStore.appendProvenance not implemented — provenance row skipped (recall down-weighting unavailable for this memory); wire the concrete LCD provenance write adapter",
        },
        "LCD distillation provenance write skipped (no impl)",
      );
    } else {
      deps.lcdStore.appendProvenance(provenanceInput);
    }

    // STEP 12: SUPERSESSION BFS — mark descendant provenance rows superseded by
    // the new distilled memory (pyramid rule). Do NOT walk the rootSummaryId
    // itself — only its descendants. See markDescendantsSuperseded below.
    await markDescendantsSuperseded(summaryId, entryId, scope, deps);

    // STEP 13: completion — an INFO line carrying durationMs (the §2.7
    // boundary-completion requirement) — content-free, ids/depth only — PLUS the
    // bus event. durationMs is from the injected clock (nowFn); 0 when no clock
    // callable was injected (timing degrades, never Date.now()).
    const durationMs = (deps.nowFn ? deps.nowFn() : now) - startMs;
    deps.logger.info(
      {
        step: "distillation",
        summaryId,
        memoryId: entryId,
        depth,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        durationMs,
      },
      "LCD distillation memory persisted",
    );
    deps.eventBus?.emit("memory:distillation_complete", {
      summaryId,
      memoryId: entryId,
      depth,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    });
  } catch (err) {
    // Non-fatal: any failure degrades to a WARN + return — the live
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
  // Mirror the appendProvenance sibling (STEP 11) — do NOT
  // silently optional-chain past a missing markProvenanceSuperseded. Branch on
  // `== null` ONCE (the method ref is stable) and emit a content-free DEBUG so a
  // realistic partial-wire (appendProvenance present, markProvenanceSuperseded not)
  // is diagnosable: without the mark, descendant provenance rows are never superseded
  // and the recall down-weighting will double-count across condense levels. The BFS's
  // ONLY side effect is the mark call, so when it is absent the whole walk is a no-op —
  // skip it after the single DEBUG (one signal, not per-node spam; the §2.7 N→aggregate
  // discipline). DEBUG (not WARN): the memory write + provenance link already succeeded.
  const markFn = deps.lcdStore.markProvenanceSuperseded;
  if (markFn == null) {
    deps.logger.debug(
      {
        rootSummaryId,
        memoryId: supersededByMemoryId,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        errorKind: "precondition" as ErrorKind,
        hint: "lcdStore.markProvenanceSuperseded not implemented — descendant provenance rows NOT superseded (recall down-weighting may double-count across condense levels); wire the concrete LCD provenance supersession adapter",
      },
      "LCD distillation supersession skipped (no impl)",
    );
    return;
  }

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
      // Thread scope.tenantId/agentId — the UPDATE is tenant+agent-scoped fail-closed.
      // markFn is proven non-null above, so no optional-chain here.
      markFn(child.summaryId, supersededByMemoryId, scope.tenantId, scope.agentId);
      queue.push(child.summaryId);
    }
  }
}
