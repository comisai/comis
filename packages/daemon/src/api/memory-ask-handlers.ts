// SPDX-License-Identifier: Apache-2.0
/**
 * The memory.ask (dialectic) RPC handler — extracted from memory-handlers.ts
 * to keep that module under the 800-line production cap after the 2026-06-11
 * live-fix wave (reason-coded abstains, real SessionKey recall scope, dated
 * grounding lines).
 *
 * @module
 */

import {
  MemoryAskContract,
  parseFormattedSessionKey,
  systemDateFrom,
  systemGetEnv,
  systemNowMs,
  tryGetContext,
  wrapExternalContent,
} from "@comis/core";
import type { SessionKey } from "@comis/core";
import { assembleSynthesis, citationChains, orderByTrust, sanitizeToolOutput } from "@comis/agent";
import type { RpcHandler } from "./types.js";
import type { MemoryApiDeps as MemoryHandlerDeps } from "./types.js";
import { stripInternalFields } from "@comis/core";

/** Default cap on the dialectic grounding-set size when the request omits `limit`
 *  and no per-agent `dialectic.maxRecall` is threaded (mirrors the schema default). */
const DIALECTIC_DEFAULT_MAX_RECALL = 10;

/** The mandatory-abstention sentinel — the explicit { abstained: true } signal
 *  (never inferred from an empty answer); matches MemoryAskContract + assembleSynthesis. */
const ABSTAIN_SENTINEL = { answer: "", citations: [] as string[], abstained: true } as const;

