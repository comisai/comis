// SPDX-License-Identifier: Apache-2.0
/**
 * The pure bounded digest/diff read selector (READ-01; design §4 Phase B, §7.1
 * Open-Decision 3 RESOLVED → this plan).
 *
 * `boundedReadDigest(view, mode, byteCap?)` answers ONE question over a single
 * already-rendered read view (`{screen, diff?}`): what bounded text should a
 * woken drive turn see THIS wake? At 40h a drive is woken thousands of times, so
 * each read must stay cheap + bounded. Three modes:
 *   - `"digest"` (the DEFAULT) — the CURRENT rendered screen, bounded by the byte
 *     cap. NOT scrollback / the accumulating byte-stream: the tool-side read already
 *     returns the `cols×rows` emulator viewport (`scrollback` defaults to 0), so the
 *     "digest" is that viewport, guarded by the cap.
 *   - `"diff"` — ONLY the changed rows (`firstChangedRow..lastChangedRow`) of the
 *     SHIPPED {@link SnapshotDiff} the worker already attaches as `view.diff`
 *     (`terminal-worker-entry.ts` → `diffSnapshot`). We do NOT re-diff here (Don't
 *     Hand-Roll): the differ is `diffSnapshot` in `terminal-render.ts`; this module
 *     only SELECTS the changed-row slice. `changed:false` ⇒ an empty result; a
 *     missing `view.diff` ⇒ a defensive fall-back to the digest (never throws).
 *   - `"full"` — the screen as-is (opt-in for diagnosis), STILL byte-capped.
 *
 * Every mode passes through {@link capWithBreadcrumb}, modeled on
 * `perceptionScreen`'s bounded tail: an over-cap result is CLIPPED to the cap and
 * carries a `truncations` breadcrumb (the count of dropped bytes) — NEVER a silent
 * trim (I7). The byte cap is {@link READ_DIGEST_BYTE_CAP} (documented like
 * `PERCEPTION_RING_TAIL`); the emulator viewport is already `cols×rows`-bounded, so
 * the cap mostly guards a pathological `full`/`ansi` read.
 *
 * `screenDigestLine(view)` derives the content-free one-liner the journal stores as
 * `lastScreenDigest` (DRIVE-01 / I3): `"<rows>r <cols>c, <changed> changed,
 * cursor@(x,y)"` plus a SHORT excerpt of the first non-empty line — content-free BY
 * CONSTRUCTION (counts/coords; it never dumps the whole grid, T-164-08). The CALLER
 * (the woken-turn driver, plan 06) runs `scrubSecretsFromText` over the excerpt
 * before it reaches the journal/notification — the excerpt this module emits is
 * deliberately short, not pre-redacted (redaction is the wiring layer's job, RESEARCH
 * Pattern 4 / Don't Hand-Roll: `scrubSecretsFromText` is the canonical redactor).
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors
 * `terminal-dialog-detector.ts` / `terminal-settle.ts`'s pure helpers):
 *   - PURE: free functions, NOT factories. NO clock/timer reads, NO module-global
 *     mutable state, NO I/O.
 *   - NEVER throws: a degenerate view (`{screen:""}`, a missing/`changed:false`
 *     diff, an out-of-range changed range) yields the SAFE bounded result.
 *   - Infra-free: value-imports ONLY node builtins (`Buffer`) + a TYPE-ONLY
 *     `SnapshotDiff` from `terminal-render.js` — no platform runtime packages, no
 *     observability egress, no raw timer (the globals + infra-runtime-scope gates).
 *
 * @module
 */

import type { SnapshotDiff } from "./terminal-render.js";

// ---------------------------------------------------------------------------
// Bounds (documented constants, the I7 anti-unbounded guarantee).
// ---------------------------------------------------------------------------

/**
 * The default read-result byte cap. Modeled on `PERCEPTION_RING_TAIL` (8192) in
 * `terminal-render.ts`: a documented, bounded ceiling so a woken-turn read NEVER
 * offloads / blows context, even on a pathological `full`/`ansi` read. An over-cap
 * read is clipped with a `truncations` breadcrumb — never a silent trim (I7).
 */
export const READ_DIGEST_BYTE_CAP = 8192;

