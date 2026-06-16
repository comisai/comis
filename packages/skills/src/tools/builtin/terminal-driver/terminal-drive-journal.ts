// SPDX-License-Identifier: Apache-2.0
/**
 * The pure bounded content-free drive-state journal (DRIVE-01; design §4 Phase B,
 * CONTEXT §7.1.6).
 *
 * A *promoted* drive's woken turns are near-stateless: read screen digest + journal →
 * decide → act → update journal. The journal is that drive's CROSS-WAKE MEMORY — a
 * bounded, content-free rolling record, NOT an accumulating conversation. A 40h drive
 * accumulates thousands of woken turns; if each appended to a conversation, context
 * would blow. The journal holds only the MINIMAL rolling set
 * (`{objective, lastClassification, lastScreenDigest, answeredPrompts[], stepsTried[],
 * elapsedMs, interactions, costUsd, truncations}`) so 40h of wakes stays within budget.
 *
 * This module is the SHAPE + the pure (de)serialize/append/trim ONLY. The daemon-side
 * in-memory holder (the closure-local `Map<sessionId, DriveJournal>` the wake dispatcher
 * reads/updates) is plan 06; the durable persistence beside `terminal-workspace.ts` is
 * Phase 165 (DUR-02) — which is exactly why this shape is cleanly serializable now and
 * {@link deserializeJournal} is defensive enough to read a corrupted-after-crash file.
 * NO fs write happens here.
 *
 * The three load-bearing properties:
 *   - BOUNDED (I7, Pitfall 3; MR-03): {@link appendAnswered}/{@link appendStep} oldest-trim
 *     at {@link CAP_ANSWERED}/{@link CAP_STEPS} (the array-COUNT bound) AND clip each entry
 *     to {@link TAG_MAX} bytes (the per-entry SIZE bound). An over-cap drop OR an over-size
 *     clamp increments the run-total `truncations` breadcrumb — NEVER a silent unbounded
 *     append and NEVER a silent full-size keep. So the serialized journal size is a function
 *     of the caps × {@link TAG_MAX} REGARDLESS of caller convention (a future caller that
 *     hands a multi-kilobyte tag, or a corrupted-after-crash file, is clamped on the way in),
 *     not merely by the live caller passing short tags. After 10_000 appends each array is
 *     still ≤ its cap and each entry ≤ {@link TAG_MAX} bytes.
 *   - CONTENT-FREE (I3): the journal stores enums/ids/counts/durations + normalized
 *     prompt/step TAGS + a (caller-supplied, already-redacted) one-line `lastScreenDigest`
 *     ONLY — never raw TUI bytes, command output, secrets, or keystrokes. The caller (the
 *     woken-turn driver, plan 06) runs `scrubSecretsFromText` before handing a tag/digest
 *     in; this module treats every tag as an OPAQUE short string and never re-expands it.
 *   - TOTAL (de)serialize (the DUR-02 recovery contract): {@link serializeJournal} →
 *     {@link deserializeJournal} round-trips; a malformed/partial persisted object yields
 *     a SAFE default journal and NEVER throws — mirroring the {@link mapWaitReply}
 *     discipline (terminal-wait-reply.ts:60-84): read each field, default oddities to the
 *     safe value, never coerce a malformed array to garbage.
 *
 * `lastClassification` is the SHIPPED classifier state union
 * ({@link ClassifierState}, terminal-classifier.ts:75) — this module does NOT invent a
 * new state (I8).
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors
 * `terminal-loop-guard.ts` / `terminal-dialog-detector.ts`):
 *   - PURE: free functions, NOT a factory. NO module-global mutable state. NO clock/timer
 *     reads — `elapsedMs` is a content-free number the CALLER derives from its own
 *     injected clock (this module never reads a wall-clock global; the `globals`
 *     architecture gate forbids it).
 *   - IMMUTABLE: every mutator returns a NEW journal; an input journal is never mutated.
 *   - NEVER throws: a degenerate input (empty objective, malformed deserialize payload)
 *     yields the SAFE shape — total.
 *   - Infra-free: value-imports NOTHING (node builtins only if ever needed) — no platform
 *     runtime packages, no observability egress (the infra-runtime-scope architecture
 *     gate; this file names none of them). `ClassifierState` is a TYPE-only import.
 *
 * @module
 */

