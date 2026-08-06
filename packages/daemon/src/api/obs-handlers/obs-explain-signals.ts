// SPDX-License-Identifier: Apache-2.0
/**
 * Normalizes raw log and structured trajectory records into `IncidentSignals`.
 * Raw bodies never enter reports: previews are bounded and sanitized, full
 * results become digests, and offload paths are relative. Misclassification is
 * derived only from evidence shared by the two shapes.
 * @module
 */
import { fingerprint, type IncidentSignals } from "@comis/core";
import {
  asString, asNumber,
  relativizeDiskPath, previewAndDigest, applyMediaRecord,
  accumulateSessionSummaryRecord, currentTurnBreakerOpenedTool, latestPromptSequence,
} from "./obs-explain-signals-fields.js";
import {
  accumulateLearningRecord, accumulateSkillInvokedRecord, accumulateSkillUsedRecord, accumulateSkillSurfacedRecord,
  accumulateReflectFunnelRecord, accumulateSkillTransitionRecord, accumulateMemoryFailureRecord,
  accumulateToolSchemaRecord, buildLearningSignal, emptyLearningFold,
  accumulateSpendExceeded, accumulateCapabilityAuditedRecord, accumulateGraphNodeSpawnedRecord, accumulateSubAgentSpawnedRecord, accumulateSubAgentCompletedRecord,
  accumulateOrchestrateRunSummaryRecord, accumulateOrchestrateToolCall,
  accumulateBackgroundTaskRecord, buildBackgroundTasksSignal,
  accumulateContextRecord, accumulatePromptRequestRecord, parsePromptTimeoutRecord, parseWakeGateRecord,
  readSkillAvailability,
} from "./obs-explain-signal-folds.js";
import { ensureTool, summarizeToolStats, type Acc } from "./obs-explain-signals-acc.js";
import { foldModelErrorCategory, modelErrorsField } from "./obs-explain-model-errors.js";
import { accumulateQueueRecord } from "./obs-explain-queue-fold.js";
import { accumulateDeliveryDispatch } from "./obs-explain-delivery-fold.js";
import { accumulateSubagentIncidentRecord } from "./obs-explain-subagent-fold.js";
import { accumulateMediaAttachmentRejection, previousPromptSequence } from "./obs-explain-attachment-fold.js";
// ---------------------------------------------------------------------------
/** Minimum same-tool failures with a success for content-heuristic misclassification. */
const MISCLASS_N = 2;
/** Minimum same-tool failures for a breaker/repeated-failure signal; shared with the heuristic registry. */
export const BREAKER_N = 5;
/** Token literals the misclassification heuristic looks for in a failure body. */
const MISCLASS_TOKEN_RE = /"?status"?\s*:?\s*(200|403)|\b(200|403)\b|status/i;
const DO_NOT_RETRY_RE = /DO NOT retry/i;
const PROBLEMATIC_CHANNEL_STATES = new Set(["disconnected", "errored", "stale", "stuck", "unknown"]);
function nonnegativeInteger(value: unknown): number {
  const parsed = asNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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
      ...(asString(rec.failureCode) !== undefined ? { failureCode: asString(rec.failureCode) } : {}),
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
function handleEventRecord(
  acc: Acc,
  rec: Record<string, unknown>,
  latestPromptSeq: number | undefined,
  previousPromptSeq: number | undefined,
): void {
  const type = asString(rec.type) ?? "";
  const data = (rec.data ?? {}) as Record<string, unknown>;
  const tool = asString(data.toolName);
  const recordSeq = asNumber(rec.seq);
  const isCurrentTurn = latestPromptSeq === undefined
    || (recordSeq !== undefined && recordSeq > latestPromptSeq);
  if (accumulateQueueRecord(acc, type, recordSeq, data)) return;
  if (accumulateContextRecord(acc, type, data, recordSeq, isCurrentTurn)) return;
  if (accumulateMediaAttachmentRejection(
    acc.mediaAttachmentRejections, type, data, recordSeq,
    latestPromptSeq, previousPromptSeq,
  )) return;
  switch (type) {
    case "prompt.submitted": {
      acc.skillAvailability = readSkillAvailability(data.unavailableSkills);
      accumulatePromptRequestRecord(acc, data);
      const inboundKind = asString(data.inboundKind);
      if (inboundKind === "message" || inboundKind === "edit") acc.inboundEdit = inboundKind === "edit";
      const groupHistoryMessageCount = nonnegativeInteger(data.groupHistoryMessageCount);
      const groupHistoryCharCount = nonnegativeInteger(data.groupHistoryCharCount);
      if (groupHistoryMessageCount > 0) {
        acc.groupHistory = {
          messageCount: groupHistoryMessageCount,
          charCount: groupHistoryCharCount,
        };
      }
      const source = asString(data.responseLocaleSource);
      const locale = asString(data.responseLocale);
      const enforced = typeof data.responseLocaleEnforced === "boolean" ? data.responseLocaleEnforced : undefined;
      if (
        enforced === undefined
        || (source !== "request" && source !== "explicit" && source !== "unset")
      ) return;
      if (source === "unset") {
        if (locale !== undefined || enforced) return;
        acc.responseLocale = { source, enforced };
        return;
      }
      if (locale === undefined || locale.length === 0) return;
      acc.responseLocale = { locale, source, enforced };
      return;
    }
    case "session.started": {
      // Channel identity rides the session.started data (channelType/channelId).
      const channelType = asString(data.channelType);
      const channelId = asString(data.channelId);
      if (acc.channel === undefined && (channelType !== undefined || channelId !== undefined)) {
        acc.channel = { type: channelType ?? "", id: channelId ?? "" };
      }
      return;
    }
    case "channel.health_changed": {
      const channelType = asString(data.channelType);
      const connectionMode = asString(data.connectionMode);
      const currentState = asString(data.currentState);
      if (
        channelType === undefined
        || connectionMode === undefined
        || currentState === undefined
      ) return;
      const isProblematic = PROBLEMATIC_CHANNEL_STATES.has(currentState);
      if (acc.channelHealth === undefined) {
        if (!isProblematic) return;
        acc.channelHealth = {
          channelType,
          connectionMode,
          degradedTransitions: 1,
          currentState,
          latestProblemState: currentState,
          recovered: false,
        };
        return;
      }
      acc.channelHealth.channelType = channelType;
      acc.channelHealth.connectionMode = connectionMode;
      acc.channelHealth.currentState = currentState;
      acc.channelHealth.recovered = !isProblematic;
      if (isProblematic) {
        acc.channelHealth.degradedTransitions += 1;
        acc.channelHealth.latestProblemState = currentState;
      }
      return;
    }
    case "link.prefetch": {
      const current = acc.linkPrefetch ?? {
        attempts: 0,
        detected: 0,
        attempted: 0,
        fetched: 0,
        failed: 0,
        validationRejected: 0,
        invalid: 0,
        duplicates: 0,
        capped: 0,
        durationMs: 0,
      };
      acc.linkPrefetch = {
        attempts: current.attempts + 1,
        detected: current.detected + nonnegativeInteger(data.detected),
        attempted: current.attempted + nonnegativeInteger(data.attempted),
        fetched: current.fetched + nonnegativeInteger(data.fetched),
        failed: current.failed + nonnegativeInteger(data.failed),
        validationRejected:
          current.validationRejected
          + nonnegativeInteger(data.validationRejected),
        invalid: current.invalid + nonnegativeInteger(data.invalid),
        duplicates: current.duplicates + nonnegativeInteger(data.duplicates),
        capped: current.capped + nonnegativeInteger(data.capped),
        durationMs: current.durationMs + nonnegativeInteger(data.durationMs),
      };
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
    case "subagent.killed":
    case "subagent.background_processes_abandoned":
    case "subagent.delivery_skipped": {
      accumulateSubagentIncidentRecord(acc, type, data, isCurrentTurn);
      return;
    }
    case "background_task.promoted":
    case "background_task.completed":
    case "background_task.failed":
    case "background_task.cancelled":
    case "background_task.reentered":
    case "background_task.notified":
      accumulateBackgroundTaskRecord(acc, type, data, asNumber(rec.seq) ?? acc.seq++);
      return;
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
        if (data.changed === false) entry.noOp += 1;
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
        ...(asString(data.failureCode) !== undefined ? { failureCode: asString(data.failureCode) } : {}),
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
        // The bounded+redacted arguments the failed call was invoked with
        // (already sanitized at the emit) — "what did the failed call attempt?"
        ...(data.argsPreview !== null && typeof data.argsPreview === "object" && !Array.isArray(data.argsPreview)
          ? { argsPreview: data.argsPreview as Record<string, unknown> }
          : {}),
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
    case "subagent.spawned":
      // A direct sessions_spawn child also runs in-process. Its admission
      // lifecycle record supplies the distinct child leaf missing from the
      // capability-endpoint audit stream.
      accumulateSubAgentSpawnedRecord(acc.spawnNodesByLease, data);
      return;
    case "subagent.completed":
    case "subagent.wait_completed":
      accumulateSubAgentCompletedRecord(acc, data, isCurrentTurn);
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
    // Prompt-timeout attribution uses a schema-validated LAST-wins fold. An
    // undefined parse leaves the accumulator unchanged.
    case "execution.prompt_timeout": {
      const t = parsePromptTimeoutRecord(data);
      if (t !== undefined) acc.promptTimeout = t;
      return;
    }
    // A woke fire's content-free wake-gate fact (only a fire the gate WOKE runs the
    // model in a session, so only it writes this record). LAST wins — the terminal
    // fire explains the session. Malformed/partial → unchanged (fwd-compat).
    case "scheduler.wake_gate": {
      const w = parseWakeGateRecord(data);
      if (w !== undefined) acc.cronWakeGate = w;
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
      // crossUserCount > 0 ⇒ agent-scoped recall injected another sender's memory into
      // this turn (the cross-sender privacy signal). Absent on pre-fix trajectories ⇒ 0.
      const crossUserCount = asNumber(data.crossUserCount) ?? 0;
      if (crossUserCount > 0) acc.crossUserRecalls += 1;
      acc.lastRecall = {
        lanes: asNumber(data.lanes) ?? 0,
        finalCount,
        rerankerAvailable: data.rerankerAvailable === true,
        crossUserCount,
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
      // `tokenDrop` rides the report beside the cost: estCostUsd is only the forgone cache-READ
      // saving, while a break's real cost is re-WRITING the dropped prefix at the write rate. Live,
      // that gap made a $30.64 incident read as $0.46 while the drop count told the true story.
      const tokenDrop = asNumber(data.tokenDrop) ?? 0;
      const prev = acc.cacheBreaksByReason.get(reason) ?? { count: 0, estCostUsd: 0, tokenDrop: 0 };
      acc.cacheBreaksByReason.set(reason, {
        count: prev.count + 1,
        estCostUsd: prev.estCostUsd + estCostUsd,
        tokenDrop: prev.tokenDrop + tokenDrop,
      });
      return;
    }
    case "delivery.dispatched": accumulateDeliveryDispatch(acc, data); return;
    case "activity.turn_finalized": {
      const strategy = asString(data.strategy);
      const outcome = asString(data.outcome);
      if (strategy !== undefined && outcome !== undefined) {
        acc.turnFinalized = {
          strategy,
          outcome,
          ...(asString(data.errorKind) !== undefined ? { errorKind: asString(data.errorKind) } : {}),
          ...(asString(data.reason) !== undefined ? { reason: asString(data.reason) } : {}),
          ...(asString(data.renderErrorKind) !== undefined ? { renderErrorKind: asString(data.renderErrorKind) } : {}),
          reclassified: data.reclassified === true,
        };
        // Session-wide tally retains surface states hidden by a later finalize.
        const counts = acc.turnFinalizeCounts ?? {
          failure: 0,
          recovered: 0,
          backgroundPending: 0,
        };
        if (outcome === "failure") counts.failure += 1;
        if (outcome === "success_with_recovered_failures") counts.recovered += 1;
        if (outcome === "silent" && asString(data.reason) === "BACKGROUND_PENDING") {
          counts.backgroundPending += 1;
        }
        acc.turnFinalizeCounts = counts;
      }
      return;
    }
    case "memory.recall_degraded": {
      // A recall lane (or the whole lane split) failed this session — the
      // counted section that answers "did this session run without memory?"
      // from `explain` alone (previously a daemon.log-grep discovery).
      const prev = acc.recallDegraded ?? { count: 0, lastScope: "", lastErrorKind: "" };
      acc.recallDegraded = {
        count: prev.count + 1,
        lastScope: asString(data.scope) ?? prev.lastScope,
        lastErrorKind: asString(data.errorKind) ?? prev.lastErrorKind,
      };
      return;
    }
    case "delivery.aborted": {
      // Blocks an abort left unsent — the "reply never reached the user"
      // ledger (no delivery.dispatched fires for these).
      const total = asNumber(data.totalChunks) ?? 0;
      const delivered = asNumber(data.chunksDelivered) ?? 0;
      const prev = acc.deliveryAborts ?? { events: 0, chunksNotSent: 0 };
      acc.deliveryAborts = {
        events: prev.events + 1,
        chunksNotSent: prev.chunksNotSent + Math.max(0, total - delivered),
      };
      return;
    }
    case "execution.recovery_attempted": {
      // Fold model re-entry and deterministic response-grounding recoveries
      // into counts by reason plus a succeeded tally.
      const reason = asString(data.reason) ?? "unknown";
      const prev = acc.recoveries ?? { total: 0, succeeded: 0, byReason: {} };
      prev.total += 1;
      if (data.succeeded === true) prev.succeeded += 1;
      // eslint-disable-next-line security/detect-object-injection -- reason is a closed enum from the recovery emitter
      prev.byReason[reason] = (prev.byReason[reason] ?? 0) + 1;
      acc.recoveries = prev;
      return;
    }
    case "session.summary": {
      // Sums cost/turn counts and keeps only this latest summary's locale skip.
      accumulateSessionSummaryRecord(acc, data);
      return;
    }
    case "model.completed": {
      // The per-LLM-call token ledger: Σ the four token fields across the
      // session's completions. Source of cost.totalTokens and cacheReadRatio
      // (no rollup writer ever populates a cache ratio).
      const t = acc.modelTokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      t.input += asNumber(data.inputTokens) ?? 0;
      t.output += asNumber(data.outputTokens) ?? 0;
      t.cacheRead += asNumber(data.cacheReadTokens) ?? 0;
      t.cacheCreation += asNumber(data.cacheCreationTokens) ?? 0;
      acc.modelTokens = t;
      if (data.providerErrorCode === "invalid_tool_identity") {
        acc.providerErrorCode = data.providerErrorCode;
      }
      acc.modelErrorCounts = foldModelErrorCategory(acc.modelErrorCounts, asString(data.modelErrorCategory));
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
      if (reason === "circuit_breaker") {
        const provider = asString(data.provider);
        acc.breakerEvents.push({
          seq: asNumber(rec.seq) ?? acc.seq++,
          event: "opened",
          toolName: provider === undefined ? "provider" : `provider:${provider}`,
        });
      }
      const prb = (data as { perRootBudget?: Record<string, unknown> }).perRootBudget;
      if (prb && typeof prb === "object") {
        const limb = asString(prb.limb);
        const spent = asNumber(prb.spent);
        const attempted = asNumber(prb.attempted);
        const cap = asNumber(prb.cap);
        if (limb !== undefined && spent !== undefined && cap !== undefined) {
          acc.perRootBudget = {
            limb,
            spent,
            ...(attempted !== undefined ? { attempted } : {}),
            cap,
            unit: asString(prb.unit) ?? "usd",
          };
        }
      }
      const step = (data as { stepLimit?: Record<string, unknown> }).stepLimit;
      if (step && typeof step === "object") {
        const bindingKnob = asString(step.bindingKnob);
        const stepsExecuted = asNumber(step.stepsExecuted);
        const cap = asNumber(step.cap);
        if (bindingKnob !== undefined && stepsExecuted !== undefined && cap !== undefined) {
          acc.stepLimit = { bindingKnob, stepsExecuted, cap };
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
  const latestPromptSeq = latestPromptSequence(records);
  const previousPromptSeq = previousPromptSequence(records, latestPromptSeq);
  const acc: Acc = {
    toolStats: new Map(),
    failures: [],
    breakerEvents: [],
    queueTimeline: [],
    offloads: [],
    nodeBudgetBreaches: [],
    spawnNodesByLease: new Map(),
    orchestrateRunsByRunId: new Map(),
    orchestrateToolCallsByLease: new Map(),
    hasDoNotRetrySignal: false,
    synthesizedBreakerTools: new Set(),
    misclassTokenByTool: new Map(),
    seenToolResultCallIds: new Set(),
    promptTraceIds: new Set(),
    toolTraceIds: new Set(),
    recallCount: 0,
    recallZeroHits: 0,
    crossUserRecalls: 0,
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
    subagentBackgroundProcessesAbandonedCount: 0,
    subagentDeliverySkippedCount: 0,
    subagentCompletedRunIds: new Set(),
    subagentCompletedCount: 0,
    subagentFailedCount: 0,
    backgroundRecoveryRetryCount: 0,
    backgroundRecoveryByTask: new Map(),
    backgroundPromotionsByTask: new Map(),
    backgroundTerminalTaskIds: new Set(),
    backgroundCompletedTaskIds: new Set(),
    backgroundFailedTaskIds: new Set(),
    backgroundCancelledTaskIds: new Set(),
    backgroundReenteredTaskIds: new Set(),
    backgroundAcceptedTaskIds: new Set(),
    mediaAttachmentRejections: [],
  };
  for (const rec of records) {
    // Envelope agentId (first seen) — the metadata rollup often lacks it.
    if (acc.agentId === undefined) {
      const envelopeAgentId = asString(rec.agentId);
      if (envelopeAgentId !== undefined && envelopeAgentId.length > 0) acc.agentId = envelopeAgentId;
    }
    if (rec.traceSchema === "comis-trajectory") {
      // Count only explicit per-turn anchors. Daemon-global records can ride an
      // open session recorder outside request context and receive the session id
      // as their fallback trace id; counting every envelope therefore fabricates
      // extra turns. Tool records retain support for sparse historical traces that
      // do not contain prompt.submitted.
      const tid = asString(rec.traceId);
      const type = asString(rec.type) ?? "";
      if (tid !== undefined && tid.length > 0) {
        if (type === "prompt.submitted") acc.promptTraceIds.add(tid);
        else if (type.startsWith("tool.")) acc.toolTraceIds.add(tid);
      }
      handleEventRecord(acc, rec, latestPromptSeq, previousPromptSeq);
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
  const currentTurnFailures = latestPromptSeq === undefined
    ? acc.failures
    : acc.failures.filter((failure) => failure.seq > latestPromptSeq);
  const currentTurnNodeBudgetBreaches = latestPromptSeq === undefined
    ? acc.nodeBudgetBreaches
    : acc.nodeBudgetBreaches.filter((breach) => breach.seq > latestPromptSeq);
  const { toolStats, repeatedFailureCount, mostFailedTool } = summarizeToolStats(acc);
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
  const backgroundTasks = buildBackgroundTasksSignal(acc);
  const turnTraceCount = acc.promptTraceIds.size > 0
    ? acc.promptTraceIds.size
    : acc.toolTraceIds.size;
  const breakerOpenedTool = currentTurnBreakerOpenedTool(records, acc.breakerEvents, acc.breakerOpenedTool);
  return {
    sessionKey: acc.sessionKey,
    ...(acc.inboundEdit !== undefined ? { inboundEdit: acc.inboundEdit } : {}),
    ...(acc.groupHistory !== undefined ? { groupHistory: acc.groupHistory } : {}),
    ...(acc.responseLocale !== undefined ? { responseLocale: acc.responseLocale } : {}),
    ...(acc.skillAvailability !== undefined ? { skillAvailability: acc.skillAvailability } : {}),
    ...(acc.requestRelevantToolNames !== undefined
      ? { requestRelevantToolNames: acc.requestRelevantToolNames }
      : {}),
    ...(acc.requestRelevanceHistory !== undefined
      ? { requestRelevanceHistory: acc.requestRelevanceHistory }
      : {}),
    ...(acc.operatorPolicyToolProjections !== undefined
      ? { operatorPolicyToolProjections: acc.operatorPolicyToolProjections }
      : {}),
    ...(acc.responseLocaleRepairSkipped !== undefined
      ? { responseLocaleRepairSkipped: acc.responseLocaleRepairSkipped }
      : {}),
    ...(acc.mediaAttachmentRejections.length > 0
      ? { mediaAttachmentRejections: acc.mediaAttachmentRejections.slice(-16) }
      : {}),
    toolStats,
    failures: currentTurnFailures,
    breakerEvents: acc.breakerEvents,
    ...(acc.queueTimeline.length > 0 ? { queueTimeline: acc.queueTimeline } : {}),
    offloads: acc.offloads,
    nodeBudgetBreaches: currentTurnNodeBudgetBreaches,
    // Materialize lease-keyed spawn nodes in first-seen order when present.
    ...(acc.spawnNodesByLease.size > 0
      ? { spawnTree: [...acc.spawnNodesByLease.values()] }
      : {}),
    ...(acc.subagentCompletedCount > 0
      ? {
          subagentCompletions: {
            completed: acc.subagentCompletedCount,
            failed: acc.subagentFailedCount,
            ...(acc.subagentLastFailedRunId !== undefined
              ? { lastFailedRunId: acc.subagentLastFailedRunId }
              : {}),
          },
  }
      : {}),
    // Materialize run skeletons and join tool calls through each child lease id.
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
    ...(breakerOpenedTool !== undefined
      ? { breakerOpenedTool }
      : {}),
    hasDoNotRetrySignal: acc.hasDoNotRetrySignal,
    ...(mostFailedTool !== undefined ? { mostFailedTool } : {}),
    repeatedFailureCount,
    hasMisclassificationSignal,
    ...(misclassifiedTool !== undefined ? { misclassifiedTool } : {}),
    ...(misclassifiedToken !== undefined ? { misclassifiedToken } : {}),
    ...(acc.contextBudget !== undefined ? { contextBudget: acc.contextBudget } : {}),
    ...(acc.rehydration !== undefined ? { rehydration: acc.rehydration } : {}),
    // A single budget state adds nothing beyond `contextBudget`.
    ...(acc.contextBudgetHistory.length >= 2 ? { contextBudgetHistory: acc.contextBudgetHistory } : {}),
    // A woke fire's wake-gate fact (absent when the trajectory carries no
    // scheduler.wake_gate record — a non-gate session or a skip, which opens none).
    ...(acc.cronWakeGate !== undefined ? { cronWakeGate: acc.cronWakeGate } : {}),
    ...(acc.promptTimeout !== undefined ? { promptTimeout: acc.promptTimeout } : {}),
    ...(acc.toolSchemaUnsupported !== undefined
      ? { toolSchemaUnsupported: acc.toolSchemaUnsupported }
      : {}),
    // Present when the session issued recalls OR a recall degraded — a
    // degraded-ONLY session (the whole lane split failed, so no
    // memory.recalled ever fired) must still surface the recall section
    // with honest zero counts + the degradation tally.
    ...((acc.recallCount > 0 && acc.lastRecall !== undefined) || acc.recallDegraded !== undefined
      ? {
          recall: {
            recalls: acc.recallCount,
            zeroHits: acc.recallZeroHits,
            lastLanes: acc.lastRecall?.lanes ?? 0,
            lastFinalCount: acc.lastRecall?.finalCount ?? 0,
            rerankerAvailable: acc.lastRecall?.rerankerAvailable ?? false,
            // Cross-sender recall injection — surfaced so "did another sender's memory
            // reach this turn?" is answerable from `comis explain` alone (not a raw-session read).
            ...(acc.crossUserRecalls > 0 ? { crossUserRecalls: acc.crossUserRecalls } : {}),
            ...(acc.lastRecall !== undefined ? { lastCrossUserCount: acc.lastRecall.crossUserCount } : {}),
            ...(acc.recallDegraded !== undefined
              ? {
                  degraded: acc.recallDegraded.count,
                  lastDegradedScope: acc.recallDegraded.lastScope,
                  lastDegradedErrorKind: acc.recallDegraded.lastErrorKind,
  }
              : {}),
          },
  }
      : {}),
    // Collapse the per-reason cache-break fold → a bounded,
    // deterministically-ordered array (count desc, then reason asc — the system
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
              tokenDrop: v.tokenDrop,
            }))
            .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  }
      : {}),
    // The terminal spend-kill breach (undefined when not spend-killed — never {}); the verdict stays amount-free, this carries the numbers.
    ...(acc.spend !== undefined ? { spend: acc.spend } : {}),
    // The per-ROOT autonomy.budget limb that tripped (token/wall-clock/$),
    // with its numbers in their unit — lets the spend verdict name the exact knob.
    ...(acc.perRootBudget !== undefined ? { perRootBudget: acc.perRootBudget } : {}),
    ...(acc.stepLimit !== undefined ? { stepLimit: acc.stepLimit } : {}),
    ...(acc.summaryCostUsd !== undefined ? { summaryCostUsd: acc.summaryCostUsd } : {}),
    ...(acc.summaryTurnCount !== undefined ? { summaryTurnCount: acc.summaryTurnCount } : {}),
    ...(acc.summaryTopErrorKinds !== undefined
      ? { summaryTopErrorKinds: acc.summaryTopErrorKinds }
      : {}),
    ...(acc.modelTokens !== undefined ? { modelTokens: acc.modelTokens } : {}),
    ...(acc.providerErrorCode !== undefined ? { providerErrorCode: acc.providerErrorCode } : {}),
    ...modelErrorsField(acc.modelErrorCounts),
    ...(acc.turnFinalized !== undefined ? { turnFinalized: acc.turnFinalized } : {}),
    ...(acc.turnFinalizeCounts !== undefined ? { turnFinalizeCounts: acc.turnFinalizeCounts } : {}),
    ...(acc.deliveryDispatch !== undefined ? { deliveryDispatch: acc.deliveryDispatch } : {}),
    ...(acc.deliveryAborts !== undefined ? { deliveryAborts: acc.deliveryAborts } : {}),
    ...(acc.recoveries !== undefined ? { recoveries: acc.recoveries } : {}),
    ...(acc.abortReason !== undefined ? { abortReason: acc.abortReason } : {}),
    // Surface the turn span ONLY when >1 — it flags the whole-session toolStats
    // as cumulative across N turns (the trajectory is append-only across severs), so a
    // reader does not misread a multi-turn count as this-turn. Absent for a 1-turn session.
    ...(turnTraceCount > 1 ? { turnCount: turnTraceCount } : {}),
    ...(learning !== undefined ? { learning } : {}),
    ...(acc.agentId !== undefined ? { agentId: acc.agentId } : {}),
    ...(acc.channel !== undefined ? { channel: acc.channel } : {}),
    ...(acc.channelHealth !== undefined ? { channelHealth: acc.channelHealth } : {}),
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
    // Surface an attributed sub-agent kill ONLY when one fired (undefined,
    // never {}). Idle/threshold ride only when present (health-monitor kills).
    ...(acc.subagentKilledBy !== undefined
      ? {
          subagentKilled: {
            killedBy: acc.subagentKilledBy,
            ...(acc.subagentKilledRuntimeMs !== undefined ? { runtimeMs: acc.subagentKilledRuntimeMs } : {}),
            ...(acc.subagentKilledIdleMs !== undefined ? { idleMs: acc.subagentKilledIdleMs } : {}),
            ...(acc.subagentKilledThresholdMs !== undefined ? { thresholdMs: acc.subagentKilledThresholdMs } : {}),
          },
        }
      : {}),
    ...(acc.subagentBackgroundProcessesAbandonedCount > 0
      && acc.subagentBackgroundProcessesAbandonedLastRunId !== undefined
      ? {
          subagentBackgroundProcessesAbandoned: {
            count: acc.subagentBackgroundProcessesAbandonedCount,
            lastRunId: acc.subagentBackgroundProcessesAbandonedLastRunId,
          },
        }
      : {}),
    ...(acc.subagentDeliverySkippedCount > 0
      && acc.subagentDeliverySkippedLastRunId !== undefined
      && acc.subagentDeliverySkippedLastReason !== undefined
      ? {
          subagentDeliverySkipped: {
            count: acc.subagentDeliverySkippedCount,
            lastRunId: acc.subagentDeliverySkippedLastRunId,
            lastReason: acc.subagentDeliverySkippedLastReason,
          },
        }
      : {}),
    ...(acc.backgroundRecoveryRetryCount > 0
      ? {
          backgroundRecovery: {
            retryRequiredCount: acc.backgroundRecoveryRetryCount,
            unresolvedCount: [...acc.backgroundRecoveryByTask.values()]
              .filter((entry) => entry.unresolved).length,
            ...(acc.backgroundRecoveryLastTaskId !== undefined
              ? { lastTaskId: acc.backgroundRecoveryLastTaskId }
              : {}),
            ...(acc.backgroundRecoveryLastToolName !== undefined
              ? { lastToolName: acc.backgroundRecoveryLastToolName }
              : {}),
          },
        }
      : {}),
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
    ...(acc.linkPrefetch !== undefined
      ? { linkPrefetch: acc.linkPrefetch }
      : {}),
    // Surface the reconstructed image/vision/video/voice turns (presence-conditional; keyless voice costUsd:0 stays visible).
    ...(acc.image !== undefined ? { image: acc.image } : {}),
    ...(acc.vision !== undefined ? { vision: acc.vision } : {}),
    ...(acc.video !== undefined ? { videoGenerated: acc.video } : {}),
    ...(acc.voice !== undefined ? { voice: acc.voice } : {}),
  };
}
