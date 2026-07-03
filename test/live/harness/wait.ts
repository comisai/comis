// SPDX-License-Identifier: Apache-2.0
/**
 * `wait` — the AUTO-03 mechanic powering `tg wait --tool <name> | --event
 * <type> [--timeout ms]`.
 *
 * It BLOCKS until a trajectory signal appears so a 15-25-minute agentic turn
 * (server-side) is awaited rather than mistaken for a timeout-failure, then
 * resolves with the matched record. "Turn done" is defined explicitly:
 *   - `--event model.completed` / `--event session.summary` → the first line
 *     whose `type` equals that event;
 *   - `--tool <name>` → the first `tool.result` line whose `data.toolName`
 *     equals `<name>` (the on-disk shape — see the record-shape note below).
 *
 * Two guards make the wait HONEST:
 *   1. `--event` is validated against the REAL closed enum
 *      `TRAJECTORY_EVENT_TYPES` (imported from the observability package)
 *      BEFORE any tailing begins. An unknown value is a reason-coded throw,
 *      never a silent never-match.
 *   2. A settle-timeout fallback: when the file stops being appended for
 *      `settleMs` and no match was seen, the waiter resolves
 *      `{ matched: false, reason: "settle_timeout" }` — well before the hard
 *      `timeoutMs`. A file that keeps changing past `timeoutMs` resolves
 *      `{ matched: false, reason: "timeout" }`. The waiter ALWAYS resolves —
 *      never hangs, never fabricates a match.
 *
 * Trajectory resolution mirrors `obs-explain-readers.ts:resolveTrajectoryFile`
 * EXACTLY (the canonical pointer chain): the pointer's `runtimeFile` when it
 * fence-checks, else the co-located `<sessionFile>.trajectory.jsonl`. It NEVER
 * builds a flat `<dataDir>/sessions/<id>` path — that path never existed on
 * disk; it is a known bug class (read `workspace/sessions/...` +
 * the `.trajectory-path.json` pointer instead).
 *
 * Record-shape note (the production contract): a trajectory line is one JSON
 * object per line with a TOP-LEVEL `type` envelope (runtime.ts `buildEvent`:
 * `{ traceSchema, schemaVersion, type, ts, seq, ..., data }`). A `tool.result`
 * line carries the tool name at `data.toolName` (the event-bus bridge maps
 * `tool:executed` → `tool.result` with `data.toolName`) — NOT a top-level
 * `toolName`. Matching the top level would never match a real line.
 *
 * TEST-HARNESS — lives under the test tree, never the packages source tree;
 * ZERO production code change. The observability package is consumed from its
 * built `dist/` (a stale `dist/` masks `src/`; build first). `node:fs`
 * `readFileSync`/`statSync` and a raw unref'd `setTimeout` are fine here —
 * the test tree is outside every packages source-tree architecture rule.
 *
 * @module
 */

import { readFileSync, statSync } from "node:fs";
import {
  resolveTrajectoryPointerFilePath,
  TRAJECTORY_EVENT_TYPES,
} from "@comis/observability";

// ---------------------------------------------------------------------------
// Trajectory file resolution (mirror obs-explain-readers.ts).
// ---------------------------------------------------------------------------

/**
 * Resolve the trajectory JSONL path for a session file, the canonical way:
 *   1. Read `<sessionFile>.trajectory-path.json` (the pointer); when it
 *      fence-checks (`traceSchema === "comis-trajectory-pointer"`,
 *      `schemaVersion === 1`, non-empty string `runtimeFile`) use `runtimeFile`.
 *   2. Else fall back to the co-located `<sessionFile>.trajectory.jsonl`.
 *
 * Soft-fail: a missing/corrupt pointer falls through to the co-located path —
 * it never throws the wrong-base-path error. Mirrors
 * `obs-explain-readers.ts:resolveTrajectoryFile` verbatim.
 */
export function resolveTrajectoryFile(sessionFile: string): string {
  const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
  try {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf-8")) as Record<string, unknown>;
    if (
      pointer["traceSchema"] === "comis-trajectory-pointer" &&
      pointer["schemaVersion"] === 1 &&
      typeof pointer["runtimeFile"] === "string" &&
      pointer["runtimeFile"].length > 0
    ) {
      return pointer["runtimeFile"];
    }
  } catch {
    // Pointer absent or invalid — fall back to the co-located convention.
  }
  return `${sessionFile}.trajectory.jsonl`;
}

// ---------------------------------------------------------------------------
// waitForTrajectorySignal — block-until-signal + settle-timeout fallback.
// ---------------------------------------------------------------------------

/** Why a signal wait resolved. */
export type WaitReason = "matched" | "settle_timeout" | "timeout";