/** The max excerpt length the content-free `screenDigestLine` carries (a one-liner, not a grid). */
const DIGEST_EXCERPT_MAX = 80;

// ---------------------------------------------------------------------------
// Types — the READ-01 read-mode selector contract.
// ---------------------------------------------------------------------------

/**
 * The drive read mode. `"digest"` (the default) is the bounded current screen;
 * `"diff"` is only the changed rows since the last wake; `"full"` is the whole
 * screen (opt-in, still byte-capped). Mirrors the `drive.readMode` config enum
 * (plan 05).
 */
export type DriveReadMode = "digest" | "diff" | "full";

/**
 * The bounded read result. `screen` is the selected text (the bounded current
 * screen for `digest`, only the changed rows for `diff`, the whole screen for
 * `full`) AFTER the byte cap. `truncated` is the I7 breadcrumb flag — `true` iff
 * the byte cap clipped the result; `truncations` is the explicit count of dropped
 * bytes (present only when `truncated`). `mode` echoes the selected mode.
 */
export interface ReadDigest {
  /** The bounded selected text (capped per the mode). */
  screen: string;
  /** I7 breadcrumb — `true` when the byte cap clipped the result. */
  truncated: boolean;
  /** The count of dropped bytes when clipped (the explicit anti-silent-trim breadcrumb). */
  truncations?: number;
  /** The mode that produced this result. */
  mode: DriveReadMode;
}

// ---------------------------------------------------------------------------
// The byte cap (the bounded-tail discipline, modeled on perceptionScreen).
// ---------------------------------------------------------------------------

/**
 * Clip `text` to at most `byteCap` BYTES, returning `{screen, truncated, truncations}`.
 * Under the cap ⇒ verbatim, `truncated:false`, no breadcrumb. Over the cap ⇒ the
 * leading `byteCap` bytes (clipped on a UTF-8 char boundary so we never emit a split
 * multibyte glyph) with `truncated:true` and `truncations` = the count of dropped
 * bytes — the I7 anti-silent-trim breadcrumb. Pure; never throws (a non-positive cap
 * clips to empty with the full byte count as the breadcrumb).
 *
 * Byte-accurate (not `.length`, which counts UTF-16 code units) because the screen is
 * attacker-influenceable TUI text that may contain multibyte glyphs and the cap is a
 * payload-size guard. For ASCII, byte length === `.length`, so the breadcrumb is the
 * intuitive dropped-character count.
 */
function capWithBreadcrumb(
  text: string,
  byteCap: number,
): { screen: string; truncated: boolean; truncations?: number } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (byteCap >= totalBytes) return { screen: text, truncated: false };

  const cap = byteCap > 0 ? byteCap : 0;
  // Slice on a char boundary at-or-under the byte cap: take the leading bytes, then
  // decode losslessly (a trailing partial multibyte sequence is dropped, keeping the
  // result ≤ cap bytes and never a split glyph).
  const buf = Buffer.from(text, "utf8");
  const head = buf.subarray(0, cap).toString("utf8");
  // toString may drop a trailing partial codepoint; re-measure so the breadcrumb is honest.
  const keptBytes = Buffer.byteLength(head, "utf8");
  return { screen: head, truncated: true, truncations: totalBytes - keptBytes };
}

// ---------------------------------------------------------------------------
// The READ-01 selector.
// ---------------------------------------------------------------------------

/**
 * The number of changed rows a {@link SnapshotDiff} spans (inclusive range), or 0
 * when nothing changed / the diff is absent. Pure; total.
 */
function changedRowCount(d: SnapshotDiff | undefined): number {
  if (d === undefined || !d.changed || d.firstChangedRow < 0) return 0;
  return Math.max(0, d.lastChangedRow - d.firstChangedRow + 1);
}

