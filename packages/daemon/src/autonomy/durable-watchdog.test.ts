// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the durable watchdog (HB-01 / DUR-04): the pure lapsed-heartbeat
 * detector. RED-first — `detectStaleRuns` (and the two default constants) do not
 * exist yet, so this file fails to import before the patch.
 *
 * The load-bearing properties (Pitfall 4 — a too-tight threshold caused premature
 * failover + duplicate delivery, the ANNOUNCE_PARENT_TIMEOUT_MS 30s lesson):
 *   - only RUNNING runs past a STRICT staleHeartbeatMs threshold are flagged;
 *   - a fresh heartbeat is never a false-positive failover;
 *   - the boundary is exclusive (strict `<`);
 *   - terminal-status runs are never returned;
 *   - the default threshold is comfortably (>=3x) larger than the keep-alive.
 */
import { describe, it, expect } from "vitest";
import type { DurableRunRecord } from "@comis/core";
import {
  detectStaleRuns,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_STALE_HEARTBEAT_MS,
} from "./durable-watchdog.js";

/** A minimal valid DurableRunRecord with an overridable status + heartbeat. */
function run(
  rootRunId: string,
  status: DurableRunRecord["status"],
  lastHeartbeatAt: number,
): DurableRunRecord {
  return {
    rootRunId,
    spawnTree: [],
    caps: ["orch:read"],
    leaseIds: [],
    budgetConsumed: 0,
    cronOrigin: null,
    stepIndex: -1,
    status,
    lastHeartbeatAt,
  };
}

describe("detectStaleRuns (HB-01)", () => {
  const NOW = 1_000_000;
  const STALE_MS = 120_000;

  it("returns a running run whose heartbeat lapsed past the threshold", () => {
    const stale = run("r-stale", "running", NOW - STALE_MS - 1);
    const fresh = run("r-fresh", "running", NOW - 1_000);
    const result = detectStaleRuns([stale, fresh], NOW, STALE_MS);
    expect(result.map((r) => r.rootRunId)).toEqual(["r-stale"]);
  });

  it("does NOT return a running run with a FRESH heartbeat (no false-positive failover, Pitfall 4)", () => {
    const fresh = run("r-fresh", "running", NOW - (STALE_MS - 1));
    const result = detectStaleRuns([fresh], NOW, STALE_MS);
    expect(result).toHaveLength(0);
  });

  it("treats the exact boundary (lastHeartbeatAt === nowMs - staleHeartbeatMs) as NOT stale (strict <)", () => {
    const boundary = run("r-boundary", "running", NOW - STALE_MS);
    const result = detectStaleRuns([boundary], NOW, STALE_MS);
    expect(result).toHaveLength(0);
  });

  it("never returns orphaned/completed/revoked runs regardless of how stale the heartbeat is", () => {
    const ancient = NOW - STALE_MS - 1_000_000;
    const runs = [
      run("r-orphaned", "orphaned", ancient),
      run("r-completed", "completed", ancient),
      run("r-revoked", "revoked", ancient),
    ];
    const result = detectStaleRuns(runs, NOW, STALE_MS);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array for an empty input", () => {
    expect(detectStaleRuns([], NOW, STALE_MS)).toEqual([]);
  });

  it("exports a default stale-heartbeat threshold that is >= 3x the default keep-alive (the ANNOUNCE_PARENT_TIMEOUT_MS conservative-ratio lesson)", () => {
    expect(DEFAULT_STALE_HEARTBEAT_MS).toBeGreaterThanOrEqual(3 * DEFAULT_KEEPALIVE_MS);
  });
});
