// SPDX-License-Identifier: Apache-2.0
/**
 * `toIncidentSignals` — the dual-shape normalizer.
 *
 * Collapses two on-disk telemetry record shapes into one `IncidentSignals` view
 * the assembler + heuristic registry consume: the LOG shape (raw Pino lines —
 * no `traceSchema`, keyed on `msg`, detail from
 * `errorText`/`httpStatus`/`errorKind`) and the EVENT shape (structured
 * trajectory events — `traceSchema:"comis-trajectory"`, keyed on
 * `type`, detail from `data`).
 *
 * SECURITY (depth-independent): raw bodies are NEVER inlined — `errorPreview` is
 * the ReDoS-pre-bounded `sanitizeLogString(...).slice(0, MAX_ERROR_PREVIEW)` and
 * the full body is captured only by `resultDigest = fingerprint(...)`; an offload
 * `diskPath` is relativized (the absolute host path is never emitted). The
 * misclassification signal derives from LOG EVIDENCE ONLY (zero
 * `classifiedFailureBy` reads — the field is absent in the log shape).
 *
 * @module
 */

import { fingerprint } from "@comis/core";
import type { IncidentSignals } from "@comis/core";
import {
  asString,
  asNumber,
  relativizeDiskPath,
  previewAndDigest,
  applyMediaRecord,
} from "./obs-explain-signals-fields.js";
import {
  accumulateLearningRecord, accumulateSkillInvokedRecord, accumulateSkillUsedRecord, accumulateSkillSurfacedRecord, accumulateReflectFunnelRecord, accumulateSkillTransitionRecord, accumulateMemoryFailureRecord,
  accumulateToolSchemaRecord, buildLearningSignal, emptyLearningFold,
  accumulateSpendExceeded, accumulateCapabilityAuditedRecord, accumulateGraphNodeSpawnedRecord,
  accumulateOrchestrateRunSummaryRecord, accumulateOrchestrateToolCall,
  parseContextBudgetRecord, parsePromptTimeoutRecord,
} from "./obs-explain-signal-folds.js";
import type { Acc } from "./obs-explain-signals-acc.js";

// ---------------------------------------------------------------------------
// Tunable thresholds (module-top constants per the naming contract).
// ---------------------------------------------------------------------------

/** Minimum same-tool failures (co-existing with ≥1 success) for the content-
 * heuristic misclassification signal to fire. */
const MISCLASS_N = 2;

/** Minimum same-tool failures for a breaker/repeated-failure signal. Used by
 * the heuristic registry; surfaced here for one source of truth. */
export const BREAKER_N = 5;

/** Token literals the misclassification heuristic looks for in a failure body. */
const MISCLASS_TOKEN_RE = /"?status"?\s*:?\s*(200|403)|\b(200|403)\b|status/i;
const DO_NOT_RETRY_RE = /DO NOT retry/i;