/**
 * Select + bound the text a woken drive turn should see this wake — READ-01.
 *
 * `"digest"` ⇒ the current `view.screen` (the bounded viewport). `"diff"` ⇒ only the
 * changed rows `[firstChangedRow..lastChangedRow]` of `view.diff` (split on `"\n"`,
 * sliced); `changed:false` ⇒ an empty result; a missing `view.diff` ⇒ a defensive
 * fall-back to the digest. `"full"` ⇒ the screen as-is. EVERY mode then passes
 * through the byte cap, so an over-cap result is clipped with a `truncations`
 * breadcrumb — never a silent trim (I7).
 *
 * Pure + total: never throws on a degenerate view (`{screen:""}`, a missing diff, an
 * out-of-range changed range) — it yields the safe bounded result.
 *
 * @param view - The already-rendered read view: the current `screen` + the optional
 *   per-read `diff` the worker attached (`diffSnapshot(state.lastSnapshot, snap)`).
 * @param mode - The drive read mode (`drive.readMode`); `digest` is the default.
 * @param byteCap - The byte ceiling; defaults to {@link READ_DIGEST_BYTE_CAP}.
 * @returns The bounded {@link ReadDigest}.
 */
export function boundedReadDigest(
  view: { screen: string; diff?: SnapshotDiff },
  mode: DriveReadMode,
  byteCap: number = READ_DIGEST_BYTE_CAP,
): ReadDigest {
  const screen = view.screen ?? "";
  let selected: string;

  if (mode === "diff") {
    const d = view.diff;
    if (d === undefined) {
      // Defensive: no diff attached (e.g. the emulator-absent fallback) — degrade to
      // the bounded current-screen digest rather than throw or return nothing.
      selected = screen;
    } else if (!d.changed || d.firstChangedRow < 0) {
      // Honest no-change: nothing changed since the last wake ⇒ an empty result.
      selected = "";
    } else {
      const lines = screen.split("\n");
      // Clamp the range to the actual rows (a degenerate diff never indexes out of bounds).
      const first = Math.max(0, d.firstChangedRow);
      const last = Math.min(lines.length - 1, d.lastChangedRow);
      selected = first > last ? "" : lines.slice(first, last + 1).join("\n");
    }
  } else {
    // "digest" and "full" both start from the current screen; the cap bounds both.
    selected = screen;
  }

  const capped = capWithBreadcrumb(selected, byteCap);
  return {
    screen: capped.screen,
    truncated: capped.truncated,
    ...(capped.truncations !== undefined ? { truncations: capped.truncations } : {}),
    mode,
  };
}

// ---------------------------------------------------------------------------
// The content-free one-line screen digest (the journal's lastScreenDigest, I3).
// ---------------------------------------------------------------------------

/**
 * Derive the content-free one-line screen digest the journal stores as
 * `lastScreenDigest` (DRIVE-01 / I3): `"<rows>r <cols>c, <changed> changed,
 * cursor@(x,y)"` plus a SHORT (≤ {@link DIGEST_EXCERPT_MAX}-char) excerpt of the
 * first non-empty line. Content-free BY CONSTRUCTION — counts/coords + a short
 * excerpt, NEVER the whole grid (T-164-08). The CALLER (plan 06) runs
 * `scrubSecretsFromText` over the excerpt before it reaches the journal/notification;
 * this function does not redact (it only bounds), per the layer split.
 *
 * Pure + total: a degenerate view (`{screen:""}`, missing geometry/cursor/diff)
 * yields a safe single-line string; never throws.
 *
 * @param view - The read view: `screen` + optional `cols`/`rows`/`cursor`/`diff`.
 * @returns A single-line, content-free digest string.
 */
export function screenDigestLine(view: {
  screen: string;
  cols?: number;
  rows?: number;
  cursor?: { x: number; y: number };
  diff?: SnapshotDiff;
}): string {
  const r = typeof view.rows === "number" ? view.rows : 0;
  const c = typeof view.cols === "number" ? view.cols : 0;
  const changed = changedRowCount(view.diff);
  const cx = view.cursor?.x ?? 0;
  const cy = view.cursor?.y ?? 0;

  const head = `${r}r ${c}c, ${changed} changed, cursor@(${cx},${cy})`;

  // A SHORT excerpt of the first non-empty line — bounded, single-line. Never the grid.
  const firstNonEmpty = (view.screen ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstNonEmpty === undefined) return head;
  const excerpt =
    firstNonEmpty.length > DIGEST_EXCERPT_MAX
      ? `${firstNonEmpty.slice(0, DIGEST_EXCERPT_MAX)}…`
      : firstNonEmpty;
  return `${head} | ${excerpt}`;
}
