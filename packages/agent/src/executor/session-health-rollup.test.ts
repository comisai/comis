// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { ErrorKind } from "@comis/core";
import {
  buildSessionHealthRollup,
  type SessionHealthRollup,
} from "./session-health-rollup.js";

// Synthetic, pure-drive tests (mirrors bridge-metrics.test.ts:1-60). NO disk
// fixtures, NO clock, NO eventBus — every input is constructed inline and every
// output field is asserted.

describe("buildSessionHealthRollup", () => {
  it("8/10 web_fetch failures + costUsd 1.45 yields degraded with bounded toolStats and topErrorKinds", () => {
    // SYNTHETIC drive — costUsd is 1.45 constructed here, NOT the disk fixture's
    // 1.320669. The replay shape: 2 successful + 8 failed web_fetch calls,
    // every failure classified as a "dependency" ErrorKind, one breaker trip.
    const toolExecResults: ReadonlyArray<{
      toolName: string;
      success: boolean;
      errorKind?: ErrorKind;
    }> = [
      { toolName: "web_fetch", success: true },
      { toolName: "web_fetch", success: true },
      { toolName: "web_fetch", success: false, errorKind: "dependency" },
      { toolName: "web_fetch", success: false, errorKind: "dependency" },
      { toolName: "web_fetch", success: false, errorKind: "dependency" },
      { toolName: "web_fetch", success: false, errorKind: "dependency" },
      { toolName: "web_fetch", success: false, errorKind: "dependency" },
      { toolName: "web_fetch", success: false, errorKind: "dependency" },
      { toolName: "web_fetch", success: false, errorKind: "dependency" },
      { toolName: "web_fetch", success: false, errorKind: "dependency" },
    ];

    const rollup: SessionHealthRollup = buildSessionHealthRollup(
      { executionCostUsd: 1.45, breakerTripCount: 1, toolExecResults },
      "completed_with_tool_errors",
    );

    expect(rollup.degraded).toBe(true);
    expect(rollup.toolStats.web_fetch).toEqual({ ok: 2, failed: 8 });
    expect(rollup.costUsd).toBeCloseTo(1.45, 2);
    expect(rollup.topErrorKinds.dependency).toBe(8);
    expect(rollup.breakerTripCount).toBe(1);
  });

  it("degraded is derived from the mapped endReason: false ONLY for 'success', true for every other endReason (single source)", () => {
    // The rollup's 2nd arg is the ALREADY-MAPPED
    // SessionMetadata.sessionEnd.endReason (the SAME value persisted onto
    // sessionEnd), not a raw finishReason re-classified against a second closed
    // set. `degraded := endReason !== "success"`. This couples degraded to the
    // single source of truth (END_REASON_MAP) so a finish reason that maps to a
    // non-success endReason can never record degraded:false.

    // The clean class — endReason "success" is the ONLY non-degraded value.
    expect(buildSessionHealthRollup({}, "success").degraded).toBe(false);

    // Every OTHER member of the endReason union is degraded. This is the FULL
    // SessionMetadata.sessionEnd.endReason union — crucially including "error",
    // which is what `loop_detected` and `session_reset` map to via END_REASON_MAP
    // (endReason:"error" MUST imply degraded).
    for (const endReason of [
      "error",
      "timeout",
      "budget_exceeded",
      "budget_exhausted",
      "circuit_open",
      "provider_degraded",
      "completed_with_tool_errors",
    ]) {
      expect(buildSessionHealthRollup({}, endReason).degraded).toBe(true);
    }
  });

  it("regression: loop_detected and session_reset are degraded (they map to endReason:'error', never to 'success')", () => {
    // `loop_detected` (turn-loop-detector abort) and
    // `session_reset` both reach the rollup and both map (via END_REASON_MAP's
    // explicit entries) to endReason:"error". Whether the call site passes the
    // mapped "error" OR the raw reason string, the safety property holds: only
    // "success" is clean, so a runaway-loop / session-reset abort can NEVER be
    // recorded as degraded:false alongside a co-persisted endReason:"error".
    expect(buildSessionHealthRollup({}, "error").degraded).toBe(true);
    expect(buildSessionHealthRollup({}, "loop_detected").degraded).toBe(true);
    expect(buildSessionHealthRollup({}, "session_reset").degraded).toBe(true);
  });

  it("a success-only toolExecResults contributes only ok counts and an empty topErrorKinds", () => {
    const toolExecResults = [
      { toolName: "bash", success: true },
      { toolName: "bash", success: true },
      { toolName: "read_file", success: true },
    ];

    const rollup = buildSessionHealthRollup(
      { executionCostUsd: 0.1, toolExecResults },
      "success",
    );

    expect(rollup.toolStats.bash).toEqual({ ok: 2, failed: 0 });
    expect(rollup.toolStats.read_file).toEqual({ ok: 1, failed: 0 });
    // A successful tool's absent errorKind never appears.
    expect(rollup.topErrorKinds).toEqual({});
    expect(rollup.degraded).toBe(false);
  });

  it("topErrorKinds is bounded to the ErrorKind union and capped at the top 3 by count", () => {
    // Four distinct kinds with counts 5, 4, 3, 1 — the size-1 kind must drop.
    const toolExecResults: Array<{
      toolName: string;
      success: boolean;
      errorKind?: ErrorKind;
    }> = [];
    const push = (kind: ErrorKind, n: number): void => {
      for (let i = 0; i < n; i++) {
        toolExecResults.push({ toolName: "bash", success: false, errorKind: kind });
      }
    };
    push("network", 5);
    push("timeout", 4);
    push("dependency", 3);
    push("validation", 1);

    const rollup = buildSessionHealthRollup({ toolExecResults }, "success");

    const keys = Object.keys(rollup.topErrorKinds);
    expect(keys).toHaveLength(3);
    // The three highest counts are present; the size-1 kind dropped.
    expect(rollup.topErrorKinds.network).toBe(5);
    expect(rollup.topErrorKinds.timeout).toBe(4);
    expect(rollup.topErrorKinds.dependency).toBe(3);
    expect(rollup.topErrorKinds.validation).toBeUndefined();

    // Every retained key is a member of the closed ErrorKind union (no free-text).
    const errorKindUnion: ReadonlySet<string> = new Set<ErrorKind>([
      "config",
      "network",
      "auth",
      "validation",
      "precondition",
      "timeout",
      "resource",
      "dependency",
      "internal",
      "platform",
    ]);
    for (const key of keys) {
      expect(errorKindUnion.has(key)).toBe(true);
    }
  });

  it("interleaved tools accumulate independently across first-seen and reuse paths", () => {
    // Drives both arms of the `toolStats[name] ??= {...}` group-init: bash is
    // first-seen, then read_file first-seen, then bash again (reuse).
    const toolExecResults = [
      { toolName: "bash", success: true },
      { toolName: "read_file", success: false, errorKind: "timeout" as ErrorKind },
      { toolName: "bash", success: false, errorKind: "internal" as ErrorKind },
    ];

    const rollup = buildSessionHealthRollup({ toolExecResults }, "success");

    expect(rollup.toolStats.bash).toEqual({ ok: 1, failed: 1 });
    expect(rollup.toolStats.read_file).toEqual({ ok: 0, failed: 1 });
    expect(rollup.topErrorKinds).toEqual({ timeout: 1, internal: 1 });
  });

  it("an empty bridge result with a clean (success) endReason yields the zero-state defaults", () => {
    const rollup = buildSessionHealthRollup({}, "success");
    expect(rollup).toEqual({
      degraded: false,
      costUsd: 0,
      toolStats: {},
      breakerTripCount: 0,
      topErrorKinds: {},
    });
  });
});
