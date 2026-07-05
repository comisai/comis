// SPDX-License-Identifier: Apache-2.0
/**
 * Pure, fail-open verdict parser for a pre-run gate script.
 *
 * A gate is an untrusted script that runs before a scheduled payload and
 * decides whether to invoke the model at all. This maps the gate's raw run
 * outcome to a decision.
 *
 * The invariant is **fail-open**: a gate that emits no verdict, crashes, times
 * out, or overflows wakes the model — only an explicit boolean `wake` on the
 * last non-empty line, or a known silent sentinel on that line, decides
 * otherwise. Fail-open is resolved LAST so it covers every non-verdict case,
 * which guarantees a broken monitor is never silently dropped.
 *
 * @module
 */

import { HEARTBEAT_OK_TOKEN, NO_REPLY_TOKEN, SILENT_PREFIX } from "@comis/shared";

/** The gate run outcome the parser resolves. Pure input; no I/O. */
export interface WakeGateRunOutcome {
  readonly stdout: string;
  /** `0` or `null` = clean exit; any other number = failure. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly overflowed: boolean;
}

/** The resolved gate decision. */
export interface WakeGateVerdict {
  readonly wake: boolean;
  /** Pre-gathered finding to inject when waking. */
  readonly context?: string;
  /** Routine-status text to deliver without a model turn. */
  readonly deliver?: string;
}

/**
 * Upper bound on the stdout tail carried as `context`. Keeps an injected
 * finding content-light rather than forwarding an unbounded script dump.
 */
const CONTEXT_TAIL_MAX_CHARS = 4000;

/** Return the last `CONTEXT_TAIL_MAX_CHARS` chars of `s` (or all of it). */
function boundedTail(s: string): string {
  return s.length <= CONTEXT_TAIL_MAX_CHARS ? s : s.slice(-CONTEXT_TAIL_MAX_CHARS);
}

/** Wake the model, attaching a bounded stdout tail as context when present. */
function failOpen(stdout: string): WakeGateVerdict {
  const tail = boundedTail(stdout);
  return tail ? { wake: true, context: tail } : { wake: true };
}

/** Return the last line whose trimmed form is non-empty, or `undefined`. */
function lastNonEmptyLine(stdout: string): string | undefined {
  return stdout.split(/\r?\n/).findLast((line) => line.trim().length > 0);
}

/** Parse an explicit JSON verdict from a line, or `undefined` if it is not one. */
function parseJsonVerdict(line: string): WakeGateVerdict | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.wake !== "boolean") return undefined;
  // Bound the explicit-JSON context/deliver to the SAME content-light cap the
  // fail-open tail applies. Without this an explicit {"wake":true,"context":...}
  // bypasses the bound entirely, so up to the runner's 4 MiB stdout cap could
  // enter the prompt — defeating the stated "content-light rather than an
  // unbounded script dump" intent.
  return {
    wake: record.wake,
    ...(typeof record.context === "string" ? { context: boundedTail(record.context) } : {}),
    ...(typeof record.deliver === "string" ? { deliver: boundedTail(record.deliver) } : {}),
  };
}

/**
 * Resolve a gate run outcome to a wake decision.
 *
 * Total function: it always yields a verdict, failing open on every
 * non-verdict or failure case. Resolution order:
 * 1. A failed run (timeout, overflow, or non-zero exit) wakes regardless of
 *    stdout content.
 * 2. No non-empty output wakes (an empty gate is never resolved to silent).
 * 3. An explicit JSON verdict with a boolean `wake` on the last non-empty
 *    line is honored (optional string `context` / `deliver`).
 * 4. A known silent sentinel on that line (`HEARTBEAT_OK` / `NO_REPLY`, or a
 *    `[SILENT]`-prefixed line, case-insensitive) skips; a trailing
 *    `[SILENT] <text>` carries `<text>` as `deliver`.
 * 5. Any other stdout wakes, carrying a bounded stdout tail as context.
 */
export function parseWakeGateVerdict(outcome: WakeGateRunOutcome): WakeGateVerdict {
  // 1. A failed run wakes regardless of stdout content.
  if (outcome.timedOut || outcome.overflowed || (outcome.exitCode !== 0 && outcome.exitCode !== null)) {
    return failOpen(outcome.stdout);
  }

  // 2. No non-empty output → fail open (never resolve an empty gate to silent).
  const lastLine = lastNonEmptyLine(outcome.stdout);
  if (lastLine === undefined) return { wake: true };

  const trimmed = lastLine.trim();

  // 3. An explicit JSON verdict on the last non-empty line wins.
  const jsonVerdict = parseJsonVerdict(trimmed);
  if (jsonVerdict !== undefined) return jsonVerdict;

  // 4. Known silent sentinels on the (non-empty) last line.
  const upper = trimmed.toUpperCase();
  if (upper === HEARTBEAT_OK_TOKEN || upper === NO_REPLY_TOKEN) {
    return { wake: false };
  }
  if (upper.startsWith(SILENT_PREFIX)) {
    const deliver = trimmed.slice(SILENT_PREFIX.length).trim();
    return deliver ? { wake: false, deliver } : { wake: false };
  }

  // 5. Any other stdout → fail open with the bounded tail as context.
  return failOpen(outcome.stdout);
}
