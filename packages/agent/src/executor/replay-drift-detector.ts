// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-agnostic replay-drift detector.
 *
 * Reads session file entries (jsonl-backed; survives daemon restarts) and
 * decides whether the current pipeline run should scrub stored signed
 * thinking / reasoning state pre-send to avoid provider replay-rejection.
 *
 * Drift conditions (first-match-wins ordering):
 *   1. idle gap > threshold
 *   2. model id change vs the last assistant turn
 *   3. provider change
 *   4. api change (e.g. anthropic.messages -> google.generative_ai.responses)
 *
 * Pure function — no async, no I/O. Defensive: tolerates malformed entries,
 * missing timestamps, and the empty-history case.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of a session file entry the detector reads. */
interface DriftFileEntry {
  /** Unix-ms timestamp of the entry. */
  timestamp?: number;
  /** Entry kind; only `"message"` carries a role/content we care about. */
  type?: string;
  /** Message body for message-type entries. */
  message?: {
    role?: string;
    /** Optional metadata persisted on assistant turns; pi-ai records the
     *  stream metadata here including model identity. */
    metadata?: {
      model?: { id?: string; provider?: string; api?: string };
      provider?: string;
      api?: string;
    };
    content?: unknown;
  };
}

/** Input to `shouldDropSignedFields`. */
export interface DriftCheckInput {
  /** Session manager file entries, jsonl-backed. */
  fileEntries: ReadonlyArray<DriftFileEntry>;
  /** Current model identity from `session.agent.state.model` plus
   *  `config.provider`. All fields optional; missing fields disable the
   *  corresponding drift check rather than tripping it. */
  currentModel: { id?: string; provider?: string; api?: string };
  /** Idle threshold from config (already resolved with default applied). */
  idleMs: number;
  /** Now() injection for testability. Default: `Date.now()`. */
  now?: number;
}

