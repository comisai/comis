// SPDX-License-Identifier: Apache-2.0
/**
 * The normalized region-scoped loop/stuck guard.
 *
 * `createLoopGuard({ nowMs, windowMs?, maxRepeats? })` detects an auto-answer loop on a
 * RE-RENDERED prompt: the same *logical* prompt presented again is caught even when its
 * bytes differ only by a volatile region (a spinner glyph, a timestamp, an
 * elapsed/progress counter). `observe(sessionId, promptRegion)` normalizes the region
 * (strip the volatile bits, collapse whitespace), hashes the stable remainder, tracks
 * recent (hash, ts) per session in a window, and returns a typed
 * `{ repeat: true, reason: "loop_detected" }` once a normalized hash recurs within the
 * window — otherwise `{ repeat: false }`. The caller (the woken-turn driver) escalates
 * on a repeat (`terminal:escalated`, reason `loop_detected`).
 *
 * COMPOSES WITH (does NOT duplicate) the `maxInteractions` cap (terminal-caps.ts):
 * the cap EVICTs the session independently when its interaction budget is spent (via the
 * single audited `registry.evict(..., "max_interactions")` path); this guard is the
 * ADDITIVE detector that catches a tight re-render loop BEFORE the budget runs out, and
 * escalates to a human rather than evicting. Two independent defenses, no shared state.
 *
 * Architecture invariants (binding — AGENTS.md; mirrors
 * `terminal-caps.ts` / `terminal-ipc.ts`):
 *   - NO module-global mutable state. The recent-hash ring is a CLOSURE-local
 *     `Map<sessionId, RecentHash[]>` created inside the factory — two `createLoopGuard`
 *     instances never share state, two sessionIds never share a ring.
 *   - The injected `nowMs: () => number` is the ONLY clock source (no wall-clock global;
 *     the `globals` architecture gate forbids it — production passes `systemNowMs`, tests
 *     a fake clock). NO raw timer.
 *   - NEVER throws: `observe` returns a typed discriminant; the caller acts on it. A
 *     degenerate region hashes like any other (total).
 *   - Infra-free: value-imports ONLY node builtins (`node:crypto` for the stable hash)
 *     — no platform runtime packages, no observability egress (the infra-runtime-scope
 *     architecture gate; this file names none of them).
 *
 * @module
 */

import { createHash } from "node:crypto";

/** A recent normalized-hash sighting for a session (closure-local ring entry). */
interface RecentHash {
  hash: string;
  ts: number;
}

/** The dependencies + tunables. `nowMs` is required (injected clock); the rest default. */
export interface LoopGuardDeps {
  /** The injected wall-clock reader (epoch ms). Never a raw global. */
  nowMs: () => number;
  /**
   * The sliding window in ms within which a recurring normalized hash counts as a loop.
   * A sighting older than this decays out and never triggers a false repeat. Default 30s
   * — long enough to catch a tight re-render loop, short enough that a legitimately
   * re-visited prompt minutes later is not mistaken for a loop.
   */
  windowMs?: number;
  /**
   * How many PRIOR sightings of the same normalized hash (within the window) trip the
   * repeat. Default 1: the SECOND time a logical prompt is seen within the window is a
   * loop (the first primed the ring). Raising it tolerates N benign re-renders first.
   */
  maxRepeats?: number;
}

/** The loop guard's surface — exactly what the woken turn consumes. */
export interface LoopGuard {
  /**
   * Record a settled prompt region and report whether it is a (normalized) repeat
   * within the window. Never throws, never sends. On a repeat the caller escalates
   * (`terminal:escalated`, reason `loop_detected`).
   */
  observe(sessionId: string, promptRegion: string): { repeat: boolean; reason?: "loop_detected" };
  /** Clear a session's ring on kill/evict so the map never leaks and a re-used id is fresh. */
  forget(sessionId: string): void;
}

/** Default sliding window (30s). */
const DEFAULT_WINDOW_MS = 30_000;
/** Default prior-sighting count that trips the repeat (the 2nd sighting). */
const DEFAULT_MAX_REPEATS = 1;

