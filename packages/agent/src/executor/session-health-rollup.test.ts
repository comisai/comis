// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { ErrorKind } from "@comis/core";
import {
  buildSessionHealthRollup,
  DEGRADED_REASONS,
  type SessionHealthRollup,
} from "./session-health-rollup.js";

// Synthetic, pure-drive tests (mirrors bridge-metrics.test.ts:1-60). NO disk
// fixtures, NO clock, NO eventBus — every input is constructed inline and every
// output field is asserted.

describe("buildSessionHealthRollup", () => {
  it("criterion #3: 8/10 web_fetch failures + costUsd 1.45 yields degraded with bounded toolStats and topErrorKinds", () => {
    // SYNTHETIC drive — costUsd is 1.45 constructed here, NOT the disk fixture's
    // 1.320669. The §1.1 replay shape: 2 successful + 8 failed web_fetch calls,
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
      { sessionCostUsd: 1.45, breakerTripCount: 1, toolExecResults },
      "completed_with_tool_errors",
    );

    expect(rollup.degraded).toBe(true);
    expect(rollup.toolStats.web_fetch).toEqual({ ok: 2, failed: 8 });
    expect(rollup.costUsd).toBeCloseTo(1.45, 2);
    expect(rollup.topErrorKinds.dependency).toBe(8);
    expect(rollup.breakerTripCount).toBe(1);
  });

  it("degraded is true for the closed degraded set and the error-class reasons, false for stop and end_turn", () => {
    // Pin the EXACT closed degraded set (design §5 D5). Membership in
    // DEGRADED_REASONS is the public contract — assert it directly so the set
    // cannot silently drift.
    expect([...DEGRADED_REASONS].sort()).toEqual(
      [
        "budget_exceeded",
        "budget_exhausted",
        "circuit_open",
        "completed_with_tool_errors",
        "provider_degraded",
      ].sort(),
    );

    for (const reason of [
      "completed_with_tool_errors",
      "budget_exceeded",
      "budget_exhausted",
      "circuit_open",
      "provider_degraded",
    ]) {
      expect(buildSessionHealthRollup({}, reason).degraded).toBe(true);
    }

    // The END_REASON_MAP "error" class — all of these map to endReason "error".
    for (const reason of ["error", "max_steps", "context_loop", "context_exhausted"]) {
      expect(buildSessionHealthRollup({}, reason).degraded).toBe(true);
    }

    // Clean completion — NOT degraded.
    expect(buildSessionHealthRollup({}, "stop").degraded).toBe(false);
    expect(buildSessionHealthRollup({}, "end_turn").degraded).toBe(false);
  });

  it("a success-only toolExecResults contributes only ok counts and an empty topErrorKinds", () => {
    const toolExecResults = [
      { toolName: "bash", success: true },
      { toolName: "bash", success: true },
      { toolName: "read_file", success: true },
    ];

    const rollup = buildSessionHealthRollup(
      { sessionCostUsd: 0.1, toolExecResults },
      "stop",
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

    const rollup = buildSessionHealthRollup({ toolExecResults }, "stop");

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

    const rollup = buildSessionHealthRollup({ toolExecResults }, "stop");

    expect(rollup.toolStats.bash).toEqual({ ok: 1, failed: 1 });
    expect(rollup.toolStats.read_file).toEqual({ ok: 0, failed: 1 });
    expect(rollup.topErrorKinds).toEqual({ timeout: 1, internal: 1 });
  });

  it("an empty bridge result with a clean stop yields the zero-state defaults", () => {
    const rollup = buildSessionHealthRollup({}, "stop");
    expect(rollup).toEqual({
      degraded: false,
      costUsd: 0,
      toolStats: {},
      breakerTripCount: 0,
      topErrorKinds: {},
    });
  });
});
