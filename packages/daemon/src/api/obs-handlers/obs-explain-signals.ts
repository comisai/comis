// SPDX-License-Identifier: Apache-2.0
/**
 * `toIncidentSignals` — the X3 dual-shape normalizer.
 *
 * Collapses two on-disk telemetry record shapes into one `IncidentSignals`
 * view that the assembler (Plan 03) and heuristic registry (Plan 05) consume:
 *
 *   - LOG shape (raw Pino lines; PRE Phase-150): no `traceSchema`, no
 *     `classifiedFailureBy`/`transportOk`. Keyed on `msg`
 *     (`"Tool execution failed"` / `"Tool audit: … succeeded"` /
 *     `"Tool result offloaded to disk"`); failure detail read from
 *     `errorText` / `httpStatus` / `errorKind`.
 *   - EVENT shape (structured trajectory events; POST Phase-151):
 *     `traceSchema: "comis-trajectory"`. Keyed on `type` (`"tool.result"` /
 *     `"tool.breaker_opened"` / `"tool.breaker_reset"` /
 *     `"tool.result_offloaded"`); detail read from `data`.
 *
 * SECURITY (depth-independent):
 *   - Raw bodies are NEVER inlined. `errorPreview` = `sanitizeLogString`(the
 *     errorText, pre-bounded against ReDoS) `.slice(0, MAX_ERROR_PREVIEW)`;
 *     the full body is captured only by `resultDigest = fingerprint(errorText)`.
 *   - Offload `diskPath` is relativized: an absolute host path
 *     (`/Users/…/.comis/…`) is collapsed to the workspace-relative tail after
 *     `.comis/`; the absolute host path is never emitted.
 *
 * The 678 misclassification signal derives from LOG EVIDENCE ONLY — it reads
 * ZERO `classifiedFailureBy` fields (the field is absent in that fixture).
 *
 * @module
 */

import { fingerprint, IncidentContextBudgetSchema, IncidentPromptTimeoutSchema } from "@comis/core";
import type { IncidentContextBudget, IncidentFailure, IncidentPromptTimeout, IncidentSignals } from "@comis/core";
import {
  asString,
  asNumber,
  asStringArray,
  relativizeDiskPath,
  previewAndDigest,
  applyMediaRecord,
  type IncidentImageSignal,
  type IncidentVisionSignal,
  type IncidentVideoSignal,
  type IncidentVoiceSignal,
} from "./obs-explain-signals-fields.js";

// ---------------------------------------------------------------------------
// Tunable thresholds (module-top constants per the naming contract).
// ---------------------------------------------------------------------------

/** Minimum same-tool failures (co-existing with ≥1 success) for the content-
 * heuristic misclassification signal to fire. */
const MISCLASS_N = 2;

/** Minimum same-tool failures for a breaker/repeated-failure signal. Used by
 * the heuristic registry (Plan 05); surfaced here for one source of truth. */
export const BREAKER_N = 5;

/** Token literals the misclassification heuristic looks for in a failure body. */
const MISCLASS_TOKEN_RE = /"?status"?\s*:?\s*(200|403)|\b(200|403)\b|status/i;
const DO_NOT_RETRY_RE = /DO NOT retry/i;

// ---------------------------------------------------------------------------
// Internal mutable accumulator (collapsed into IncidentSignals at the end).
// ---------------------------------------------------------------------------