export interface WaitSignalOptions {
  /** Absolute path to the trajectory JSONL to tail (resolveTrajectoryFile output). */
  readonly trajectoryFile: string;
  /** Match the first line whose `type` equals this (validated against the enum). */
  readonly event?: string;
  /** Match the first `tool.result` whose `data.toolName` equals this. */
  readonly tool?: string;
  /**
   * Hard ceiling (ms). The waiter always resolves by `timeoutMs` even if the
   * file keeps changing. Default 1_500_000 (25 min — a long agentic turn).
   */
  readonly timeoutMs?: number;
  /**
   * Quiet-period (ms) after the last file change before a no-match wait gives up
   * with `settle_timeout`. Default 500. Lets a turn that never emits the explicit
   * signal still resolve honestly rather than hanging to `timeoutMs`.
   */
  readonly settleMs?: number;
  /** Poll interval (ms). Default 50 — small enough to wake promptly on an append. */
  readonly pollMs?: number;
}

export interface WaitSignalResult {
  /** True when the requested signal appeared. */
  readonly matched: boolean;
  /** The matched line's `type` (present when `matched`). */
  readonly type?: string;
  /** The full matched JSONL record (present when `matched`). */
  readonly record?: unknown;
  /** Why the wait resolved. */
  readonly reason: WaitReason;
}

/** Default hard timeout — a long agentic turn. */
const DEFAULT_TIMEOUT_MS = 1_500_000;
/** Default settle (quiet-period) timeout. */
const DEFAULT_SETTLE_MS = 500;
/** Default poll interval. */
const DEFAULT_POLL_MS = 50;

/** Sleep helper (a raw unref'd `setTimeout` is fine under the test tree). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * A file's change-signature: byte length + mtime (ms). Used to detect whether
 * the daemon is still appending. A not-yet-existing file is `undefined`.
 */
function changeSignature(file: string): string | undefined {
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined; // Not-yet-existing / unreadable — the daemon writes lazily.
  }
}

/** Read every parsed JSONL line; malformed lines are skipped, a missing file → []. */
function readLines(file: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return []; // Missing/unreadable — soft-fail (the file may not exist yet).
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A malformed line is ignored, never fatal — the loop continues.
    }
  }
  return out;
}

/** Does this parsed line satisfy the requested `--event` / `--tool` match? */
function lineMatches(
  line: Record<string, unknown>,
  event: string | undefined,
  tool: string | undefined,
): boolean {
  const type = line["type"];
  if (event !== undefined) {
    return type === event;
  }
  // tool match: a `tool.result` line whose `data.toolName` equals the requested name.
  if (type !== "tool.result") return false;
  const data = line["data"];
  if (typeof data !== "object" || data === null) return false;
  return (data as Record<string, unknown>)["toolName"] === tool;
}

/**
 * Block until the requested trajectory signal appears in `trajectoryFile`, then
 * resolve with the matched record. Validates `--event` against the real closed
 * enum BEFORE tailing; requires exactly one of `event`/`tool`. Never hangs:
 * resolves `settle_timeout` after a quiet-period with no match, or `timeout` at
 * the hard ceiling, each with an explicit reason code.
 */
export async function waitForTrajectorySignal(
  opts: WaitSignalOptions,
): Promise<WaitSignalResult> {
  const { trajectoryFile, event, tool } = opts;

  // VALIDATE FIRST — before any tail begins.
  // Exactly one of event/tool must be supplied.
  if ((event === undefined) === (tool === undefined)) {
    throw new Error(
      "tg wait: supply exactly one of --event <type> or --tool <name>",
    );
  }
  // An unknown --event is a reason-coded reject, never a silent never-match.
  if (event !== undefined && !(TRAJECTORY_EVENT_TYPES as readonly string[]).includes(event)) {
    throw new Error(
      `tg wait: unknown --event '${event}' (not a trajectory event type)`,
    );
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  const start = Date.now();
  let lastSignature = changeSignature(trajectoryFile);
  let lastChange = start;

  for (;;) {
    // Scan the file for a matching line on every poll (handles both an
    // already-present line and one appended mid-wait).
    for (const line of readLines(trajectoryFile)) {
      if (lineMatches(line, event, tool)) {
        return {
          matched: true,
          type: line["type"] as string,
          record: line,
          reason: "matched",
        };
      }
    }

    const now = Date.now();

    // Track whether the file is still being appended.
    const signature = changeSignature(trajectoryFile);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastChange = now;
    }

    // Hard timeout: resolve honestly even if the file keeps changing.
    if (now >= start + timeoutMs) {
      return { matched: false, reason: "timeout" };
    }

    // Settle-timeout: the file went quiet for settleMs with no match → give up
    // honestly, well before the hard timeoutMs.
    if (now - lastChange >= settleMs) {
      return { matched: false, reason: "settle_timeout" };
    }

    // Sleep until the next poll, never overshooting either deadline.
    const untilHard = start + timeoutMs - now;
    const untilSettle = lastChange + settleMs - now;
    await sleep(Math.max(1, Math.min(pollMs, untilHard, untilSettle)));
  }
}