import type { ClassifierState } from "./terminal-classifier.js";

// ---------------------------------------------------------------------------
// Caps (I7) — documented constants, like terminal-loop-guard's window/max.
// ---------------------------------------------------------------------------

/**
 * Max retained `answeredPrompts` tags. Over-cap appends oldest-trim and bump the
 * run-total `truncations` breadcrumb (never a silent drop). 64 normalized prompt-hashes
 * is far more than any genuine drive re-answers — it exists to cap a pathological/looping
 * drive, not to bound normal use. The serialized journal size is a function of this cap,
 * NOT of the number of wakes (the unbounded-growth defense, Pitfall 3).
 */
export const CAP_ANSWERED = 64;

/**
 * Max retained `stepsTried` tags. Same oldest-trim + breadcrumb discipline as
 * {@link CAP_ANSWERED}. Short enum/tag steps (e.g. `"ran:build"`), never raw command
 * output (I3).
 */
export const CAP_STEPS = 64;

/**
 * Max BYTE size of a SINGLE stored entry — a tag (`answeredPrompts`/`stepsTried`), the
 * `objective`, or `lastScreenDigest` (MR-03 / I7). The caps above bound the array COUNT;
 * this bounds the size of EACH entry, so the serialized-journal-size guarantee (the
 * module's "size is a function of the caps" claim) holds REGARDLESS of caller convention
 * — a future caller that hands a multi-kilobyte tag, or a corrupted-after-crash file with
 * long entries, is CLAMPED here rather than blowing the byte ceiling the module promises
 * (the gap the `mapWaitReply`-style discipline previously stopped one step short of). 256
 * bytes is far more than a normalized prompt-hash / step-tag / one-line digest needs (the
 * live caller passes ≤80-char digests + short enum tags); it exists to clip a pathological
 * entry, not to bound normal use. A clamp is recorded on the `truncations` breadcrumb
 * (never a silent full-size keep), mirroring `DIGEST_EXCERPT_MAX` in `terminal-read-digest.ts`.
 */
export const TAG_MAX = 256;

/** The safe default classification for a fresh / unreadable journal (I8 — a shipped state). */
const DEFAULT_CLASSIFICATION: ClassifierState = "working";

/**
 * Clip a string to at most {@link TAG_MAX} BYTES on a UTF-8 char boundary (never a split
 * multibyte glyph), returning `{ value, clamped }` where `clamped` is `true` iff the input
 * exceeded the cap. Pure; total; never throws (a non-string yields `{ "", false }`).
 * Byte-accurate (not `.length`, which counts UTF-16 code units) because a tag/digest is
 * attacker-influenceable TUI-derived text and the cap is a payload-size guard — mirrors
 * `capWithBreadcrumb` in `terminal-read-digest.ts`.
 */
function clipTag(tag: string): { value: string; clamped: boolean } {
  if (typeof tag !== "string") return { value: "", clamped: false };
  if (Buffer.byteLength(tag, "utf8") <= TAG_MAX) return { value: tag, clamped: false };
  // Slice the leading bytes, then decode losslessly — a trailing partial multibyte
  // sequence is dropped, keeping the result ≤ TAG_MAX bytes and never a split glyph.
  const value = Buffer.from(tag, "utf8").subarray(0, TAG_MAX).toString("utf8");
  return { value, clamped: true };
}

/** Clip a scalar field ({@link clipTag}) for the constructors / deserialize — just the value. */
function clipField(value: string): string {
  return clipTag(value).value;
}

// ---------------------------------------------------------------------------
// The shape (CONTEXT §7.1.6 — the MINIMAL rolling set; content-free per I3).
// ---------------------------------------------------------------------------

/**
 * A promoted drive's bounded, content-free cross-wake memory. Every field is an
 * enum / id / count / duration / normalized tag / a redacted one-liner — NEVER raw TUI
 * bytes, command output, secrets, or keystrokes (I3). This is the resume substrate
 * Phase 165 (DUR-02) persists durably; keep it cleanly serializable.
 */
