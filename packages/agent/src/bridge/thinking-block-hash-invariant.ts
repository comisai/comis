// SPDX-License-Identifier: Apache-2.0
/**
 * Thinking-block hash invariant -- diagnostic instrumentation only.
 *
 * Observed problem: Anthropic 400 `messages.N.content.M: thinking/redacted_thinking
 * blocks cannot be modified` errors keep firing in production even after the
 * surrogate-guard, drift-scrubber, and signed-replay-detector layers shipped
 * (260425-rvm), and even after the immutable-section redirect (260425-t40).
 * Trace `c7b91328-9dc5-4618-9ae8-ca207b4b93df` on 2026-04-28 hit a 400 ~2.2s
 * after `turn_end` -- meaning *some other layer* mutates a signed thinking
 * block between the assistant turn and the next replay. We don't know which.
 *
 * This module is the diagnostic. At each `turn_end` with signed thinking
 * blocks, the bridge captures a SHA-256 hash of every thinking block. Before
 * the next assistant-message resend, the bridge recomputes the hashes and
 * asserts they match the captured snapshots. On mismatch, ONE structured
 * ERROR log fires per mutated index with enough context to pinpoint the
 * offending layer (responseId, blockIndex, old/new hash, first-32-chars of
 * old/new text, signature length before/after).
 *
 * Behavior contract (enforced by tests + source-shape grep):
 * - NEVER throws. Every code path returns normally; logger errors are
 *   swallowed because we don't want the diagnostic itself to abort agent flow.
 * - NEVER mutates inputs. Pure read; only output is the structured log.
 * - NEVER alters request flow. The mismatch is observable signal only --
 *   Anthropic's 400 still surfaces through the existing error path
 *   (signed-replay-detector -> executor-prompt-runner). Bug A behavior fix
 *   is a separate quick task gated on what this diagnostic reveals.
 *
 * Logging surface follows CLAUDE.md canonical Pino fields:
 * - object-first signature: `error({...fields}, "msg")`
 * - `module: "agent.bridge.hash-invariant"`
 * - `errorKind: "internal"` (classification per AGENTS.md §2.1)
 * - `hint`: actionable next step for the on-call diagnoser
 * - `responseId`, `blockIndex`, `oldHash`, `newHash`,
 *   `oldText.firstChars`, `newText.firstChars`, `oldSigLen`, `newSigLen`
 *
 * Privacy / threat note: `oldText.firstChars` and `newText.firstChars` are
 * 32-char prefixes of `block.thinking`. Anthropic redacts thinking text
 * upstream when it would leak credentials, and Comis layers (surrogate guard,
 * drift scrubber) further sanitize before any persistence. The hash itself is
 * one-way and non-credential-bearing. Pino's redaction config is a safety net.
 *
 * @module
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A captured snapshot of one thinking block's hash + diagnostic prefix. */
export interface ThinkingBlockHash {
  /** Position within the thinking-only stream (skips text/tool/redacted blocks). */
  blockIndex: number;
  /** SHA-256 hex digest of `(type | thinking | thinkingSignature | redacted)`. */
  hash: string;
  /** First 32 chars of `thinking` -- diagnostic on mismatch only. */
  textFirstChars: string;
  /** Length of `thinkingSignature` -- diagnostic, never the value. */
  sigLen: number;
}