// ---------------------------------------------------------------------------
// Normalization — strip the volatile regions so a re-render hashes stably
// ---------------------------------------------------------------------------
//
// The order matters: strip the STRUCTURED volatile tokens (ISO/clock timestamps,
// parenthesized elapsed counters, percentages, progress ratios) BEFORE the loose
// numeric/spinner passes, so a timestamp is not half-consumed by a ratio rule. The
// goal is to keep the prompt's STABLE skeleton (its words + affordance) and drop only
// the bits that tick on every frame.

/** ISO-8601 timestamps, e.g. `2026-06-03T12:00:01Z` / `...01.250Z`. */
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/gi;
/** Clock-style `HH:MM` / `HH:MM:SS` times. */
const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
/** Parenthesized elapsed counters, e.g. `(3s)` `(9s)` `(1.2s)` `(12m)` `(500ms)`. */
const PAREN_ELAPSED = /\(\s*\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)?\s*\)/gi;
/** Bare elapsed durations, e.g. `3s` `1.2s` `500ms` `12m` (word-bounded). */
const BARE_ELAPSED = /\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)\b/gi;
/** Percentages, e.g. `12%` `87.5%`. */
const PERCENTAGE = /\b\d+(?:\.\d+)?\s*%/g;
/** Progress ratios surrounded by whitespace, e.g. ` 3/10 ` (NOT `(y/n)` — that has no digits). */
const PROGRESS_RATIO = /(?<=\s)\d+\/\d+(?=\s|$)/g;
/** Braille spinner glyphs (the U+2800 block) — every common CLI spinner frame. */
const BRAILLE_SPINNER = /[⠀-⣿]+/g;
/** A standalone ASCII spinner token (`|` `/` `\` `-`) surrounded by whitespace. */
const ASCII_SPINNER = /(?<=^|\s)[|/\\-]+(?=\s|$)/g;
/** Any residual run of digits (a counter that escaped the structured passes). */
const RESIDUAL_DIGITS = /\d+/g;
/** Runs of whitespace to collapse to a single space. */
const WHITESPACE_RUN = /\s+/g;

/**
 * Normalize a prompt region to a stable skeleton: drop the volatile regions
 * (timestamps, spinners, elapsed/progress counters) and collapse whitespace, so a
 * frame that differs ONLY in those bits maps to the SAME string. Pure + total.
 */
function normalize(promptRegion: string): string {
  return promptRegion
    .replace(ISO_TIMESTAMP, "")
    .replace(PAREN_ELAPSED, "")
    .replace(PERCENTAGE, "")
    .replace(PROGRESS_RATIO, "")
    .replace(CLOCK_TIME, "")
    .replace(BARE_ELAPSED, "")
    .replace(BRAILLE_SPINNER, "")
    .replace(ASCII_SPINNER, "")
    .replace(RESIDUAL_DIGITS, "")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .toLowerCase();
}

/** A stable content hash of the normalized skeleton (sha-256 hex; no infra). */
function hashRegion(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * Create a normalized region-scoped loop guard. All state is CLOSURE-local (no
 * module-global); the injected `nowMs` is the only clock. `observe` never throws.
 *
 * @param deps - The injected clock + the optional window / repeat-count tunables.
 * @returns The {@link LoopGuard} surface.
 */
export function createLoopGuard(deps: LoopGuardDeps): LoopGuard {
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRepeats = deps.maxRepeats ?? DEFAULT_MAX_REPEATS;
  // Closure-local — NOT module scope (no module-global mutable state). One ring per
  // sessionId; two distinct createLoopGuard instances each get their own Map.
  const rings = new Map<string, RecentHash[]>();

  return {
    observe(sessionId: string, promptRegion: string): { repeat: boolean; reason?: "loop_detected" } {
      const now = deps.nowMs();
      const hash = hashRegion(normalize(promptRegion));

      // Drop sightings older than the window, then count remaining sightings of THIS hash.
      const previous = rings.get(sessionId) ?? [];
      const live = previous.filter((e) => now - e.ts <= windowMs);
      const priorSameHash = live.reduce((n, e) => (e.hash === hash ? n + 1 : n), 0);

      // Always record the new sighting (the ring tracks the latest, post-decay set).
      live.push({ hash, ts: now });
      rings.set(sessionId, live);

      if (priorSameHash >= maxRepeats) {
        return { repeat: true, reason: "loop_detected" };
      }
      return { repeat: false };
    },

    forget(sessionId: string): void {
      // No-op for an unknown id (never throws).
      rings.delete(sessionId);
    },
  };
}
