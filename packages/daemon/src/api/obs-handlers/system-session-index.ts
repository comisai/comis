// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `readSessionIndexWindow` — the multi-day session-index aggregate reader.
 *
 * The activity half of the system health view. It generalizes the single-traceId
 * `resolveTraceToSession` (`obs-explain-resolve.ts`, which reads a 2-day horizon
 * and returns the FIRST matching sessionKey) into a WINDOWED aggregate: it reads
 * the N day-keyed `<dataDir>/logs/session-index.YYYY-MM-DD.jsonl` files spanning
 * the window `[systemDateFrom(sinceMs) .. today]`, parses ALL rows (not just one
 * traceId), and reduces them to:
 *
 *   - active agents              ← distinct `agentId` from `session_started`
 *   - active channels            ← distinct `channelType:channelId` from `session_started`
 *   - exit-reason distribution   ← histogram of `exitReason` from `session_ended`
 *   - turn / token totals        ← per-session dedup of `session_ended` (authoritative)
 *                                    + `turn_completed` (in-flight fallback)
 *
 * Source of the totals (the note for the SystemHealthReport handler):
 * the reader prefers the `session_ended` rows as the AUTHORITATIVE session-level
 * totals (one ended row carries the whole session's `turnCount`/`totalTokens`).
 * For a session that has NO end row yet (an in-flight session — the dominant
 * live case, e.g. a long-lived chat-API session that never destroys), it sums
 * the per-turn `turn_completed.inputTokens + outputTokens` instead. The two are
 * de-duped PER sessionId: a session that DOES have an end row uses the ended
 * totals only (never the live sum), so neither path double-counts. Summing only
 * `session_ended` would silently report 0 turns / 0 tokens for every
 * still-open session — including the busiest one on most systems. The reader
 * exposes `daysRead` / `daysMissing` so the coverage block can report an
 * honest partial read.
 *
 * Provenance: `synthetic === true` rows (harness/bench/test sessions) are
 * excluded by default — a REAL filter (the field IS present on session-index
 * rows, unlike the diagnostics row). `{ includeSynthetic: true }` is the admin
 * opt-in. The exclusion mirrors the `obs-explain-resolve.ts:81` precedent.
 *
 * Safety / determinism:
 *   - Path: `safePath(base, "logs", file)` on every segment (path.join is
 *     ESLint-banned); the day-key is a fixed `YYYY-MM-DD` derived from
 *     `systemDateFrom`, never a row field — no user-controlled path component.
 *   - Time: the window upper bound is the INJECTED `nowMs` (the caller's single
 *     clock instant) — so the day-key range is deterministic w.r.t. that clock.
 *     It defaults to the sanctioned-root `systemNowMs()` only for
 *     callers with no clock seam; day-keys are `systemDateFrom(...)` strings,
 *     NEVER `new Date()` / a raw `Date.now()` (the globals gate).
 *   - All reads soft-fail (`continue`, never throw): a missing day-file
 *     increments `daysMissing`; an unreadable file or a malformed JSONL line is
 *     skipped. The output is deterministic: agents/channels are sorted and the
 *     exit-reason histogram is emitted in a stable key order.
 *   - Bounded: the window is clamped to the most-recent `MAX_DAYS` day-keys, and
 *     at most `MAX_RECORDS` lines are accepted across the whole window (the
 *     `obs-explain-readers.ts:MAX_RECORDS` precedent) — a DoS-sized index cannot
 *     unbound the work.
 *
 * No logger: this mirrors every sibling reader in this directory
 * (`obs-explain-resolve.ts`, `obs-explain-readers.ts`, `obs-trace.ts` all
 * soft-fail silently and take no `Deps`/logger). These are pure functional
 * file readers with no injection seam, and importing `@comis/infra` directly is
 * banned (AGENTS §2.4). The soft-fail signal is surfaced STRUCTURALLY via the
 * `daysRead` / `daysMissing` counters the coverage block consumes; the
 * RPC handler logs at the boundary where it has the `Deps` seam.
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { safePath, systemDateFrom, systemNowMs } from "@comis/core";
import type { SessionIndexEvent } from "@comis/observability";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum number of day-keyed files iterated. An over-long window is clamped to
 * the most-recent `MAX_DAYS` day-keys so the file-iteration work is bounded
 * regardless of `sinceMs`. A system-health window is days-to-weeks; 90 is a
 * generous ceiling.
 */
const MAX_DAYS = 90;

/**
 * Per-window line cap across ALL day-files (mirrors
 * `obs-explain-readers.ts:MAX_RECORDS = 5000`). Bounds the aggregate against a
 * DoS-sized session-index; once reached, further lines (and days) are skipped.
 */
const MAX_RECORDS = 5_000;

/**
 * The windowed session-index aggregate. Counts + distinct sets only — no
 * message bodies, no per-session detail (the report is digest-only).
 */
export interface SystemSessionIndexSummary {
  /** Distinct `agentId`s seen in `session_started` rows, sorted for determinism. */
  readonly activeAgents: string[];
  /** Distinct `channelType:channelId`s seen in `session_started` rows, sorted. */
  readonly activeChannels: string[];
  /** Histogram of `exitReason` over `session_ended` rows (stable key order). */
  readonly exitReasons: Record<string, number>;
  /** Sum of `session_ended.turnCount` across the window (authoritative session totals). */
  readonly turnTotal: number;
  /** Sum of `session_ended.totalTokens` across the window (authoritative session totals). */
  readonly tokenTotal: number;
  /** Day-files in the window that were actually opened and read. */
  readonly daysRead: number;
  /** Day-keys in the window that had no file on disk (or an unreadable one). */
  readonly daysMissing: number;
}

/** Default data directory (lazy — resolved at call time). Mirrors obs-trace.ts. */
function defaultDataDir(): string {
  return safePath(os.homedir(), ".comis");
}

/** "YYYY-MM-DD" for an epoch-ms instant — without `new Date()` (globals gate). */
function dayKeyForMs(ms: number): string {
  return systemDateFrom(ms).toISOString().slice(0, 10);
}

/**
 * The inclusive list of `YYYY-MM-DD` day-keys from `sinceMs` forward to the
 * window upper bound `nowMs`, clamped to the most-recent `MAX_DAYS`. Built by
 * walking day-key strings (not ms arithmetic on the boundary) so a sub-day
 * `sinceMs` still includes its own day, and DST shifts cannot drop or duplicate
 * a key. `nowMs` is INJECTED (the caller's single clock instant) so the window
 * is deterministic w.r.t. that clock — no internal `Date.now()` read.
 */
function dayKeysInWindow(sinceMs: number, nowMs: number): string[] {
  // Clamp the start forward so the window never exceeds MAX_DAYS files.
  const earliestAllowedMs = nowMs - (MAX_DAYS - 1) * DAY_MS;
  const startMs = sinceMs < earliestAllowedMs ? earliestAllowedMs : sinceMs;
  const todayKey = dayKeyForMs(nowMs);

  const keys: string[] = [];
  // Step day-by-day from the start instant; stop once we pass the upper bound.
  // Cap the loop iterations defensively at MAX_DAYS (the clamp above bounds it).
  for (let i = 0, cursorMs = startMs; i < MAX_DAYS; i += 1, cursorMs += DAY_MS) {
    const key = dayKeyForMs(cursorMs);
    if (keys[keys.length - 1] !== key) keys.push(key);
    if (key >= todayKey) break; // lexicographic compare is valid for YYYY-MM-DD
  }
  return keys;
}

/**
 * Read the session-index aggregate over the window `[sinceMs .. nowMs]`.
 *
 * @param dataDir - data directory containing `logs/session-index.*.jsonl`.
 *   Defaults to `~/.comis` when an empty string is passed.
 * @param sinceMs - epoch-ms lower bound; the reader opens day-keyed files from
 *   `systemDateFrom(sinceMs)` forward to the `nowMs` upper bound (clamped to
 *   `MAX_DAYS`).
 * @param nowMs - epoch-ms window UPPER bound (the day-key range end). Pass the
 *   caller's injected clock instant so the window is deterministic w.r.t. that
 *   clock. Defaults to the sanctioned-root `systemNowMs()` for callers
 *   that genuinely have no clock seam.
 * @param opts.includeSynthetic - when `false` (the default), rows stamped
 *   `synthetic === true` are excluded from every aggregate. `true` includes
 *   them (the admin opt-in).
 * @returns the windowed aggregate. Never throws — missing/unreadable/malformed
 *   input soft-fails and is reflected in `daysRead` / `daysMissing`.
 */
export function readSessionIndexWindow(
  dataDir: string,
  sinceMs: number,
  nowMs: number = systemNowMs(),
  opts: { includeSynthetic?: boolean } = {},
): SystemSessionIndexSummary {
  const includeSynthetic = opts.includeSynthetic === true;
  const base = dataDir.length > 0 ? dataDir : defaultDataDir();
  const logsDir = safePath(base, "logs");

  // Map-keyed accumulation (no plain-object dynamic-key sink); the typed outputs
  // are built once at the end via Object.fromEntries / sorted Set spreads
  // (the session-health-rollup precedent satisfies the object-injection rule).
  const agents = new Set<string>();
  const channels = new Set<string>();
  const exitReasons = new Map<string, number>();
  // Per-session dedup of turn/token totals. A session that has ENDED carries its
  // whole-session totals on the `session_ended` row (authoritative); an IN-FLIGHT
  // session (no end row yet — the dominant live case, e.g. a long-lived chat-API
  // session) only ever emits `turn_completed` rows. We accumulate BOTH per
  // sessionId and, at the end, prefer the authoritative ended totals when present
  // and fall back to the summed live turns otherwise — so neither is dropped nor
  // double-counted (summing only ended rows would silently report 0 turns /
  // 0 tokens for every still-open session).
  const endedSessions = new Set<string>();
  const endedTurns = new Map<string, number>();
  const endedTokens = new Map<string, number>();
  const liveTurns = new Map<string, number>();
  const liveTokens = new Map<string, number>();
  let daysRead = 0;
  let daysMissing = 0;
  let linesRead = 0;

  for (const dayKey of dayKeysInWindow(sinceMs, nowMs)) {
    if (linesRead >= MAX_RECORDS) break; // window-wide line cap reached.

    const file = safePath(logsDir, `session-index.${dayKey}.jsonl`);
    if (!fs.existsSync(file)) {
      daysMissing += 1; // Soft-fail: a missing day-file is non-fatal but honest.
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      // Soft-fail: an existing-but-unreadable index file is counted as missing
      // (the day's data did not make it into the aggregate). Mirrors the
      // resolver's `continue` on the read catch.
      daysMissing += 1;
      continue;
    }
    daysRead += 1;

    for (const line of content.split("\n")) {
      if (linesRead >= MAX_RECORDS) break;
      if (!line) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // Skip malformed JSONL lines per the standard convention.
      }
      linesRead += 1;

      // Window by the ROW ts, not just the day-key.
      // The day-keyed files are whole-DAY; a `--since 1h` window opens today's
      // file and (pre-fix) counted EVERY session_started channel/agent in it
      // regardless of ts — so a 1-session window reported 39 channels + a
      // prior-run agent. Skip any row whose parseable ts falls outside
      // [sinceMs..nowMs]. Fail-OPEN on an unparseable/absent ts (never silently
      // drop a real row we cannot place) — every real row carries an ISO ts.
      const rowTsMs = typeof rec.ts === "string" ? Date.parse(rec.ts) : Number.NaN;
      if (Number.isFinite(rowTsMs) && (rowTsMs < sinceMs || rowTsMs > nowMs)) continue;

      // Synthetic default-exclude — a REAL filter (strict === true; a string "true"
      // must NOT truthy-coerce into a spurious exclusion of a real session).
      if (rec.synthetic === true && !includeSynthetic) continue;

      // The rows are untrusted JSONL — narrow defensively against the SSOT union
      // and treat unexpected shapes as skip-fields, never throw.
      const event = rec.event;
      if (event === "session_started") {
        const r = rec as Partial<Extract<SessionIndexEvent, { event: "session_started" }>>;
        if (typeof r.agentId === "string" && r.agentId.length > 0) {
          agents.add(r.agentId);
        }
        if (typeof r.channelType === "string" && typeof r.channelId === "string") {
          channels.add(`${r.channelType}:${r.channelId}`);
        }
      } else if (event === "session_ended") {
        const r = rec as Partial<Extract<SessionIndexEvent, { event: "session_ended" }>>;
        if (typeof r.exitReason === "string" && r.exitReason.length > 0) {
          exitReasons.set(r.exitReason, (exitReasons.get(r.exitReason) ?? 0) + 1);
        }
        const sid = typeof r.sessionId === "string" ? r.sessionId : "";
        endedSessions.add(sid);
        if (typeof r.turnCount === "number" && Number.isFinite(r.turnCount)) {
          endedTurns.set(sid, (endedTurns.get(sid) ?? 0) + r.turnCount);
        }
        if (typeof r.totalTokens === "number" && Number.isFinite(r.totalTokens)) {
          endedTokens.set(sid, (endedTokens.get(sid) ?? 0) + r.totalTokens);
        }
      } else if (event === "turn_completed") {
        // Per-turn rows of an IN-FLIGHT session. Counted only for sessions with
        // no `session_ended` row (resolved below) so a session that DOES end
        // uses its authoritative whole-session totals instead — no double-count.
        const r = rec as Partial<Extract<SessionIndexEvent, { event: "turn_completed" }>>;
        const sid = typeof r.sessionId === "string" ? r.sessionId : "";
        const inTok = typeof r.inputTokens === "number" && Number.isFinite(r.inputTokens) ? r.inputTokens : 0;
        const outTok = typeof r.outputTokens === "number" && Number.isFinite(r.outputTokens) ? r.outputTokens : 0;
        liveTurns.set(sid, (liveTurns.get(sid) ?? 0) + 1);
        liveTokens.set(sid, (liveTokens.get(sid) ?? 0) + inTok + outTok);
      }
      // Any unknown event is a deliberate no-op.
    }
  }

  // Resolve per-session: authoritative ended totals win; live turn sums fill in
  // only for sessions that never emitted an end row (still open in the window).
  let turnTotal = 0;
  let tokenTotal = 0;
  for (const turns of endedTurns.values()) turnTotal += turns;
  for (const tokens of endedTokens.values()) tokenTotal += tokens;
  for (const [sid, turns] of liveTurns) {
    if (!endedSessions.has(sid)) turnTotal += turns;
  }
  for (const [sid, tokens] of liveTokens) {
    if (!endedSessions.has(sid)) tokenTotal += tokens;
  }

  return {
    activeAgents: [...agents].sort(),
    activeChannels: [...channels].sort(),
    // Stable key order: sort histogram entries by key before re-objectifying.
    exitReasons: Object.fromEntries([...exitReasons.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    turnTotal,
    tokenTotal,
    daysRead,
    daysMissing,
  };
}
