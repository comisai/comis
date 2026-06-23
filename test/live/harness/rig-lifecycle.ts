// SPDX-License-Identifier: Apache-2.0
/**
 * `rig-lifecycle.ts` — the PURE daemon-respawn + teardown DECISION logic, extracted
 * from `rig-daemon.ts` (Phase 208, Plan 08 — the cold-shell detached-subprocess rig)
 * so the race/flake-sensitive lifecycle transitions are DETERMINISTICALLY testable
 * WITHOUT spawning a real daemon grandchild.
 *
 * WHY A SEPARATE MODULE. `rig-daemon.ts` is an ENTRYPOINT — its top-level body calls
 * `main()` on import (reads env, spawns a real `node daemon.js`), so a unit test
 * cannot import it without booting a daemon. The actual lifecycle DECISIONS (when to
 * refuse a respawn, how teardown reaps a daemon that a racing `/reset` swapped in) are
 * the part with real correctness risk — so they live HERE as injectable, side-effect-
 * free orchestrators that `rig-daemon.ts` wires to its real `reapDaemon` /
 * `spawnDaemonGrandchild` / `isPortFree` / `waitForHealthy`. The module has ZERO
 * `@comis/*` imports + ZERO node side effects, so it imports cleanly under BOTH the
 * vitest live-config AND the bare-`tsx` detached subprocess.
 *
 * THE TWO BUGS THIS CLOSES (Phase 208 review WR-01/WR-02):
 *
 *   WR-01 (orphan-reap leak race): `teardown` reaps `state.daemon` by value, but
 *     `/reset` + `restartDaemon` reassign `state.daemon = spawn(...)` WITHOUT checking
 *     `tearingDown`. On the un-backstopped ORPHAN-REAP path (handle removed out-of-band
 *     → `teardown → process.exit`, NO parent group-kill), a daemon respawned by a
 *     racing `/reset` DURING teardown's awaits LEAKS. Fix: teardown is AUTHORITATIVE —
 *     once `tearingDown` is set, respawn REFUSES; AND teardown re-reads + re-reaps the
 *     CURRENT `state.daemon` after each await so a respawn that snuck in before the
 *     latch took effect is still reaped.
 *
 *   WR-02 (EADDRINUSE respawn flake): the in-proc `/reset`/`/restart` respawn onto the
 *     SAME gateway port immediately after a `reapDaemon` that may have TIMED OUT
 *     returning `false` (the production daemon's graceful shutdown "can be slow"). Fix:
 *     the respawn HONORS the reap result — if reap returned false OR the port is not
 *     yet free, it REFUSES (an honest `reset_unhealthy`/`restart_unhealthy` 503) rather
 *     than racing a fresh daemon onto an occupied port.
 *
 * TEST-HARNESS — lives under the test tree, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import type { ChildProcess } from "node:child_process";

/**
 * The minimal mutable lifecycle state the respawn/teardown orchestrators read + write.
 * `rig-daemon.ts`'s richer `RigState` is structurally assignable to this (it carries
 * `daemon` + `tearingDown`); the helpers touch ONLY these two fields so the decision
 * logic is isolated from the rig's I/O surface.
 */
export interface LifecycleState {
  /** The current daemon grandchild (swapped on `/restart` + `/reconfigure` + `/reset`). */
  daemon: ChildProcess | undefined;
  /** Set once teardown begins — the AUTHORITATIVE latch a respawn must honor (WR-01). */
  tearingDown: boolean;
}

/** Why a respawn was REFUSED (the honest non-200 reason the rig-control verb surfaces). */
export type RespawnRefusal = "tearing_down" | "port_busy";

/** The respawn outcome: spawned-and-healthy, OR a refusal/unhealthy with a reason. */
export type RespawnOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal?: RespawnRefusal };

/**
 * The injectable side-effecting seams the respawn orchestrator drives. `rig-daemon.ts`
 * passes its real `reapDaemon` / `isPortFree` / `spawnDaemonGrandchild` / `waitForHealthy`;
 * tests pass deterministic fakes so the race/flake DECISIONS are provable with no daemon.
 */
export interface RespawnDeps {
  /** The pre-allocated gateway port the fresh daemon must (re)bind. */
  readonly gatewayPort: number;
  /** Reap the current daemon grandchild → true ONLY when confirmed dead AND the port is free. */
  readonly reap: (child: ChildProcess | undefined, gatewayPort: number) => Promise<boolean>;
  /** Probe whether `gatewayPort` is bindable (true = FREE) — the WR-02 pre-rebind gate. */
  readonly isPortFree: (gatewayPort: number) => Promise<boolean>;
  /** Spawn a fresh daemon grandchild on the (current) config. Records nothing — the caller assigns. */
  readonly spawn: () => ChildProcess;
  /** Wait (bounded) for the fresh daemon's gateway `/health` → true on healthy. */
  readonly waitForHealthy: () => Promise<boolean>;
  /**
   * Optional seam run AFTER the prior daemon is confirmed reaped + the port is free, but
   * BEFORE the fresh daemon is spawned — the `/reset` wipe (memory.db/logs/sessions) goes
   * here so it cannot run while the daemon holds the db, and is never wasted on a refused
   * respawn (a latch/port-busy refusal short-circuits before this runs).
   */
  readonly beforeSpawn?: () => void | Promise<void>;
}

