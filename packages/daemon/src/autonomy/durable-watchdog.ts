// SPDX-License-Identifier: Apache-2.0
/**
 * Durable watchdog: the PURE lapsed-heartbeat
 * detector. A long-running durable run stamps `lastHeartbeatAt` on a keep-alive
 * (DurableRunPort.touchHeartbeat); a process that crashed stops stamping, so a
 * run whose heartbeat is older than `staleHeartbeatMs` is a crash candidate the
 * resume engine should orphan-sweep.
 *
 * This module is JUST the detector — `detectStaleRuns` is a pure filter with no
 * I/O and no callable-global time/timer reads (the globals.test.ts arch-gate
 * forbids the wall-clock global and the interval-scheduler global here). The
 * ACTUAL interval that calls it on a tick is wired at the daemon boot layer via
 * the injected TimerPort; `nowMs` is passed in by that caller so the detector
 * stays exhaustively unit-testable with a fake clock.
 *
 * The conservative-threshold rule: the threshold must be GENEROUSLY
 * larger than the keep-alive interval, or a slow-but-alive run is falsely failed
 * and its work duplicated. This is the same lesson `ANNOUNCE_PARENT_TIMEOUT_MS`
 * encodes — "30s caused premature fallback + duplicate delivery"
 * (sub-agent-runner.ts:56) — so the exported default threshold is 4x the
 * exported default keep-alive, well above the >=3x floor the test pins.
 *
 * @module
 */

import type { DurableRunRecord } from "@comis/core";

/**
 * The default keep-alive write cadence (ms) — how often a live durable run
 * stamps `lastHeartbeatAt`. The daemon boot layer schedules the touch at this interval.
 */
export const DEFAULT_KEEPALIVE_MS = 30_000;

/**
 * The default lapsed-heartbeat threshold (ms). A run whose `lastHeartbeatAt` is
 * older than `nowMs - this` is treated as crashed. Deliberately 4x
 * {@link DEFAULT_KEEPALIVE_MS} (comfortably above the >=3x conservative-ratio
 * floor) so a transiently-slow run that misses a keep-alive or two is NOT failed
 * — the conservative-ratio / `ANNOUNCE_PARENT_TIMEOUT_MS` "30s was too tight" lesson.
 */
export const DEFAULT_STALE_HEARTBEAT_MS = 120_000;

/**
 * Detect the runs whose heartbeat has lapsed.
 *
 * A run is stale iff it is still `running` AND its last heartbeat is STRICTLY
 * older than the threshold (`lastHeartbeatAt < nowMs - staleHeartbeatMs`). The
 * `<` is exclusive on purpose: a run exactly at the boundary is given the
 * benefit of the doubt (it is not yet stale), so the threshold is the latest
 * still-trusted age, never a coin-flip. Terminal-status runs
 * (orphaned/completed/revoked) are never returned regardless of heartbeat age —
 * only a *running* run can be a crash candidate.
 *
 * @param runs - the candidate records (typically `DurableRunPort.listResumable`)
 * @param nowMs - the current wall-clock in epoch ms (injected; never the wall-clock global)
 * @param staleHeartbeatMs - the lapsed-heartbeat threshold (typically {@link DEFAULT_STALE_HEARTBEAT_MS})
 * @returns the subset of `runs` that are running and past the strict threshold
 */
export function detectStaleRuns(
  runs: readonly DurableRunRecord[],
  nowMs: number,
  staleHeartbeatMs: number,
): DurableRunRecord[] {
  return runs.filter((r) => r.status === "running" && r.lastHeartbeatAt < nowMs - staleHeartbeatMs);
}