export interface DriveJournal {
  /** A short content-free label for the drive (NOT raw TUI bytes). */
  objective: string;
  /** The last classifier verdict — the SHIPPED state union (I8 — never an invented state). */
  lastClassification: ClassifierState;
  /**
   * A REDACTED one-line digest of the last rendered screen (READ-01 / plan 03 produces
   * it; the caller runs `scrubSecretsFromText` before it lands here). Never the grid.
   */
  lastScreenDigest: string;
  /** Normalized prompt-hashes/tags already answered (no raw prompt text). Capped (I7). */
  answeredPrompts: string[];
  /** Enum/short-tag steps already tried (no raw command output). Capped (I7). */
  stepsTried: string[];
  /** Total wall-time the drive has run, in ms (a content-free number the caller derives). */
  elapsedMs: number;
  /** Count of auto-answer interactions across the drive. */
  interactions: number;
  /** Accumulated spend across the drive, in USD. */
  costUsd: number;
  /**
   * I7 breadcrumb — the run-total count of tag entries dropped by oldest-trim across
   * BOTH arrays. A non-zero value means the drive exceeded a cap; it is NEVER a silent
   * drop.
   */
  truncations: number;
}

// ---------------------------------------------------------------------------
// Constructors + mutators (pure, immutable, never throw).
// ---------------------------------------------------------------------------

/**
 * The safe initial journal for a freshly-promoted drive: empty arrays, zero counts,
 * `lastClassification` defaulting to the shipped `"working"` state, an empty digest.
 *
 * @param objective - A short content-free label for the drive.
 */
export function emptyJournal(objective: string): DriveJournal {
  return {
    // MR-03: clamp the objective to the per-entry byte bound (a degenerate/over-long
    // objective cannot blow the serialized-size guarantee).
    objective: clipField(typeof objective === "string" ? objective : ""),
    lastClassification: DEFAULT_CLASSIFICATION,
    lastScreenDigest: "",
    answeredPrompts: [],
    stepsTried: [],
    elapsedMs: 0,
    interactions: 0,
    costUsd: 0,
    truncations: 0,
  };
}

/**
 * Append a tag to a capped array, oldest-trimming at `cap` (the COUNT bound) AND clipping
 * the appended tag to {@link TAG_MAX} bytes (the per-entry SIZE bound, MR-03). Returns
 * `{ next, dropped }` where `dropped` is the count of entries removed by oldest-trim PLUS
 * 1 if the appended tag was byte-clamped — so a clamp, like a drop, lands on the
 * `truncations` breadcrumb (never a silent full-size keep, I7). Pure — never mutates `arr`.
 * Models terminal-loop-guard's bounded ring, but reports the drop/clamp count.
 */
function appendCapped(arr: readonly string[], tag: string, cap: number): { next: string[]; dropped: number } {
  const { value, clamped } = clipTag(tag);
  const clampDrop = clamped ? 1 : 0;
  const grown = [...arr, value];
  if (grown.length <= cap) {
    return { next: grown, dropped: clampDrop };
  }
  const trimDropped = grown.length - cap;
  // Oldest-trim: keep the newest `cap` entries (drop from the front).
  return { next: grown.slice(trimDropped), dropped: trimDropped + clampDrop };
}

/**
 * Append a normalized prompt tag to `answeredPrompts`, oldest-trimming at
 * {@link CAP_ANSWERED} and incrementing `truncations` by the drop count. Returns a NEW
 * journal (immutable). The caller supplies an already-normalized/redacted tag (I3); this
 * function stores it opaquely and never re-expands it.
 */
export function appendAnswered(j: DriveJournal, promptTag: string): DriveJournal {
  const { next, dropped } = appendCapped(j.answeredPrompts, promptTag, CAP_ANSWERED);
  return { ...j, answeredPrompts: next, truncations: j.truncations + dropped };
}

/**
 * Append a step tag to `stepsTried`, oldest-trimming at {@link CAP_STEPS} and
 * incrementing `truncations` by the drop count. Returns a NEW journal (immutable).
 */
export function appendStep(j: DriveJournal, stepTag: string): DriveJournal {
  const { next, dropped } = appendCapped(j.stepsTried, stepTag, CAP_STEPS);
  return { ...j, stepsTried: next, truncations: j.truncations + dropped };
}