/**
 * Reap the current daemon grandchild, then re-spawn it on the (current) config — the
 * shared core of `/restart`, `/reconfigure`, and `/reset`. An optional `beforeSpawn`
 * seam (the `/reset` db/logs/sessions wipe) runs between the confirmed reap and the
 * fresh spawn, so it cannot race a live daemon and is skipped on a refusal.
 *
 * AUTHORITATIVE-TEARDOWN (WR-01): if `state.tearingDown` is already set, REFUSE — never
 * create a new daemon once teardown has begun (on the orphan-reap path `process.exit`
 * would not signal it, so it would leak). Returns `{ ok: false, refusal: "tearing_down" }`.
 *
 * REAP-AWARE REBIND (WR-02): only re-spawn once the prior daemon is CONFIRMED gone AND the
 * gateway port is actually free. If `reap` returned false (the SIGKILL grace overran) OR
 * the port is still held, REFUSE with `{ ok: false, refusal: "port_busy" }` rather than
 * racing a fresh daemon onto an occupied port (the EADDRINUSE flake). The reap result is
 * re-checked against the live `tearingDown` latch AFTER the await, so a teardown that
 * began DURING the reap also wins (no respawn into a teardown).
 */
export async function respawnDaemon(state: LifecycleState, deps: RespawnDeps): Promise<RespawnOutcome> {
  // WR-01: refuse a respawn the instant teardown has begun — checked BEFORE the reap.
  if (state.tearingDown) return { ok: false, refusal: "tearing_down" };

  const reaped = await deps.reap(state.daemon, deps.gatewayPort);

  // WR-01: teardown may have begun DURING the reap's awaits — re-check the latch and
  // bail rather than spawn a daemon teardown can no longer see (it already passed its
  // own reap of state.daemon). Teardown's post-await re-reap is the backstop if we lose
  // this race by a hair, but refusing here keeps the common case from ever creating D2.
  if (state.tearingDown) return { ok: false, refusal: "tearing_down" };

  // WR-02: honor the reap result + confirm the port is free before rebinding. A reap
  // that timed out (false) or a port still held → an honest refusal, never an
  // EADDRINUSE race onto an occupied gateway port.
  if (!reaped || !(await deps.isPortFree(deps.gatewayPort))) {
    return { ok: false, refusal: "port_busy" };
  }

  // One more latch re-check after the (awaited) port probe — teardown could have begun
  // in that window too. This is the last gate before we create D2.
  if (state.tearingDown) return { ok: false, refusal: "tearing_down" };

  // The daemon is dead + the port is free: run the optional between-reap-and-spawn seam
  // (the /reset wipe) now — safe (no daemon holds the db) and never wasted on a refusal.
  if (deps.beforeSpawn !== undefined) {
    await deps.beforeSpawn();
    // A final latch re-check — beforeSpawn may have awaited (fs wipes), opening one more
    // window for teardown to begin. Never spawn into a teardown.
    if (state.tearingDown) return { ok: false, refusal: "tearing_down" };
  }

  state.daemon = deps.spawn();
  const healthy = await deps.waitForHealthy();
  return healthy ? { ok: true } : { ok: false };
}

/** The injectable reap seam the authoritative teardown drives (the rig's real `reapDaemon`). */
export interface TeardownReapDeps {
  /** The pre-allocated gateway port to confirm free. */
  readonly gatewayPort: number;
  /** Reap a daemon grandchild deterministically (SIGTERM → grace → SIGKILL → port-free). */
  readonly reap: (child: ChildProcess | undefined, gatewayPort: number) => Promise<boolean>;
}

/**
 * The AUTHORITATIVE teardown reap (WR-01). Sets the `tearingDown` latch, reaps the
 * current daemon, then RE-READS `state.daemon` and reaps AGAIN: a `/reset`/`/restart`
 * that raced in before the latch took effect may have swapped `state.daemon` to a fresh
 * D2 between the latch and the first reap — re-reaping the now-current handle guarantees
 * NO daemon survives teardown, even on the orphan-reap path (where `process.exit` does
 * not group-kill). The re-reap repeats while the handle keeps changing (bounded by
 * `maxReReaps`) so a pathological respawn-during-reap storm still converges. Idempotent:
 * a second call (latch already set) is a no-op returning false.
 *
 * @returns true when this call performed the reaping (the first/owning teardown), false
 *   when the latch was already set (a concurrent teardown owns it).
 */
export async function reapForTeardown(
  state: LifecycleState,
  deps: TeardownReapDeps,
  maxReReaps = 3,
): Promise<boolean> {
  if (state.tearingDown) return false;
  state.tearingDown = true;

  // Reap the daemon as it stands now.
  let last = state.daemon;
  await deps.reap(last, deps.gatewayPort);

  // Re-read + re-reap: a respawn that snuck in before the latch (or in the reap's awaits)
  // swapped state.daemon — reap whatever is current NOW. With the latch set, respawnDaemon
  // refuses, so the handle stabilizes within a couple of iterations; the cap bounds a
  // pathological storm.
  for (let i = 0; i < maxReReaps; i++) {
    const current = state.daemon;
    if (current === last) break; // converged — no new daemon appeared.
    last = current;
    await deps.reap(current, deps.gatewayPort);
  }
  return true;
}

/** The injectable poll seam the bounded port-free settle drives (the rig's real `isPortFree`). */
export type IsPortFreeFn = (port: number) => Promise<boolean>;

/**
 * Poll until `port` is FREE (bindable) or the bounded budget is exhausted — the
 * deterministic replacement for a fixed real-clock settle sleep (review INFO-3). A
 * gateway port can linger briefly in TIME_WAIT/LAST_ACK after the daemon process exits,
 * so the no-leak assertion polls rather than guessing a fixed delay. Returns true the
 * instant the port frees, false if it is still held after `attempts × intervalMs`.
 *
 * @param sleep injectable delay (tests pass a no-op to make the bound deterministic).
 */
export async function pollPortFree(
  port: number,
  isPortFree: IsPortFreeFn,
  attempts = 40,
  intervalMs = 250,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isPortFree(port)) return true;
    await sleep(intervalMs);
  }
  return false;
}