function ensureTool(acc: Acc, tool: string): { ok: number; failed: number; errorKinds: Map<string, number> } {
  let entry = acc.toolStats.get(tool);
  if (entry === undefined) {
    entry = { ok: 0, failed: 0, errorKinds: new Map() };
    acc.toolStats.set(tool, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Per-shape record handlers.
// ---------------------------------------------------------------------------

function handleLogRecord(acc: Acc, rec: Record<string, unknown>): void {
  const msg = asString(rec.msg) ?? "";
  const tool = asString(rec.toolName);
  const sessionKey = asString(rec.sessionKey);
  if (sessionKey && !acc.sessionKey) acc.sessionKey = sessionKey;

  // Offload (log shape).
  if (msg === "Tool result offloaded to disk" && tool) {
    acc.offloads.push({
      seq: acc.seq++,
      toolName: tool,
      originalChars: asNumber(rec.originalChars) ?? 0,
      pointer: relativizeDiskPath(asString(rec.diskPath)),
    });
    return;
  }

  // Failure (log shape) — keyed on the "Tool execution failed" message.
  if (msg === "Tool execution failed" && tool) {
    const entry = ensureTool(acc, tool);
    entry.failed += 1;
    const errorKind = asString(rec.errorKind) ?? "internal";
    entry.errorKinds.set(errorKind, (entry.errorKinds.get(errorKind) ?? 0) + 1);
    const errorText = asString(rec.errorText);
    const { errorPreview, resultDigest, resultBytes } = previewAndDigest(errorText);
    const httpStatus = asNumber(rec.httpStatus);
    if (errorText && DO_NOT_RETRY_RE.test(errorText)) {
      acc.hasDoNotRetrySignal = true;
      // The breaker's offending tool is this line's toolName (log-shape proxy
      // for a tool.breaker_opened event, which the log shape never carries).
      acc.breakerOpenedTool ??= tool;
      // Synthesize a breaker "opened" timeline entry from the log evidence so a
      // log-only session still has a non-empty breakerTimeline. Dedup per
      // tool — the breaker opens once even though the
      // stream carries multiple "DO NOT retry" lines.
      if (!acc.synthesizedBreakerTools.has(tool)) {
        acc.synthesizedBreakerTools.add(tool);
        acc.breakerEvents.push({ seq: acc.seq++, event: "opened", toolName: tool });
      }
    }
    if (errorText) {
      const m = errorText.match(MISCLASS_TOKEN_RE);
      if (m) acc.misclassTokenByTool.set(tool, m[1] ?? m[2] ?? "status");
    }
    acc.failures.push({
      seq: acc.seq++,
      toolName: tool,
      // Log shape predates the provenance fields — record an honest empty/false.
      classifiedFailureBy: "",
      transportOk: false,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errorKind,
      resultDigest,
      resultBytes,
      errorPreview,
    });
    return;
  }

  // Success (log shape): either an explicit success:true with a toolName, or a
  // "Tool audit: <tool> succeeded" audit line.
  if (tool && (rec.success === true || /succeeded/.test(msg))) {
    ensureTool(acc, tool).ok += 1;
  }
}

function handleEventRecord(acc: Acc, rec: Record<string, unknown>): void {
  const type = asString(rec.type) ?? "";
  const data = (rec.data ?? {}) as Record<string, unknown>;
  const tool = asString(data.toolName);

  switch (type) {
    case "session.started": {
      // Channel identity rides the session.started data (channelType/channelId).
      const channelType = asString(data.channelType);
      const channelId = asString(data.channelId);
      if (acc.channel === undefined && (channelType !== undefined || channelId !== undefined)) {
        acc.channel = { type: channelType ?? "", id: channelId ?? "" };
      }
      return;
    }
    case "terminal.drive_promoted": {
      // A coding-CLI/terminal drive backgrounded at the inline→detached
      // boundary (bridged from terminal:drive_promoted). Count promotions; keep the
      // LAST reason (mode_detached | producing) for the terminal-drive verdict.
      const reason = asString(data.reason);
      if (reason !== undefined) acc.terminalDrivePromotedReason = reason;
      acc.terminalDrivePromotedCount += 1;
      return;
    }
    case "terminal.session_evicted": {
      // The reaper evicted a durable drive (bridged from terminal:session_evicted).
      // Keep the LAST reason (idle | max_sessions | wall_clock | max_interactions) + the
      // session's total lifetime at eviction for the terminal_drive_evicted verdict.
      const reason = asString(data.reason);
      if (reason !== undefined) acc.terminalDriveEvictedReason = reason;
      acc.terminalDriveEvictedMs = asNumber(data.durationMs) ?? acc.terminalDriveEvictedMs;
      return;
    }
    case "tool.result": {
      if (!tool) return;
      // Dedupe by toolCallId — the live ctx_search counted twice when its
      // result appeared in more than one telemetry source.
      const toolCallId = asString(data.toolCallId);
      if (toolCallId !== undefined) {
        if (acc.seenToolResultCallIds.has(toolCallId)) return;
        acc.seenToolResultCallIds.add(toolCallId);
      }
      const success = data.success === true;
      const entry = ensureTool(acc, tool);
      if (success) {
        entry.ok += 1;
        return;
      }
      entry.failed += 1;
      const errorKind = asString(data.errorKind) ?? "internal";
      entry.errorKinds.set(errorKind, (entry.errorKinds.get(errorKind) ?? 0) + 1);
      // The trajectory `tool.result` event carries the failure reason as `errorMessage`
      // (translate-payload.ts), NOT `errorText` — reading the wrong field left
      // `errorPreview` empty so `comis explain` showed no reason (forcing a daemon-log
      // grep). Prefer `errorMessage`; keep `errorText` as a defensive fallback for any
      // other producer shape.
      const errorText = asString(data.errorMessage) ?? asString(data.errorText);
      const { errorPreview, resultBytes } = previewAndDigest(errorText);
      const httpStatus = asNumber(data.httpStatus);
      acc.failures.push({
        seq: asNumber(rec.seq) ?? acc.seq++,
        toolName: tool,
        classifiedFailureBy: asString(data.classifiedFailureBy) ?? "",
        transportOk: data.transportOk === true,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        errorKind,
        ...(asString(data.matchedToken) !== undefined
          ? { matchedToken: asString(data.matchedToken) }
          : {}),
        // Self-grade visibility: the failure-detector sub-rule that flipped the
        // call — "self_grade" (the {graded:true,outcome} envelope, a clean DOMAIN
        // task-failure) vs an error-token rule. Lets `explain.failures` distinguish an
        // honest task-failure from a transport error. Content-free (a closed rule label).
        ...(asString(data.matchedRule) !== undefined
          ? { matchedRule: asString(data.matchedRule) }
          : {}),
        // Prefer an event-supplied digest; otherwise digest the body.
        resultDigest: asString(data.resultDigest) ?? fingerprint(errorText ?? ""),
        resultBytes,
        errorPreview,
      });
      return;
    }
    case "tool.breaker_opened": {
      if (!tool) return;
      acc.breakerEvents.push({
        seq: asNumber(rec.seq) ?? acc.seq++,
        event: "opened",
        toolName: tool,
        ...(asNumber(data.consecutiveFailures) !== undefined
          ? { consecutiveFailures: asNumber(data.consecutiveFailures) }
          : {}),
      });
      acc.breakerOpenedTool ??= tool;
      return;
    }
    case "tool.breaker_reset": {
      if (!tool) return;
      acc.breakerEvents.push({ seq: asNumber(rec.seq) ?? acc.seq++, event: "reset", toolName: tool });
      return;
    }
    case "subagent.budget_exceeded": {
      // A per-node token-budget breach. The trajectory record
      // carries the per-incident view (nodeId + capSource + the two token numbers)
      // the IncidentReport surfaces so a breach is diagnosable from the report alone —
      // WHICH knob bound the node, not just "a node failed". Content-free by
      // construction (closed capSource enum + counts/ids).
      const nodeId = asString(data.nodeId);
      if (nodeId === undefined) return;
      const capSourceRaw = asString(data.capSource);
      const capSource =
        capSourceRaw === "node" || capSourceRaw === "operator-default" || capSourceRaw === "inherit-share"
          ? capSourceRaw
          : "unknown";
      acc.nodeBudgetBreaches.push({
        seq: asNumber(rec.seq) ?? acc.seq++,
        nodeId,
        capSource,
        tokenBudget: asNumber(data.tokenBudget) ?? 0,
        tokensUsed: asNumber(data.tokensUsed) ?? 0,
      });
      return;
    }
    // The per-cap audit record → the spawn-tree's
    // per-node source. Delegated to a fold helper (the accumulateSpendExceeded
    // mold) for the obs-handlers/* subdir cap — see its docstring for the full
    // group-by-leaseId / content-free contract.
    case "graph.node_spawned":
      // A graph DAG node is a spawn-tree leaf too (it never
      // crosses the socket chokepoint that emits capability.audited).
      accumulateGraphNodeSpawnedRecord(acc.spawnNodesByLease, data);
      return;
    case "capability.audited":
      accumulateCapabilityAuditedRecord(acc.spawnNodesByLease, data, rec.agentId, acc.agentId);
      // ALSO tally the run's tool calls keyed by the PER-RUN child leaseId. The
      // same record feeds the spawn-tree node (benign — a run appears in both
      // sections) AND the orchestrate section's per-run toolCalls; the per-run
      // leaseId groups a deny under THE RUN (EXPLAIN-04), not the assembly.
      accumulateOrchestrateToolCall(acc.orchestrateToolCallsByLease, data);
      return;
    // The per-run orchestrate summary → the run skeleton (grouped by runId,
    // first-seen kept). Its toolCalls are joined from the leaseId tally at
    // materialization below. Content-free fold (see obs-explain-signal-folds.ts).
    case "orchestrate.run_summary":
      accumulateOrchestrateRunSummaryRecord(acc.orchestrateRunsByRunId, data);
      return;
    // The budget equation (LCD pre-flight) + prompt-timeout attribution —
    // schema-validated LAST-wins folds delegated to helpers (subdir cap). An
    // undefined parse leaves acc.* unchanged (malformed/partial ignored, fwd-compat).
    case "context.budget": {
      const b = parseContextBudgetRecord(data);
      if (b !== undefined) {
        acc.contextBudget = b; // The terminal fit-check (LAST wins).
        // Also record the per-turn CASCADE. Dedup on transition (the window is fixed per session
        // + S is ~fixed, so push only when assembled-input/eviction/verdict MOVES) so a stable
        // multi-turn session adds nothing; cap to the most-recent 40 (the tightening toward an
        // exhaustion is at the tail). Surfaced only when ≥2 states (see the assemble guard).
        const entry = {
          windowTokens: b.windowTokens,
          assembledInputTokens: b.assembledInputTokens,
          keptCount: b.keptCount,
          verdict: b.verdict,
        };
        const prev = acc.contextBudgetHistory[acc.contextBudgetHistory.length - 1];
        if (
          prev === undefined ||
          prev.assembledInputTokens !== entry.assembledInputTokens ||
          prev.keptCount !== entry.keptCount ||
          prev.verdict !== entry.verdict ||
          prev.windowTokens !== entry.windowTokens
        ) {
          acc.contextBudgetHistory.push(entry);
          if (acc.contextBudgetHistory.length > 40) acc.contextBudgetHistory.shift();
        }
      }
      return;
    }
    case "execution.prompt_timeout": {
      const t = parsePromptTimeoutRecord(data);
      if (t !== undefined) acc.promptTimeout = t;
      return;
    }
    case "tool.result_offloaded": {
      if (!tool) return;
      acc.offloads.push({
        seq: asNumber(rec.seq) ?? acc.seq++,
        toolName: tool,
        originalChars: asNumber(data.originalChars) ?? 0,
        // The translator writes the relative pointer as `diskPathRel` — NOT
        // `diskPath` (the raw Pino LOG-shape field; reading it here silently
        // yielded "<offloaded>" for every event-shape session).
        pointer: relativizeDiskPath(asString(data.diskPathRel)),
      });
      return;
    }
    case "memory.recalled": {
      // Aggregate the per-recall outcome. finalCount === 0 is a recall
      // MISS (no memories injected); the LAST recall is the terminal state. Counts
      // only — the bridged record never carries query text or memory bodies.
      acc.recallCount += 1;
      const finalCount = asNumber(data.finalCount) ?? 0;
      if (finalCount === 0) acc.recallZeroHits += 1;
      acc.lastRecall = {
        lanes: asNumber(data.lanes) ?? 0,
        finalCount,
        rerankerAvailable: data.rerankerAvailable === true,
      };
      return;
    }
    case "cache.break": {
      // Fold the cache-break per reason → {count, estCostUsd}.
      // The bridged record carries a closed `reason`, `tokenDrop`,
      // and a COMPUTED `estCostUsd` (the directly-lost cache-read saving) — counts +
      // a number ONLY, never the changed tool names (only the changed-dims digest
      // crosses the trajectory boundary). A blank/missing reason folds to "unknown".
      const reason = asString(data.reason) ?? "unknown";
      const estCostUsd = asNumber(data.estCostUsd) ?? 0;
      const prev = acc.cacheBreaksByReason.get(reason) ?? { count: 0, estCostUsd: 0 };
      acc.cacheBreaksByReason.set(reason, {
        count: prev.count + 1,
        estCostUsd: prev.estCostUsd + estCostUsd,
      });
      return;
    }
    // The spend kill-switch breach (LAST wins) — delegated to a fold helper (learning-fold mold) for the subdir cap.
    case "spend.exceeded": accumulateSpendExceeded(acc, data); return;
    // The terminal `execution.aborted` record carries the per-ROOT
    // autonomy.budget limb + numbers when a per-root meter (not the priced
    // observability.spend ceiling) tripped. Capture it (LAST wins) so the spend
    // verdict names `autonomy.budget.<limb>` + the numbers in their unit, instead
    // of an operator grepping the "Per-root … budget exceeded" daemon-log line.
    case "execution.aborted": {
      // Capture the abort `reason` (LAST wins) — the assembler
      // uses it as the `endReason` fallback when a hard abort skipped the clean
      // sessionEnd rollup, so the spend-verdict can fire + name the limb.
      const reason = asString(data.reason);
      if (reason !== undefined && reason.length > 0) acc.abortReason = reason;
      const prb = (data as { perRootBudget?: Record<string, unknown> }).perRootBudget;
      if (prb && typeof prb === "object") {
        const limb = asString(prb.limb);
        const spent = asNumber(prb.spent);
        const cap = asNumber(prb.cap);
        if (limb !== undefined && spent !== undefined && cap !== undefined) {
          acc.perRootBudget = { limb, spent, cap, unit: asString(prb.unit) ?? "usd" };
        }
      }
      return;
    }
    // Fold learning-family records → the learning block —
    // outcome / skill invocation / the reflection funnel (reflect.admitted +
    // reflect.funnel); ids/counts only, never content.
    case "learning.outcome_observed": accumulateLearningRecord(acc.learning, data); return;
    case "skill.prompt_invoked": accumulateSkillInvokedRecord(acc.learning, data); return;
    // Inline-surfaced reuse credit (memory:skill_used → used_skill_ids) — surfaces
    // the credited skill ids on explain.skillsUsed (otherwise DB-only, invisible to a one-call explain).
    case "memory.skill_used": accumulateSkillUsedRecord(acc.learning, data); return;
    // The topic-match reuse census — folds the UNCREDITED near-misses (surfaced skills
    // that overlapped the turn but missed the bar) into explain.learning.skillsSurfacedButUncredited.
    case "memory.skill_surfaced": accumulateSkillSurfacedRecord(acc.learning, data); return;
    case "reflect.admitted":
    case "reflect.funnel":
      // The reflection funnel records contribute the BENIGN abstain flag (the payload is
      // counts only); bump count so a reflection-only session still yields a learning block.
      accumulateReflectFunnelRecord(acc.learning, data);
      return;
    // The reuse→promote chain. With skill.prompt_invoked
    // (skillsUsed) this surfaces "used skill X → promoted N" on the per-session learning block.
    case "learning.skill_promoted": accumulateSkillTransitionRecord(acc.learning, data, "promoted"); return;
    case "learning.skill_demoted": accumulateSkillTransitionRecord(acc.learning, data, "demoted"); return;
    // The corroborated-failure accrual (eviction-causation precursor) → the learning block.
    case "learning.memory_failure_attributed": accumulateMemoryFailureRecord(acc.learning, data); return;
    case "execution.tool_schema_unsupported":
      // The strip-retry self-heal record (LAST wins — terminal
      // repair state). Content-free fold (see obs-explain-signal-folds.ts).
      acc.toolSchemaUnsupported = accumulateToolSchemaRecord(data);
      return;
    // image.* + media.vision.* + video.* + media.stt.*/media.tts.*
    // lifecycles → applyMediaRecord folds each into its reconstructed turn
    // (seq-aware). The explicit media.stt.*/media.tts.* arms are LOAD-BEARING —
    // without them the default: below silently DROPS voice records.
    case "image.requested":
    case "image.generated":
    case "image.delivered":
    case "image.failed":
    case "media.vision.requested":
    case "media.vision.completed":
    case "media.vision.failed":
    case "video.requested":
    case "video.submitted":
    case "video.generated":
    case "video.delivered":
    case "video.failed":
    case "media.stt.requested":
    case "media.stt.completed":
    case "media.stt.failed":
    case "media.tts.requested":
    case "media.tts.completed":
    case "media.tts.failed":
      applyMediaRecord(acc, type, data, asNumber(rec.seq) ?? acc.seq++);
      return;
    default:
      // Unknown event type — ignore (forward-compatible).
      return;
  }
}

// ---------------------------------------------------------------------------
// Public normalizer.
// ---------------------------------------------------------------------------

/**
 * Normalize a heterogeneous record stream (raw log lines AND/OR structured
 * trajectory events) into one `IncidentSignals` view.
 *
 * The `hasMisclassificationSignal` derivation uses log evidence only:
 * a tool with BOTH ≥1 success and ≥`MISCLASS_N` failures whose failure body
 * carried a status/200/403 token. No `classifiedFailureBy` is consulted.
 */
export function toIncidentSignals(records: Array<Record<string, unknown>>): IncidentSignals {
  const acc: Acc = {
    toolStats: new Map(),
    failures: [],
    breakerEvents: [],
    offloads: [],
    nodeBudgetBreaches: [],
    spawnNodesByLease: new Map(),
    orchestrateRunsByRunId: new Map(),
    orchestrateToolCallsByLease: new Map(),
    hasDoNotRetrySignal: false,
    synthesizedBreakerTools: new Set(),
    misclassTokenByTool: new Map(),
    seenToolResultCallIds: new Set(),
    turnTraceIds: new Set(),
    recallCount: 0,
    recallZeroHits: 0,
    contextBudgetHistory: [],
    cacheBreaksByReason: new Map(),
    learning: emptyLearningFold(),
    sessionKey: "",
    seq: 0,
    // -1 so the FIRST real terminal record always sets outcome (seeds do not).
    imageOutcomeSeq: -1,
    visionOutcomeSeq: -1,
    videoOutcomeSeq: -1,
    voiceOutcomeSeq: -1,
    terminalDrivePromotedCount: 0,
  };

  for (const rec of records) {
    // Envelope agentId (first seen) — the metadata rollup often lacks it.
    if (acc.agentId === undefined) {
      const envelopeAgentId = asString(rec.agentId);
      if (envelopeAgentId !== undefined && envelopeAgentId.length > 0) acc.agentId = envelopeAgentId;
    }
    if (rec.traceSchema === "comis-trajectory") {
      // Count distinct turns (envelope traceId, one per agent turn) so the
      // report can flag whole-session toolStats as cumulative-across-N-turns (the
      // trajectory JSONL is append-only across reset_conversation severs).
      const tid = asString(rec.traceId);
      if (tid !== undefined && tid.length > 0) acc.turnTraceIds.add(tid);
      handleEventRecord(acc, rec);
    } else if (rec.traceSchema === "comis-cache-trace") {
      // Cache-layer telemetry — NOT tool evidence. Its tool:before/tool:after
      // stage records carry toolName + success and previously fell into the
      // log-shape handler, double-counting every tool call (live ctx_search ok:2
      // for one call). Skipped until a dedicated cache-stage handler exists.
      continue;
    } else {
      handleLogRecord(acc, rec);
    }
  }

  // Newest-first failures (highest seq first).
  acc.failures.sort((a, b) => b.seq - a.seq);

  // Collapse toolStats Map → plain record, picking the dominant errorKind.
  const toolStats: IncidentSignals["toolStats"] = {};
  const repeatedFailureCount: Record<string, number> = {};
  let mostFailedTool: string | undefined;
  let mostFailedCount = 0;
  for (const [tool, entry] of acc.toolStats) {
    let topErrorKind: string | undefined;
    let topCount = 0;
    for (const [kind, count] of entry.errorKinds) {
      if (count > topCount) {
        topCount = count;
        topErrorKind = kind;
      }
    }
    toolStats[tool] = {
      ok: entry.ok,
      failed: entry.failed,
      ...(topErrorKind !== undefined ? { topErrorKind } : {}),
    };
    if (entry.failed > 0) repeatedFailureCount[tool] = entry.failed;
    if (entry.failed > mostFailedCount) {
      mostFailedCount = entry.failed;
      mostFailedTool = tool;
    }
  }

  // Misclassification derivation (log-evidence only): a tool with BOTH a
  // success and ≥MISCLASS_N failures AND a status/200/403 token in a body.
  let hasMisclassificationSignal = false;
  let misclassifiedTool: string | undefined;
  let misclassifiedToken: string | undefined;
  for (const [tool, token] of acc.misclassTokenByTool) {
    const entry = acc.toolStats.get(tool);
    if (entry && entry.ok >= 1 && entry.failed >= MISCLASS_N) {
      hasMisclassificationSignal = true;
      misclassifiedTool = tool;
      misclassifiedToken = token;
      break;
    }
  }

  const learning = buildLearningSignal(acc.learning); // undefined ⇒ omitted below
  return {
    sessionKey: acc.sessionKey,
    toolStats,
    failures: acc.failures,
    breakerEvents: acc.breakerEvents,
    offloads: acc.offloads,
    nodeBudgetBreaches: acc.nodeBudgetBreaches,
    // Materialize the lease-keyed spawn nodes → array (first-seen
    // order); present ONLY when ≥1 capability.audited record (the presence-conditional mold).
    ...(acc.spawnNodesByLease.size > 0
      ? { spawnTree: [...acc.spawnNodesByLease.values()] }
      : {}),
    // Materialize the run skeletons → array (first-seen order), JOINing each run's
    // toolCalls from the per-run leaseId tally (EXPLAIN-04: a deny is attributed to
    // the run via its child leaseId). Present ONLY when ≥1 orchestrate.run_summary
    // record (the presence-conditional spawnTree mold).
    ...(acc.orchestrateRunsByRunId.size > 0
      ? {
          orchestrate: [...acc.orchestrateRunsByRunId.values()].map((run) => ({
            ...run,
            toolCalls:
              run.leaseId !== undefined
                ? [...(acc.orchestrateToolCallsByLease.get(run.leaseId)?.values() ?? [])]
                : [],
          })),
        }
      : {}),
    ...(acc.breakerOpenedTool !== undefined ? { breakerOpenedTool: acc.breakerOpenedTool } : {}),
    hasDoNotRetrySignal: acc.hasDoNotRetrySignal,
    ...(mostFailedTool !== undefined ? { mostFailedTool } : {}),
    repeatedFailureCount,
    hasMisclassificationSignal,
    ...(misclassifiedTool !== undefined ? { misclassifiedTool } : {}),
    ...(misclassifiedToken !== undefined ? { misclassifiedToken } : {}),
    ...(acc.contextBudget !== undefined ? { contextBudget: acc.contextBudget } : {}),
    // Surface the cascade ONLY when ≥2 distinct budget states occurred (a single state adds
    // nothing over `contextBudget`; the dedup already collapsed a stable session to ≤1).
    ...(acc.contextBudgetHistory.length >= 2 ? { contextBudgetHistory: acc.contextBudgetHistory } : {}),
    ...(acc.promptTimeout !== undefined ? { promptTimeout: acc.promptTimeout } : {}),
    ...(acc.toolSchemaUnsupported !== undefined
      ? { toolSchemaUnsupported: acc.toolSchemaUnsupported }
      : {}),
    ...(acc.recallCount > 0 && acc.lastRecall !== undefined
      ? {
          recall: {
            recalls: acc.recallCount,
            zeroHits: acc.recallZeroHits,
            lastLanes: acc.lastRecall.lanes,
            lastFinalCount: acc.lastRecall.finalCount,
            rerankerAvailable: acc.lastRecall.rerankerAvailable,
          },
        }
      : {}),
    // Collapse the per-reason cache-break fold → a bounded,
    // deterministically-ordered array (count desc, then reason asc — the fleet
    // degradedByCause ordering). Present ONLY when the session had ≥1 cache break
    // (undefined, never [], when none). estCostUsd rounded to cents-precision to
    // avoid float-noise in the digest.
    ...(acc.cacheBreaksByReason.size > 0
      ? {
          cacheBreaks: [...acc.cacheBreaksByReason.entries()]
            .map(([reason, v]) => ({
              reason,
              count: v.count,
              estCostUsd: Math.round(v.estCostUsd * 1e6) / 1e6,
            }))
            .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
        }
      : {}),
    // The terminal spend-kill breach (undefined when not spend-killed — never {}); the verdict stays amount-free, this carries the numbers.
    ...(acc.spend !== undefined ? { spend: acc.spend } : {}),
    // The per-ROOT autonomy.budget limb that tripped (token/wall-clock/$),
    // with its numbers in their unit — lets the spend verdict name the exact knob.
    ...(acc.perRootBudget !== undefined ? { perRootBudget: acc.perRootBudget } : {}),
    ...(acc.abortReason !== undefined ? { abortReason: acc.abortReason } : {}),
    // Surface the turn span ONLY when >1 — it flags the whole-session toolStats
    // as cumulative across N turns (the trajectory is append-only across severs), so a
    // reader does not misread a multi-turn count as this-turn. Absent for a 1-turn session.
    ...(acc.turnTraceIds.size > 1 ? { turnCount: acc.turnTraceIds.size } : {}),
    ...(learning !== undefined ? { learning } : {}),
    ...(acc.agentId !== undefined ? { agentId: acc.agentId } : {}),
    ...(acc.channel !== undefined ? { channel: acc.channel } : {}),
    // Surface the backgrounding ONLY when ≥1 promotion fired (undefined,
    // never {}, when no drive backgrounded) — lets the terminal-drive verdict cite it.
    ...(acc.terminalDrivePromotedCount > 0
      ? {
          terminalDrivePromoted: {
            reason: acc.terminalDrivePromotedReason ?? "unknown",
            count: acc.terminalDrivePromotedCount,
          },
        }
      : {}),
    // Surface a reaper eviction ONLY when one fired (undefined, never {}, when
    // no drive was evicted). `wasProducing` is DERIVED from the already-folded
    // drive_promoted reason (zero new events) — the acute canary (a drive
    // that had been producing when the reaper idle-killed it). Lets the
    // terminal_drive_evicted verdict distinguish a cut-short producing drive from an
    // expected idle-out of a never-producing one.
    ...(acc.terminalDriveEvictedReason !== undefined
      ? {
          terminalDriveEvicted: {
            reason: acc.terminalDriveEvictedReason,
            idleMs: acc.terminalDriveEvictedMs ?? 0,
            wasProducing: acc.terminalDrivePromotedReason === "producing",
          },
        }
      : {}),
    // Surface the reconstructed image/vision/video/voice turns (presence-conditional; keyless voice costUsd:0 stays visible).
    ...(acc.image !== undefined ? { image: acc.image } : {}),
    ...(acc.vision !== undefined ? { vision: acc.vision } : {}),
    ...(acc.video !== undefined ? { videoGenerated: acc.video } : {}),
    ...(acc.voice !== undefined ? { voice: acc.voice } : {}),
  };
}