// -----------------------------------------------------------------------
// memory.ask — the dialectic. The KEYSTONE: a
// grounded, cited NL answer over the agent's LLM-free recall pipeline. Runs the
// FULL createMemoryRecall (the injected `buildDialecticRecall`) — NEVER
// `deps.memoryApi.search`, which bypasses the TRUST FILTER (the documented trap).
// Recall trust-FILTERS but returns RAW `entry.content`; redaction/sanitization is
// THIS handler's job (mirroring rag-retriever, never inside recall). Empty recall
// ⇒ abstain in CODE WITHOUT the seam (Pitfall 5). Else: order trust-first
// (orderByTrust) → the SAME neutralization rag-retriever uses (sanitizeToolOutput
// + wrapExternalContent) → clamp to the per-agent dialectic.maxRecall DoS bound →
// the ONE injected query-time seam → assembleSynthesis (abstain-in-code + citations
// VALIDATED ⊆ recalled ids). The citation→sourceId chain (counts/ids-only)
// for the recall-trace. Logging is counts/ids-ONLY — never the question, the
// recalled content, or the answer.
// -----------------------------------------------------------------------
export function bindMemoryAskHandler(deps: MemoryHandlerDeps): Record<string, RpcHandler> {
  return {
    [MemoryAskContract.method]: async (rawParams) => {
      const askStart = systemNowMs();
      // Scope is read PRE-strip (mirrors search_files + context.recall): the
      // dispatcher injects `_agentId` + `_callerSessionKey` on the agent tool
      // path; an external RPC caller (CLI / web dashboard / operator WS) has
      // no `_agentId`, so it falls back to the DEFAULT agent — live finding
      // 2026-06-11: without the fallback every external memory.ask call
      // silently returned the bare abstain sentinel while the chat path
      // recalled the same fact fine. No widening beyond existing token
      // authority: memory.search serves the same rpc scope tenant-wide.
      const agentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
      const callerSessionKey = rawParams._callerSessionKey as string | undefined;
      const userParams = stripInternalFields(rawParams);
      const params = MemoryAskContract.request.parse(userParams);
      const question = params.question;

      // Graceful abstain when the dialectic is not wired (no key / seam not
      // applied) or no agent scope is resolvable — never throws. Each branch
      // carries a distinct `reason` + an INFO log so an infrastructure absence
      // is never disguised as a semantic "no data" abstain (live finding
      // 2026-06-11: all branches returned the identical bare sentinel with
      // ZERO log lines — undiagnosable without reading the wiring).
      if (deps.dialecticSeam === undefined || deps.buildDialecticRecall === undefined || agentId === undefined) {
        const reason = agentId === undefined ? "no_agent_scope" : "dialectic_unavailable";
        deps.logger?.info(
          {
            agentId,
            step: "dialectic" as const,
            durationMs: systemNowMs() - askStart,
            abstained: true,
            reason,
            hint:
              reason === "dialectic_unavailable"
                ? "memory.ask abstained because the dialectic seam is not wired — check dialectic.enabled / memory.enabled and the agent's provider key"
                : "memory.ask abstained because no agent scope was resolvable (no _agentId and no defaultAgentId)",
          },
          "memory.ask abstained (dialectic unavailable)",
        );
        const sentinel = { ...ABSTAIN_SENTINEL, reason };
        if (systemGetEnv("NODE_ENV") !== "production") {
          MemoryAskContract.response.parse(sentinel);
        }
        return sentinel;
      }

      // Run the FULL createMemoryRecall (trust-FILTERED; content is RAW — this handler
      // sanitizes + wraps it below, NOT recall) — NOT memoryApi.search. The factory builds
      // a per-agent orchestrator with the daemon's store set + the agent's RagConfig.
      //
      // The recall scope MUST be a real SessionKey OBJECT (live finding
      // 2026-06-11): the previous `(callerSessionKey ?? "") as unknown as
      // SessionKey` smuggled a STRING, so `sessionKey.tenantId` was undefined
      // and the adapter's tenant-scoped hydration matched NOTHING — every
      // memory.ask, on every caller path, abstained with an empty recall.
      // Parse the dispatcher-injected formatted key when present; otherwise a
      // synthetic key carrying the daemon tenant (the only field search scopes by).
      const recallScope: SessionKey =
        (callerSessionKey !== undefined ? parseFormattedSessionKey(callerSessionKey) : undefined) ?? {
          tenantId: deps.tenantId,
          userId: "memory-ask",
          channelId: "rpc",
        };
      const recall = deps.buildDialecticRecall(agentId);
      const recalled = await recall.recall(question, recallScope, agentId);

      // Empty / failed recall ⇒ abstain in CODE, WITHOUT calling the seam
      // (Pitfall 5 — no grounding ⇒ no LLM call, no fabricated answer).
      if (!recalled.ok || recalled.value.length === 0) {
        deps.logger?.info(
          { agentId, step: "dialectic" as const, durationMs: systemNowMs() - askStart, abstained: true, reason: "empty_recall", citationCount: 0 },
          "memory.ask abstained (empty recall)",
        );
        const sentinel = { ...ABSTAIN_SENTINEL, reason: "empty_recall" };
        if (systemGetEnv("NODE_ENV") !== "production") {
          MemoryAskContract.response.parse(sentinel);
        }
        return sentinel;
      }

      // Trust-first ordering BEFORE building the grounding (the HARD boundary —
      // the higher-trust claim is presented first; a lower-trust contradiction
      // never blends in).
      const ordered = orderByTrust(recalled.value);

      // ENFORCE the per-agent `dialectic.maxRecall` as the HARD ceiling (the DoS bound
      // on the synthesis LLM input) and VALIDATE the caller-controlled `limit`. The contract
      // now types `limit` as a positive int, but defense-in-depth here so a non-int / huge /
      // negative value (or a caller that bypasses the contract parse) can never:
      //   - flood the prompt: `limit: 100000` is clamped DOWN to the configured ceiling, and
      //   - negative-slice: `limit: -5` would make `slice(0, -5)` silently drop the LAST 5
      //     (lowest-trust) items — so a non-positive/non-int `limit` falls back to the ceiling.
      const ceiling = deps.dialecticMaxRecall?.(agentId) ?? DIALECTIC_DEFAULT_MAX_RECALL;
      const requested = params.limit;
      const cap =
        typeof requested === "number" && Number.isInteger(requested) && requested > 0
          ? Math.min(requested, ceiling)
          : ceiling;
      const grounding = ordered.slice(0, cap);

      // Build the grounding text from the ordered survivors. createMemoryRecall returns
      // trust-FILTERED but RAW `entry.content` — redaction is the PROMPT-ASSEMBLY step's job,
      // NOT recall's (rag-retriever.ts applies it downstream; recall never does). So this
      // handler MUST apply the SAME two-layer neutralization rag-retriever.ts:57-70 runs, in
      // the SAME order, before the ONE query-time LLM (the seam) sees it:
      //   (1) sanitizeToolOutput — NFKC-normalize + strip zero-width/tag-block bypass chars,
      //       then redact the INSTRUCTION_PATTERNS set ([SYSTEM]/[INST]/"ignore previous
      //       instructions"/role markers/…) to [REDACTED]. Applied to ALL trust levels
      //       (incl. system, matching the retriever's sanitize-before-system-skip), so an
      //       indirect prompt-injection in a hostile external/learned memory is neutralized
      //       on this surface — no weaker than every other place recalled content reaches an
      //       LLM in the codebase.
      //   (2) wrapExternalContent — delimiter-fence NON-system content (random
      //       <<<UNTRUSTED_…>>> markers + the EXTERNAL_CONTENT_WARNING security notice via
      //       includeWarning:true) and surface suspicious-pattern telemetry
      //       (onSuspiciousContent). System content is already trusted ⇒ skip the wrap (the
      //       retriever's skip-system rule), but it is STILL sanitized in (1).
      // The `[id]` fence sits OUTSIDE the wrapped region, so a forged `[<other-id>]`
      // smuggled in a memory's CONTENT lands INSIDE the warned <<<UNTRUSTED_…>>> fence — the
      // model is explicitly told that region is untrusted data, and the final `citations`
      // array is independently validated ⊆ recalled ids in code (assembleSynthesis), so a
      // smuggled label can neither forge a citation nor masquerade as a trusted id line.
      const groundingText = grounding
        .map((r) => {
          const sanitized = sanitizeToolOutput(r.entry.content);
          const safe =
            r.entry.trustLevel === "system"
              ? sanitized
              : wrapExternalContent(sanitized, {
                  source: "api",
                  includeWarning: true,
                  ...(deps.onSuspiciousContent !== undefined
                    ? { onSuspiciousContent: deps.onSuspiciousContent }
                    : {}),
                });
          // The recorded date rides OUTSIDE the untrusted fence (code-derived
          // from entry.createdAt, not memory content). Live finding
          // 2026-06-11: without it, same-trust conflicts gave the model no
          // recency signal and it resolved a date correction the WRONG way
          // (answered the stale June 20 over the updated June 25).
          const recorded = systemDateFrom(r.entry.createdAt).toISOString().slice(0, 10);
          return `[${r.entry.id}] (recorded ${recorded}) ${safe}`;
        })
        .join("\n");

      // The ONE allowed query-time LLM (the injected seam). Pass the invoking
      // agentId so the seam synthesizes with THAT agent's own cheap model/key/token bound. It
      // returns the raw parse (or abstains non-fatally); the code-level abstention + citation
      // validation run AROUND it in assembleSynthesis.
      const parsed = await deps.dialecticSeam(agentId, question, groundingText);

      // Assemble: abstain-in-code (parser-abstain / no validated citation) OR a
      // grounded answer with citations VALIDATED ⊆ the recalled ids (bogus
      // dropped). Validation runs over the SAME ordered grounding set the seam saw.
      const result = assembleSynthesis(grounding, parsed);

      // The citation→recalled-id→sourceId reasoning-tree chain (counts/
      // ids-ONLY) for the recall-trace observability surface. Empty on abstain.
      const chains = citationChains(grounding, result.abstained ? [] : result.citations);

      // The dialectic's VALIDATED citations (⊆ recalled ids — definitively
      // used) are HIGH-signal "used" attribution. Emit on the SAME event the usefulness-feedback
      // subscriber already consumes (wireMemoryUsefulness → recordUsage) — NO new event, NO new
      // subscriber. usedIds = the citations; ignoredIds = recalled ∖ citations. Guarded on
      // !result.abstained so an abstained (no grounded answer) turn never attributes a "used"
      // (Pitfall 4); the emit is fire-and-forget by the bus contract and the subscriber is
      // already non-fatal, so a usefulness-write failure can NEVER break the answer. ids/counts
      // ONLY — never the question, recalled content, or answer (AGENTS.md §2.7).
      //
      // `intent` is OMITTED here (Pitfall 2): classifyIntent is NOT exported from @comis/agent
      // — importing it would force a public-export-consumer + a daemon→agent-internal edge, and
      // the handler does not re-classify. Omitting it makes the subscriber record the GLOBAL
      // bucket; the per-intent write rides the turn-end emit (in-package).
      if (!result.abstained && deps.eventBus !== undefined) {
        const recalledIds = grounding.map((r) => r.entry.id);
        const usedSet = new Set(result.citations);
        const ignoredIds = recalledIds.filter((id) => !usedSet.has(id));
        deps.eventBus.emit("memory:recall_used", {
          agentId,
          // traceId is REQUIRED on the event — prefer the AsyncLocalStorage request
          // trace, fall back to the caller's formatted session key, then "" (mirrors
          // the turn-end emit in executor-post-execution.ts).
          traceId: tryGetContext()?.traceId ?? callerSessionKey ?? "",
          ...(callerSessionKey !== undefined ? { sessionKey: callerSessionKey } : {}),
          usedIds: result.citations,
          ignoredIds,
          usedCount: result.citations.length,
          ignoredCount: ignoredIds.length,
          timestamp: systemNowMs(),
        });
      }

      deps.logger?.info(
        {
          agentId,
          step: "dialectic" as const,
          durationMs: systemNowMs() - askStart,
          abstained: result.abstained,
          ...(result.abstained ? { reason: "synthesis_abstained" } : {}),
          groundingCount: grounding.length,
          citationCount: result.citations.length,
          // ids-only provenance counts (NEVER bodies): how many cited claims
          // carried a sourceId chain.
          chainCount: chains.length,
        },
        "memory.ask completed",
      );

      // A synthesis-level abstain (grounding existed; the seam/citation
      // validation declined) is distinguishable from the infrastructure
      // branches above — the model's judgment, not an absent dep.
      const finalResult = result.abstained ? { ...result, reason: "synthesis_abstained" } : result;
      if (systemGetEnv("NODE_ENV") !== "production") {
        MemoryAskContract.response.parse(finalResult);
      }
      return finalResult;
    },
  };
}
