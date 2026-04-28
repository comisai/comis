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
  reason?: "idle" | "model_change" | "provider_change" | "api_change" | "tool_defs_changed";
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
// 260428-kvl: Tool-DEFINITIONS drift dimension
// ---------------------------------------------------------------------------
// Anthropic validates signed thinking-block signatures against the FULL
// tools array (definitions, not just names). The JIT-guide injection
// layer expands a deferred tool's schema into one turn's tools array
// and then contracts it on the next -- this passes name-only equality
// but fails signature validation. We hash the entire definitions array
// per turn and compare hashes; mismatch -> drop.
//
// Pure function: no I/O, no async, no throws. Hash equality is binary,
// so the result has a single non-trivial reason ("tool_defs_changed").
// Combined at the call site by OR-ing `drop` flags.
// ---------------------------------------------------------------------------

/** Input to `shouldDropSignedFieldsForToolDefs`. */
export interface ToolDefsDriftInput {
  /** SHA-256 hex hash of the FULL tool definitions array that will be
   *  sent on the NEXT API call, in serialization order. */
  currentHash: string;
  /** Snapshots keyed by responseId of the tool-definitions hash at
   *  signature-mint time. */
  snapshots: ReadonlyMap<string, string>;
}

/** Result of `shouldDropSignedFieldsForToolDefs`. */
export interface ToolDefsDriftResult {
  /** True iff at least one snapshot's hash diverges from the current hash. */
  shouldDrop: boolean;
  /** ResponseIds whose stored hash did not equal currentHash, in iteration order. */
  mismatchedResponseIds: string[];
  /** Hash equality is binary, so reason is either "tool_defs_changed" or "no_drift". */
  reason: "tool_defs_changed" | "no_drift";
}

/**
 * Decide whether signed thinking state should be scrubbed because the active
 * tool DEFINITIONS hash differs from the snapshot captured at
 * signature-mint time.
 *
 * Pure: no async, no I/O, no throws.
 */
export function shouldDropSignedFieldsForToolDefs(
  input: ToolDefsDriftInput,
): ToolDefsDriftResult {
  const { currentHash, snapshots } = input;
  if (snapshots.size === 0) {
    return { shouldDrop: false, mismatchedResponseIds: [], reason: "no_drift" };
  }
  const mismatched: string[] = [];
  for (const [responseId, snapHash] of snapshots) {
    if (snapHash !== currentHash) mismatched.push(responseId);
  }
  if (mismatched.length === 0) {
    return { shouldDrop: false, mismatchedResponseIds: [], reason: "no_drift" };
  }
  return {
    shouldDrop: true,
    mismatchedResponseIds: mismatched,
    reason: "tool_defs_changed",
  };
}