/**
 * Apply a content-free scalar-field patch (classification / digest / counts) and return a
 * NEW journal (immutable). Only the whitelisted content-free fields are patchable — the
 * arrays + the `objective` + the `truncations` breadcrumb are NOT settable here (they
 * flow through {@link appendAnswered}/{@link appendStep}). An empty patch is a no-op
 * clone. Never throws.
 */
export function updateJournal(
  j: DriveJournal,
  patch: Partial<Pick<DriveJournal, "lastClassification" | "lastScreenDigest" | "elapsedMs" | "interactions" | "costUsd">>,
): DriveJournal {
  return {
    ...j,
    ...(patch.lastClassification !== undefined ? { lastClassification: patch.lastClassification } : {}),
    // MR-03: clamp the digest to the per-entry byte bound (the caller hands an ≤80-char
    // redacted one-liner today; clip a pathological digest so the size guarantee holds).
    ...(typeof patch.lastScreenDigest === "string" ? { lastScreenDigest: clipField(patch.lastScreenDigest) } : {}),
    ...(typeof patch.elapsedMs === "number" ? { elapsedMs: patch.elapsedMs } : {}),
    ...(typeof patch.interactions === "number" ? { interactions: patch.interactions } : {}),
    ...(typeof patch.costUsd === "number" ? { costUsd: patch.costUsd } : {}),
  };
}

// ---------------------------------------------------------------------------
// (De)serialize (the DUR-02-ready shape) — pure, total, defensive.
// ---------------------------------------------------------------------------

/** Serialize a journal to a JSON string. Pure; no fs write (Phase 165 persists it). */
export function serializeJournal(j: DriveJournal): string {
  return JSON.stringify(j);
}

/** Read a value as a finite number, else fall back to the safe default. */
function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Read a value as an array of STRINGS, dropping non-string entries (never coerced to
 * `"[object Object]"`), then oldest-trim to `cap` (a corrupted-large persisted array
 * cannot blow the count cap) AND clip each entry to {@link TAG_MAX} bytes (MR-03 — a
 * corrupted-after-crash file with long entries cannot blow the per-entry byte bound).
 * A non-array yields `[]`.
 */
function stringArrayCapped(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const strings = v.filter((e): e is string => typeof e === "string").map(clipField);
  return strings.length > cap ? strings.slice(strings.length - cap) : strings;
}

/** True iff `v` is one of the SHIPPED classifier states (I8). */
function isClassifierState(v: unknown): v is ClassifierState {
  return v === "working" || v === "awaiting-input" || v === "exited" || v === "stuck";
}

/**
 * Defensively map a persisted/parsed value to a {@link DriveJournal}. Mirrors
 * {@link mapWaitReply}: read each field, DEFAULT oddities to the SAFE value, never throw,
 * never coerce a malformed array to garbage. Accepts either a JSON string (which it
 * parses, defaulting to `{}` on invalid JSON) or an already-parsed value (DUR-02, Phase
 * 165, may hand a parsed object). This is the read-side of the durable resume contract:
 * a corrupted-after-crash journal file yields a safe default journal, never an exception.
 */
export function deserializeJournal(raw: string | unknown): DriveJournal {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  }
  // A non-object (null, number, string, array) carries no recoverable fields → safe default.
  const r =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    // MR-03: clip the scalar string fields too — a corrupted file with a multi-kilobyte
    // objective/digest is clamped to the per-entry byte bound on read.
    objective: clipField(typeof r.objective === "string" ? r.objective : ""),
    lastClassification: isClassifierState(r.lastClassification) ? r.lastClassification : DEFAULT_CLASSIFICATION,
    lastScreenDigest: clipField(typeof r.lastScreenDigest === "string" ? r.lastScreenDigest : ""),
    answeredPrompts: stringArrayCapped(r.answeredPrompts, CAP_ANSWERED),
    stepsTried: stringArrayCapped(r.stepsTried, CAP_STEPS),
    elapsedMs: numberOr(r.elapsedMs, 0),
    interactions: numberOr(r.interactions, 0),
    costUsd: numberOr(r.costUsd, 0),
    truncations: numberOr(r.truncations, 0),
  };
}