/** Logger surface required by `assertThinkingBlocksUnchanged`. */
export interface AssertDeps {
  logger: { error: (obj: Record<string, unknown>, msg: string) => void };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const HINT =
  "Locate the context-engine layer that touched this block " +
  "(likely between turn_end and the next pi-ai serialize step). " +
  "Compare oldText.firstChars vs newText.firstChars to identify mutation type.";

const MODULE_FIELD = "agent.bridge.hash-invariant";

const ERROR_KIND = "internal";

const TEXT_PREFIX_LEN = 32;

/** Format the four-field hash payload for one block. */
function buildHashInput(
  type: unknown,
  thinking: unknown,
  signature: unknown,
  redacted: unknown,
): string {
  const t = typeof type === "string" ? type : "";
  const text = typeof thinking === "string" ? thinking : "";
  const sig = typeof signature === "string" ? signature : "";
  const r = redacted === true ? "1" : "0";
  // Use 0x00 separators so any field's value cannot collide with the
  // delimiter (UTF-16 NUL never appears in Anthropic content blocks).
  return `${t}\x00${text}\x00${sig}\x00${r}`;
}

/** Safe shallow read of a record field without throwing on null/undefined. */
function readField(block: unknown, field: string): unknown {
  if (block === null || typeof block !== "object") return undefined;
  // eslint-disable-next-line security/detect-object-injection -- field is a literal constant from caller below
  return (block as Record<string, unknown>)[field];
}

/** Best-effort logger.error invocation -- swallows logger errors. */
function safeLog(deps: AssertDeps, payload: Record<string, unknown>, msg: string): void {
  try {
    deps.logger.error(payload, msg);
  } catch {
    // Diagnostic must not abort agent flow even if the logger itself fails.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hashes for every `type:"thinking"` block in `content`.
 *
 * Mirrors signature-surrogate-guard's exclusion rule: skips non-thinking
 * blocks AND skips blocks where `redacted === true` (no readable text). The
 * resulting `blockIndex` field counts position WITHIN the thinking-only
 * stream, so callers can compare positionally even when the surrounding mix
 * of text/tool blocks varies between turns.
 *
 * Pure: never mutates input, never throws. Returns an empty array when
 * `content` is empty or contains no thinking blocks.
 */
export function computeThinkingBlockHashes(
  content: ReadonlyArray<Record<string, unknown>> | undefined | null,
): ThinkingBlockHash[] {
  if (!Array.isArray(content)) return [];
  const result: ThinkingBlockHash[] = [];
  let thinkingIndex = 0;
  for (const block of content) {
    const type = readField(block, "type");
    if (type !== "thinking") continue;
    if (readField(block, "redacted") === true) continue;
    const thinking = readField(block, "thinking");
    const signature = readField(block, "thinkingSignature");
    const input = buildHashInput(type, thinking, signature, readField(block, "redacted"));
    const hash = createHash("sha256").update(input).digest("hex");
    const textStr = typeof thinking === "string" ? thinking : "";
    const sigStr = typeof signature === "string" ? signature : "";
    result.push({
      blockIndex: thinkingIndex,
      hash,
      textFirstChars: textStr.slice(0, TEXT_PREFIX_LEN),
      sigLen: sigStr.length,
    });
    thinkingIndex++;
  }
  return result;
}

/**
 * Compare prior captured hashes against the current shape of `content`.
 *
 * Logs ONE structured ERROR per mismatched index. When `prior` is empty,
 * this is a no-op (no hashes were captured for this responseId, so there's
 * nothing to verify). When `current` has fewer thinking blocks than `prior`,
 * each missing index is reported with `newHash:null`, `newText.firstChars:""`,
 * `newSigLen:0`.
 *
 * Never throws. Never mutates `prior` or `current`.
 */
export function assertThinkingBlocksUnchanged(
  prior: ReadonlyArray<ThinkingBlockHash>,
  current: ReadonlyArray<Record<string, unknown>> | undefined | null,
  responseId: string | undefined,
  deps: AssertDeps,
): void {
  if (!Array.isArray(prior) || prior.length === 0) return;
  const currentHashes = computeThinkingBlockHashes(current);
  const byIndex = new Map<number, ThinkingBlockHash>();
  for (const h of currentHashes) byIndex.set(h.blockIndex, h);

  for (const old of prior) {
    const now = byIndex.get(old.blockIndex);
    if (!now) {
      safeLog(
        deps,
        {
          module: MODULE_FIELD,
          responseId,
          blockIndex: old.blockIndex,
          oldHash: old.hash,
          newHash: null,
          oldText: { firstChars: old.textFirstChars },
          newText: { firstChars: "" },
          oldSigLen: old.sigLen,
          newSigLen: 0,
          errorKind: ERROR_KIND,
          hint: HINT,
        },
        "Thinking block mutated between turns",
      );
      continue;
    }
    if (now.hash !== old.hash) {
      safeLog(
        deps,
        {
          module: MODULE_FIELD,
          responseId,
          blockIndex: old.blockIndex,
          oldHash: old.hash,
          newHash: now.hash,
          oldText: { firstChars: old.textFirstChars },
          newText: { firstChars: now.textFirstChars },
          oldSigLen: old.sigLen,
          newSigLen: now.sigLen,
          errorKind: ERROR_KIND,
          hint: HINT,
        },
        "Thinking block mutated between turns",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 260428-hoy: Canonical thinking-block restoration
//
// Heals cross-turn mutation of signed thinking blocks before pi-ai serializes
// the next API request. Pure / idempotent / never-throws. Runs AFTER
// `assertThinkingBlocksUnchanged` so the diagnostic ERROR log captures every
// mutation before the heal overwrites it.
// ---------------------------------------------------------------------------

const RESTORE_MODULE_FIELD = "agent.bridge.canonical-restore";

const RESTORE_WARN_HINT =
  "Canonical restore aborted on malformed input; in-memory messages " +
  "returned unchanged. Inspect prior context-engine layers for shape drift.";

/** Logger surface required by `restoreCanonicalThinkingBlocks`. Both methods
 *  optional; the helper is a silent no-op when omitted. */
export interface RestoreDeps {
  logger?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/** Result shape returned by `restoreCanonicalThinkingBlocks`. */
export interface RestoreResult {
  /** SAME reference as input when no swap happened, otherwise a new top-level array. */
  messages: unknown[];
  /** Total number of thinking blocks replaced across all messages. */
  restoredCount: number;
  /** Distinct responseIds that had at least one swap, in walk order. */
  affectedResponseIds: string[];
}

/** Best-effort logger.info / logger.warn -- swallows logger errors. */
function safeRestoreLog(
  deps: RestoreDeps | undefined,
  level: "info" | "warn",
  payload: Record<string, unknown>,
  msg: string,
): void {
  const logger = deps?.logger;
  if (!logger) return;
  try {
    if (level === "info") logger.info(payload, msg);
    else logger.warn(payload, msg);
  } catch {
    // Restore must never abort agent flow even if the logger itself fails.
  }
}

/**
 * Replace mutated thinking blocks with their canonical snapshot, in-memory only.
 *
 * Pure: never mutates input arrays or block objects. Idempotent: when canonical
 * matches in-memory exactly, returns `{ messages: <same ref>, restoredCount: 0,
 * affectedResponseIds: [] }`. On at least one swap, returns a NEW top-level
 * array AND a NEW content array on each affected message.
 *
 * Replaces ONLY blocks where BOTH `current[i].type === "thinking"` AND
 * `canonical[i].type === "thinking"` AND `current[i].redacted !== true` AND
 * `canonical[i].redacted !== true`. Text blocks, tool_use, tool_result,
 * redacted_thinking, and any block where positional types disagree are passed
 * through unchanged.
 *
 * Skips messages where `role !== "assistant"`, where `responseId` is not a
 * string, or where the canonical store has no entry for that responseId.
 *
 * Never throws. On any unexpected error during the walk (e.g. malformed
 * canonical entry whose getter throws), the entire result is `{ messages:
 * <input ref>, restoredCount: 0, affectedResponseIds: [] }` and ONE WARN log
 * fires with `module: RESTORE_MODULE_FIELD, errorKind: "internal"`.
 */
export function restoreCanonicalThinkingBlocks(
  messages: ReadonlyArray<unknown> | undefined | null,
  canonicalStore: ReadonlyMap<string, ReadonlyArray<unknown>>,
  deps?: RestoreDeps,
): RestoreResult {
  if (!Array.isArray(messages)) {
    return { messages: [], restoredCount: 0, affectedResponseIds: [] };
  }

  try {
    let result: unknown[] | null = null; // lazy copy-on-write
    let restoredCount = 0;
    const seenResponseIds = new Set<string>();
    const affectedResponseIds: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      // eslint-disable-next-line security/detect-object-injection -- numeric index
      const msg = messages[i];
      const swapMsg = tryRestoreMessage(msg, canonicalStore);
      if (swapMsg.didSwap) {
        if (result === null) {
          // Materialize a copy of the prefix and switch to copy-on-write.
          result = messages.slice(0, i);
        }
        result.push(swapMsg.message);
        restoredCount += swapMsg.swapsInMessage;
        const rid = swapMsg.responseId;
        if (rid !== undefined && !seenResponseIds.has(rid)) {
          seenResponseIds.add(rid);
          affectedResponseIds.push(rid);
        }
      } else if (result !== null) {
        result.push(msg);
      }
    }

    if (result === null) {
      // No swap happened -- preserve exact input reference for caller's
      // identity-equality check.
      return {
        messages: messages as unknown[],
        restoredCount: 0,
        affectedResponseIds: [],
      };
    }

    safeRestoreLog(
      deps,
      "info",
      {
        module: RESTORE_MODULE_FIELD,
        restoredCount,
        affectedResponseIds,
      },
      "Restored canonical thinking blocks before resend",
    );

    return { messages: result, restoredCount, affectedResponseIds };
  } catch {
    // Defensive last-resort: malformed canonical entry or any other thrown
    // error during the walk. Return the in-memory shape unchanged + WARN log.
    safeRestoreLog(
      deps,
      "warn",
      {
        module: RESTORE_MODULE_FIELD,
        errorKind: "internal",
        hint: RESTORE_WARN_HINT,
      },
      "Canonical restore aborted on malformed input",
    );
    return {
      messages: messages as unknown[],
      restoredCount: 0,
      affectedResponseIds: [],
    };
  }
}

/** Internal: per-message restore walk. */
interface TryRestoreOutcome {
  didSwap: boolean;
  message: unknown;
  swapsInMessage: number;
  responseId: string | undefined;
}

function tryRestoreMessage(
  msg: unknown,
  canonicalStore: ReadonlyMap<string, ReadonlyArray<unknown>>,
): TryRestoreOutcome {
  const noSwap: TryRestoreOutcome = {
    didSwap: false,
    message: msg,
    swapsInMessage: 0,
    responseId: undefined,
  };

  if (msg === null || typeof msg !== "object") return noSwap;

  const role = readField(msg, "role");
  if (role !== "assistant") return noSwap;

  const responseId = readField(msg, "responseId");
  if (typeof responseId !== "string") return noSwap;

  const canonical = canonicalStore.get(responseId);
  if (!canonical) return noSwap;
  if (!Array.isArray(canonical)) return noSwap;

  const liveContent = readField(msg, "content");
  if (!Array.isArray(liveContent)) return noSwap;

  // Walk content arrays in parallel; produce a copy-on-write content array.
  let healedContent: unknown[] | null = null;
  let swapsInMessage = 0;
  const len = liveContent.length;
  for (let j = 0; j < len; j++) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index
    const liveBlock = liveContent[j];
    // eslint-disable-next-line security/detect-object-injection -- numeric index
    const canonicalBlock = j < canonical.length ? canonical[j] : undefined;

    if (!shouldSwapBlock(liveBlock, canonicalBlock)) {
      if (healedContent !== null) healedContent.push(liveBlock);
      continue;
    }

    if (healedContent === null) {
      healedContent = liveContent.slice(0, j);
    }
    healedContent.push(canonicalBlock);
    swapsInMessage++;
  }

  if (healedContent === null) return noSwap;

  // Shallow-copy the message with new content; preserve all other fields.
  const newMsg: Record<string, unknown> = { ...(msg as Record<string, unknown>) };
  newMsg.content = healedContent;

  return {
    didSwap: true,
    message: newMsg,
    swapsInMessage,
    responseId,
  };
}

/** Decide whether to replace `live[j]` with `canonical[j]`. */
function shouldSwapBlock(liveBlock: unknown, canonicalBlock: unknown): boolean {
  if (liveBlock === canonicalBlock) return false; // identity short-circuit
  const liveType = readField(liveBlock, "type");
  if (liveType !== "thinking") return false;
  const canonicalType = readField(canonicalBlock, "type");
  if (canonicalType !== "thinking") return false;
  if (readField(liveBlock, "redacted") === true) return false;
  if (readField(canonicalBlock, "redacted") === true) return false;

  // Compare hashes via the existing four-field tuple. If they match, no swap.
  const liveHash = blockHash(liveBlock);
  const canonicalHash = blockHash(canonicalBlock);
  return liveHash !== canonicalHash;
}

/** Compute the same SHA-256 four-field hash used by computeThinkingBlockHashes
 *  for a single block. Pure helper -- read fields directly without throwing. */
function blockHash(block: unknown): string {
  const type = readField(block, "type");
  const thinking = readField(block, "thinking");
  const signature = readField(block, "thinkingSignature");
  const redacted = readField(block, "redacted");
  const input = buildHashInput(type, thinking, signature, redacted);
  return createHash("sha256").update(input).digest("hex");
}