/** Result of `shouldDropSignedFields`. */
export interface DriftCheck {
  /** True when the caller should scrub signed thinking state pre-send. */
  drop: boolean;
  /** Human-readable reason; populated only when drop===true. */
  reason?: "idle" | "model_change" | "provider_change" | "api_change";
  /** Diagnostic detail for logger / event payload. */
  detail?: {
    idleGapMs?: number;
    previousModel?: string;
    previousProvider?: string;
    previousApi?: string;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Decide whether signed thinking state should be scrubbed pre-send.
 *
 * Walks `fileEntries` from the END to find the most recent assistant message
 * with content. Compares its timestamp + recorded model identity against the
 * current model identity and the configured idle threshold.
 *
 * Ordering: idle takes precedence over model_change, which takes precedence
 * over provider_change, which takes precedence over api_change. The order is
 * tested explicitly so future refactors cannot silently change it.
 */
export function shouldDropSignedFields(input: DriftCheckInput): DriftCheck {
  const { fileEntries, currentModel, idleMs } = input;
  const now = input.now ?? Date.now();

  if (!Array.isArray(fileEntries) || fileEntries.length === 0) {
    return { drop: false };
  }

  // Walk from the end to find the most recent assistant message.
  let lastAssistant: DriftFileEntry | null = null;
  for (let i = fileEntries.length - 1; i >= 0; i--) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index, caller-supplied array
    const entry = fileEntries[i];
    if (!entry || typeof entry !== "object") continue;
    if (entry.type !== "message") continue;
    if (entry.message?.role !== "assistant") continue;
    lastAssistant = entry;
    break;
  }

  if (lastAssistant === null) {
    // No prior assistant entry → nothing to drift from.
    return { drop: false };
  }

  // Idle check: highest precedence.
  const lastTs = typeof lastAssistant.timestamp === "number" ? lastAssistant.timestamp : undefined;
  if (lastTs !== undefined) {
    const idleGapMs = now - lastTs;
    if (idleGapMs > idleMs) {
      return { drop: true, reason: "idle", detail: { idleGapMs } };
    }
  }

  // Identity comparisons. pi-ai persists stream metadata on assistant turns
  // under message.metadata.model; some legacy paths put it directly on
  // message.metadata.{provider,api}. Probe both shapes.
  const meta = lastAssistant.message?.metadata;
  const previousModel = meta?.model?.id;
  const previousProvider = meta?.model?.provider ?? meta?.provider;
  const previousApi = meta?.model?.api ?? meta?.api;

  // Model id change.
  if (
    previousModel !== undefined &&
    currentModel.id !== undefined &&
    previousModel !== currentModel.id
  ) {
    return { drop: true, reason: "model_change", detail: { previousModel } };
  }

  // Provider change.
  if (
    previousProvider !== undefined &&
    currentModel.provider !== undefined &&
    previousProvider !== currentModel.provider
  ) {
    return { drop: true, reason: "provider_change", detail: { previousProvider } };
  }

  // API change.
  if (
    previousApi !== undefined &&
    currentModel.api !== undefined &&
    previousApi !== currentModel.api
  ) {
    return { drop: true, reason: "api_change", detail: { previousApi } };
  }

  return { drop: false };
}

// ---------------------------------------------------------------------------
// 260428-k8d: Tool-set drift dimension
// ---------------------------------------------------------------------------
// Anthropic validates signed thinking-block signatures against the request's
// tools + system prompt; mid-conversation `discover_tools` mutates the tools
// array and invalidates the signed prefix. This dimension extends the existing
// drift detector by comparing the active tool name set on the next API call
// against per-responseId snapshots captured at signature-mint time.
//
// Pure function: no I/O, no async, no throws — defensive null-tolerant helpers
// only. Combined at the call site by OR-ing `drop` flags so the existing
// closed `DriftCheck.reason` union remains untouched.
// ---------------------------------------------------------------------------

/** Input to `shouldDropSignedFieldsForToolSet`. */
export interface ToolSetDriftInput {
  /** Active tool name set that will be in the NEXT API call's tools array. */
  currentActiveTools: ReadonlySet<string>;
  /** Snapshots keyed by responseId of the active tool set at signature-mint time. */
  snapshots: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Result of `shouldDropSignedFieldsForToolSet`. */
export interface ToolSetDriftResult {
  /** True iff at least one snapshot diverges from the current set. */
  shouldDrop: boolean;
  /** ResponseIds whose snapshot did not equal the current set, in iteration order. */
  mismatchedResponseIds: string[];
  /** Most-specific reason across all mismatched snapshots (priority: changed > shrank > grew). */
  reason: "tool_set_grew" | "tool_set_shrank" | "tool_set_changed" | "no_drift";
}

/**
 * Decide whether signed thinking state should be scrubbed because the active
 * tool set differs from the snapshot captured at signature-mint time.
 *
 * Per-snapshot classification:
 *   snapshot ⊂ current  → tool_set_grew  (current added tools)
 *   current ⊂ snapshot  → tool_set_shrank
 *   neither subset      → tool_set_changed
 *   sets equal          → no contribution (skipped)
 *
 * Aggregate priority (most specific wins): changed > shrank > grew > no_drift.
 * `mismatchedResponseIds` collects every non-equal snapshot regardless of
 * which reason category wins, so observability covers all divergences.
 *
 * Pure: no async, no I/O, no throws.
 */
export function shouldDropSignedFieldsForToolSet(
  input: ToolSetDriftInput,
): ToolSetDriftResult {
  const { currentActiveTools, snapshots } = input;
  if (snapshots.size === 0) {
    return { shouldDrop: false, mismatchedResponseIds: [], reason: "no_drift" };
  }
  const mismatched: string[] = [];
  let sawChanged = false;
  let sawShrank = false;
  let sawGrew = false;
  for (const [responseId, snap] of snapshots) {
    // Equality short-circuit: same size and every snap entry present in current.
    if (snap.size === currentActiveTools.size) {
      let allMatch = true;
      for (const name of snap) {
        if (!currentActiveTools.has(name)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) continue;
    }
    // Classify direction of divergence.
    let snapHasExtra = false; // names in snap not in current → shrank-or-changed
    let currentHasExtra = false; // names in current not in snap → grew-or-changed
    for (const name of snap) {
      if (!currentActiveTools.has(name)) {
        snapHasExtra = true;
        break;
      }
    }
    for (const name of currentActiveTools) {
      if (!snap.has(name)) {
        currentHasExtra = true;
        break;
      }
    }
    if (snapHasExtra && currentHasExtra) sawChanged = true;
    else if (snapHasExtra) sawShrank = true;
    else if (currentHasExtra) sawGrew = true;
    mismatched.push(responseId);
  }
  if (mismatched.length === 0) {
    return { shouldDrop: false, mismatchedResponseIds: [], reason: "no_drift" };
  }
  const reason: ToolSetDriftResult["reason"] = sawChanged
    ? "tool_set_changed"
    : sawShrank
      ? "tool_set_shrank"
      : sawGrew
        ? "tool_set_grew"
        : "no_drift";
  return { shouldDrop: true, mismatchedResponseIds: mismatched, reason };
}