interface Acc {
  toolStats: Map<string, { ok: number; failed: number; errorKinds: Map<string, number> }>;
  failures: IncidentFailure[];
  breakerEvents: IncidentSignals["breakerEvents"];
  offloads: IncidentSignals["offloads"];
  breakerOpenedTool?: string;
  hasDoNotRetrySignal: boolean;
  /** Tools for which a log-shape breaker "opened" event was already synthesized
   * (dedup — the breaker opens once per tool even across repeated DO-NOT-retry
   * lines). Structured tool.breaker_opened events are NOT deduped here (they are
   * explicit telemetry, one push each). */
  synthesizedBreakerTools: Set<string>;
  /** Per-tool: did any failure body carry a status/200/403 token? */
  misclassTokenByTool: Map<string, string>;
  /** W3: the LAST context.budget trajectory record (the terminal fit check). */
  contextBudget?: IncidentContextBudget;
  /** LAT-04: the LAST execution.prompt_timeout record (the terminal kill
   *  explains the end state — a retry-path kill earlier in the session is
   *  superseded by the kill that actually ended it). */
  promptTimeout?: IncidentPromptTimeout;
  /** GBNF-02: the LAST `execution.tool_schema_unsupported` record — the
   *  strip-retry self-heal outcome (one strip-retry per session means at most
   *  a handful; the terminal repair state explains the end). */
  toolSchemaUnsupported?: IncidentSignals["toolSchemaUnsupported"];
  /** RECALL-01: aggregated over `memory.recalled` records — how many recalls ran,
   *  how many returned zero injected memories, and the TERMINAL recall's shape. */
  recallCount: number;
  recallZeroHits: number;
  lastRecall?: { lanes: number; finalCount: number; rerankerAvailable: boolean };
  /** The image/vision/video/voice turns reconstructed from the session's image.*
   *  (186), media.vision.* (187), video.* (192), and media.stt / media.tts (196)
   *  records (folded by `applyMediaRecord` → accumulate{Image,Vision,Video,Voice}Record).
   *  The terminal generated/completed/failed record sets `outcome` (+ cost/model/
   *  path/errorKind/jobId/keyless); delivered flips a latch. Each is undefined until
   *  its record class is seen (presence-conditional output). The paired *OutcomeSeq
   *  is the `seq` at which `outcome` was last set, so each fold is seq-aware (IN-04 —
   *  a stale lower-seq terminal never overwrites a newer one) rather than relying on
   *  record-array order. */
  image?: IncidentImageSignal;
  imageOutcomeSeq: number;
  vision?: IncidentVisionSignal;
  visionOutcomeSeq: number;
  video?: IncidentVideoSignal;
  videoOutcomeSeq: number;
  voice?: IncidentVoiceSignal;
  voiceOutcomeSeq: number;
  /** W8: event-shape tool.result toolCallIds already counted (dedup — the same
   *  call must not count twice if its result event is duplicated across sources). */
  seenToolResultCallIds: Set<string>;
  /** W8: agentId from the first record envelope that carries one. */
  agentId?: string;
  /** W8: channel identity from the session.started record's data. */
  channel?: { type: string; id: string };
  sessionKey: string;
  seq: number;
}

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
      // for a tool.breaker_opened event, which does not exist pre-151).
      acc.breakerOpenedTool ??= tool;
      // Synthesize a breaker "opened" timeline entry from the log evidence so a
      // pre-151 log-only session still has a non-empty breakerTimeline (the X3
      // 678 must-have). Dedup per tool — the breaker opens once even though the
      // fixture carries multiple "DO NOT retry" lines.
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
      // W8: channel identity rides the session.started data (channelType/channelId).
      const channelType = asString(data.channelType);
      const channelId = asString(data.channelId);
      if (acc.channel === undefined && (channelType !== undefined || channelId !== undefined)) {
        acc.channel = { type: channelType ?? "", id: channelId ?? "" };
      }
      return;
    }
    case "tool.result": {
      if (!tool) return;
      // W8: dedupe by toolCallId — the live ctx_search counted twice when its
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
      const errorText = asString(data.errorText);
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
    case "context.budget": {
      // W3 (obs-llm-troubleshooting): the per-call budget equation emitted by the
      // LCD pre-flight (W2). LAST record wins — the terminal fit check explains
      // the end state. Validated wholesale; malformed/partial ignored (fwd-compat).
      const parsed = IncidentContextBudgetSchema.safeParse(data);
      if (parsed.success) acc.contextBudget = parsed.data;
      return;
    }
    case "execution.prompt_timeout": {
      // LAT-04 (177): the terminal prompt-timeout attribution record (stall /
      // makespan / whole-turn — 177-03 emit sites). LAST record wins. Validated
      // wholesale (the context.budget discipline, T-177-17); a malformed/partial
      // record is ignored (forward-compatible — pre-extension timeoutMs-only rows
      // still parse, every other field optional).
      const parsed = IncidentPromptTimeoutSchema.safeParse(data);
      if (parsed.success) acc.promptTimeout = parsed.data;
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
        // yielded "<offloaded>" for every post-151 event-shape session).
        pointer: relativizeDiskPath(asString(data.diskPathRel)),
      });
      return;
    }
    case "memory.recalled": {
      // RECALL-01: aggregate the per-recall outcome. finalCount === 0 is a recall
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
    case "execution.tool_schema_unsupported": {
      // GBNF-02 (Phase 175): the strip-retry self-heal record (Plan 05 bridge
      // mapping). LAST record wins — the terminal repair state explains the
      // end. Content-free by construction (tool + keyword NAMES only — I7);
      // the string-array filters + exact-true boolean reads keep smuggled
      // non-string payload entries out of the verdict text (T-175-17). The
      // WR-05 reason discriminator is validated against its closed vocabulary
      // (same trust-boundary posture); absent/off-vocabulary → undefined so
      // pre-WR-05 trajectory records on disk stay readable.
      const rawReason = asString(data.reason);
      acc.toolSchemaUnsupported = {
        toolNames: asStringArray(data.toolNames),
        strippedKeywords: asStringArray(data.strippedKeywords),
        retried: data.retried === true,
        succeeded: data.succeeded === true,
        ...(rawReason === "stripped" || rawReason === "nothing_to_strip" || rawReason === "gate_closed"
          ? { reason: rawReason }
          : {}),
      };
      return;
    }
    // OBS-04 (186) / VIS-04 (187) / OBS-04-video (192) / OBS-02-voice (196): the
    // image.* + media.vision.* + video.* + media.stt.*/media.tts.* lifecycles. The
    // handlers/poller direct-emit these content-free records; `applyMediaRecord`
    // folds each into the reconstructed image / vision / video / voice turn
    // (seq-aware IN-04 — driven by `rec.seq`, falling back to the running counter)
    // so `comis explain` surfaces provider/model/jobId/costUsd/keyless/source/
    // outcome (Route a — cost rides the terminal record, not the executor
    // sessionEnd). The explicit media.stt.*/media.tts.* arms are LOAD-BEARING:
    // without them the `default:` below silently DROPS voice records (Pitfall 2 —
    // a voice turn would reconstruct as NOTHING).
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
 * The 678 `hasMisclassificationSignal` derivation uses log evidence only:
 * a tool with BOTH ≥1 success and ≥`MISCLASS_N` failures whose failure body
 * carried a status/200/403 token. No `classifiedFailureBy` is consulted.
 */
export function toIncidentSignals(records: Array<Record<string, unknown>>): IncidentSignals {
  const acc: Acc = {
    toolStats: new Map(),
    failures: [],
    breakerEvents: [],
    offloads: [],
    hasDoNotRetrySignal: false,
    synthesizedBreakerTools: new Set(),
    misclassTokenByTool: new Map(),
    seenToolResultCallIds: new Set(),
    recallCount: 0,
    recallZeroHits: 0,
    sessionKey: "",
    seq: 0,
    // IN-04: -1 so the FIRST real terminal record (seq ≥ 0) always sets outcome
    // (the requested/submitted seeds do not advance it) — image/vision/video/voice.
    imageOutcomeSeq: -1,
    visionOutcomeSeq: -1,
    videoOutcomeSeq: -1,
    voiceOutcomeSeq: -1,
  };

  for (const rec of records) {
    // W8: envelope agentId (first seen) — the metadata rollup often lacks it.
    if (acc.agentId === undefined) {
      const envelopeAgentId = asString(rec.agentId);
      if (envelopeAgentId !== undefined && envelopeAgentId.length > 0) acc.agentId = envelopeAgentId;
    }
    if (rec.traceSchema === "comis-trajectory") {
      handleEventRecord(acc, rec);
    } else if (rec.traceSchema === "comis-cache-trace") {
      // W8: cache-layer telemetry — NOT tool evidence. Its tool:before/tool:after
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

  return {
    sessionKey: acc.sessionKey,
    toolStats,
    failures: acc.failures,
    breakerEvents: acc.breakerEvents,
    offloads: acc.offloads,
    ...(acc.breakerOpenedTool !== undefined ? { breakerOpenedTool: acc.breakerOpenedTool } : {}),
    hasDoNotRetrySignal: acc.hasDoNotRetrySignal,
    ...(mostFailedTool !== undefined ? { mostFailedTool } : {}),
    repeatedFailureCount,
    hasMisclassificationSignal,
    ...(misclassifiedTool !== undefined ? { misclassifiedTool } : {}),
    ...(misclassifiedToken !== undefined ? { misclassifiedToken } : {}),
    ...(acc.contextBudget !== undefined ? { contextBudget: acc.contextBudget } : {}),
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
    ...(acc.agentId !== undefined ? { agentId: acc.agentId } : {}),
    ...(acc.channel !== undefined ? { channel: acc.channel } : {}),
    // 186/187/192/196: surface the reconstructed image / vision / video / voice
    // turns (presence-conditional — each absent when the trajectory had no records
    // of that class). videoGenerated is the OBS-04 background-completion oracle;
    // voice is the OBS-02 voice-turn oracle (keyless costUsd:0 visible, OBS-05).
    ...(acc.image !== undefined ? { image: acc.image } : {}),
    ...(acc.vision !== undefined ? { vision: acc.vision } : {}),
    ...(acc.video !== undefined ? { videoGenerated: acc.video } : {}),
    ...(acc.voice !== undefined ? { voice: acc.voice } : {}),
  };
}
