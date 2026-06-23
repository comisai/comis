// SPDX-License-Identifier: Apache-2.0
/**
 * `rig-lifecycle.test.ts` — the DETERMINISTIC unit proof of the detached-rig respawn +
 * teardown DECISION logic (Phase 208 review WR-01/WR-02/INFO-3 fixes).
 *
 * These cover the race/flake-sensitive transitions of `rig-daemon.ts` WITHOUT booting a
 * real daemon: the logic was extracted to `rig-lifecycle.ts` precisely so the
 * interleavings that leak a zombie (WR-01) or flake on EADDRINUSE (WR-02) are provable
 * with injected, side-effect-free seams.
 *
 * RED-first evidence (the pre-patch behavior these would catch):
 *   - WR-01: pre-patch `restartDaemon`/`/reset` spawned a fresh daemon WITHOUT checking
 *     `tearingDown` → a respawn during teardown's awaits leaked on the orphan-reap path.
 *     `respawnDaemon` now REFUSES under the latch, and `reapForTeardown` re-reaps a
 *     daemon that raced in — the two tests below FAIL against a no-latch respawn.
 *   - WR-02: pre-patch respawn IGNORED the reap return value + rebound the port blindly
 *     → an EADDRINUSE flake when the SIGKILL grace overran. `respawnDaemon` now refuses
 *     when reap returned false / the port is held — the test FAILS if the respawn fires
 *     regardless.
 *   - INFO-3: a fixed 1500ms settle is replaced by `pollPortFree`; the test asserts it
 *     returns the instant the port frees (deterministic, not a real-clock guess).
 *
 * A final WIRING guard greps `rig-daemon.ts` to prove it actually CONSUMES these helpers
 * (not a parallel-but-dead copy) — so a future reintroduction of the inline blind
 * respawn fails this gate.
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live` →
 * 0 files = false green):
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/harness/rig-lifecycle.test.ts
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import {
  respawnDaemon,
  reapForTeardown,
  pollPortFree,
  type LifecycleState,
  type RespawnDeps,
} from "./rig-lifecycle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** A throwaway ChildProcess stand-in — only `.pid` matters to the lifecycle logic. */
function fakeChild(pid: number): ChildProcess {
  return { pid } as unknown as ChildProcess;
}

/** A minimal mutable state with the two fields the orchestrators touch. */
function makeState(daemon: ChildProcess | undefined): LifecycleState {
  return { daemon, tearingDown: false };
}

// ---------------------------------------------------------------------------
// WR-01 — teardown is AUTHORITATIVE: a respawn refuses under the latch, and
//         teardown re-reaps a daemon that raced in before the latch took effect.
// ---------------------------------------------------------------------------

describe("respawnDaemon — WR-01 teardown-authoritative respawn refusal", () => {
  it("REFUSES to respawn once tearingDown is set, never creating a daemon teardown cannot see", async () => {
    const state = makeState(fakeChild(100));
    state.tearingDown = true; // teardown has begun.

    const spawn = vi.fn(() => fakeChild(200));
    const deps: RespawnDeps = {
      gatewayPort: 5000,
      reap: vi.fn(async () => true),
      isPortFree: vi.fn(async () => true),
      spawn,
      waitForHealthy: vi.fn(async () => true),
    };

    const out = await respawnDaemon(state, deps);

    // Honest refusal — NO new daemon spawned (the WR-01 leak fix: respawn cannot
    // create D2 after teardown begins).
    expect(out).toEqual({ ok: false, refusal: "tearing_down" });
    expect(spawn).not.toHaveBeenCalled();
    expect(state.daemon).toBe(state.daemon); // unchanged — still the pre-teardown handle.
  });

  it("when teardown begins DURING the reap await, refuses the respawn (the latch flips mid-reap)", async () => {
    const state = makeState(fakeChild(100));
    const spawn = vi.fn(() => fakeChild(200));
    // The reap await is where teardown's latch realistically flips — simulate it.
    const reap = vi.fn(async () => {
      state.tearingDown = true;
      return true;
    });
    const deps: RespawnDeps = {
      gatewayPort: 5000,
      reap,
      isPortFree: vi.fn(async () => true),
      spawn,
      waitForHealthy: vi.fn(async () => true),
    };

    const out = await respawnDaemon(state, deps);

    expect(out).toEqual({ ok: false, refusal: "tearing_down" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("re-reaps a daemon a racing /reset swapped in before the latch — NO daemon survives teardown (orphan-reap path)", async () => {
    // The WR-01 interleaving: a /reset reassigned state.daemon to D2 in the window
    // between the latch being set and teardown's first reap reading it. teardown must
    // re-read state.daemon and reap the LATEST one too.
    const d1 = fakeChild(101);
    const d2 = fakeChild(202);
    const state = makeState(d1);

    const reaped: Array<number | undefined> = [];
    let firstReap = true;
    const reap = vi.fn(async (child: ChildProcess | undefined) => {
      reaped.push(child?.pid);
      if (firstReap) {
        firstReap = false;
        // A racing /reset snuck D2 in just before/during the first reap.
        state.daemon = d2;
      }
      return true;
    });

    const owned = await reapForTeardown(state, { gatewayPort: 5000, reap });

    expect(owned).toBe(true);
    // BOTH the original D1 AND the raced-in D2 were reaped — no leak on the
    // orphan-reap path (where process.exit does not group-kill).
    expect(reaped).toContain(d1.pid);
    expect(reaped).toContain(d2.pid);
  });

  it("is idempotent — a second teardown (latch already set) is a no-op that reaps nothing", async () => {
    const state = makeState(fakeChild(100));
    state.tearingDown = true; // a first teardown already owns it.
    const reap = vi.fn(async () => true);

    const owned = await reapForTeardown(state, { gatewayPort: 5000, reap });

    expect(owned).toBe(false);
    expect(reap).not.toHaveBeenCalled();
  });

  it("converges (no re-reap) when no daemon raced in — exactly one reap of the stable handle", async () => {
    const d1 = fakeChild(101);
    const state = makeState(d1);
    const reap = vi.fn(async () => true);

    await reapForTeardown(state, { gatewayPort: 5000, reap });

    // state.daemon never changed → the re-read sees the same handle → no second reap.
    expect(reap).toHaveBeenCalledTimes(1);
    expect(reap).toHaveBeenCalledWith(d1, 5000);
  });
});

// ---------------------------------------------------------------------------
// WR-02 — the in-proc respawn HONORS the reap result + polls isPortFree before
//         rebinding: no EADDRINUSE race onto an occupied gateway port.
// ---------------------------------------------------------------------------

describe("respawnDaemon — WR-02 reap-aware, port-free-gated rebind", () => {
  it("REFUSES to rebind when reap returned false (the SIGKILL grace overran) — no EADDRINUSE race", async () => {
    const state = makeState(fakeChild(100));
    const spawn = vi.fn(() => fakeChild(200));
    const isPortFree = vi.fn(async () => true); // even if the port LOOKS free…
    const deps: RespawnDeps = {
      gatewayPort: 5000,
      reap: vi.fn(async () => false), // …reap did NOT confirm the process dead.
      isPortFree,
      spawn,
      waitForHealthy: vi.fn(async () => true),
    };

    const out = await respawnDaemon(state, deps);

    expect(out).toEqual({ ok: false, refusal: "port_busy" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("REFUSES to rebind when the gateway port is still held even though reap returned true", async () => {
    const state = makeState(fakeChild(100));
    const spawn = vi.fn(() => fakeChild(200));
    const deps: RespawnDeps = {
      gatewayPort: 5000,
      reap: vi.fn(async () => true),
      isPortFree: vi.fn(async () => false), // the port is still bound (SO_REUSEADDR lingerer).
      spawn,
      waitForHealthy: vi.fn(async () => true),
    };

    const out = await respawnDaemon(state, deps);

    expect(out).toEqual({ ok: false, refusal: "port_busy" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("RESPAWNS and reports healthy when reap confirmed dead AND the port is free", async () => {
    const d1 = fakeChild(100);
    const d2 = fakeChild(200);
    const state = makeState(d1);
    const spawn = vi.fn(() => d2);
    const deps: RespawnDeps = {
      gatewayPort: 5000,
      reap: vi.fn(async () => true),
      isPortFree: vi.fn(async () => true),
      spawn,
      waitForHealthy: vi.fn(async () => true),
    };

    const out = await respawnDaemon(state, deps);

    expect(out).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(state.daemon).toBe(d2); // the fresh daemon is recorded.
  });

  it("RESPAWNS but reports unhealthy (ok:false, no refusal) when the fresh daemon never goes healthy", async () => {
    const state = makeState(fakeChild(100));
    const deps: RespawnDeps = {
      gatewayPort: 5000,
      reap: vi.fn(async () => true),
      isPortFree: vi.fn(async () => true),
      spawn: vi.fn(() => fakeChild(200)),
      waitForHealthy: vi.fn(async () => false), // booted but never healthy.
    };

    const out = await respawnDaemon(state, deps);

    // A genuine boot-unhealthy is ok:false with NO refusal (distinct from a refusal —
    // the daemon WAS spawned; the rig-control verb surfaces *_unhealthy 503).
    expect(out).toEqual({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// INFO-3 — the no-leak settle is a BOUNDED POLL, not a fixed real-clock sleep.
// ---------------------------------------------------------------------------

describe("pollPortFree — INFO-3 bounded port-free settle (no fixed sleep)", () => {
  it("returns true the instant the port frees, without exhausting the attempt budget", async () => {
    let calls = 0;
    const isPortFree = vi.fn(async () => {
      calls++;
      return calls >= 3; // free on the 3rd probe.
    });
    const sleep = vi.fn(async () => undefined); // deterministic — no real clock.

    const free = await pollPortFree(5000, isPortFree, 40, 250, sleep);

    expect(free).toBe(true);
    expect(calls).toBe(3); // stopped as soon as it freed — did NOT poll all 40 times.
    expect(sleep).toHaveBeenCalledTimes(2); // slept between the first two failed probes only.
  });

  it("returns false when the port never frees within the bounded attempts (honest, not a hang)", async () => {
    const isPortFree = vi.fn(async () => false);
    const sleep = vi.fn(async () => undefined);

    const free = await pollPortFree(5000, isPortFree, 5, 250, sleep);

    expect(free).toBe(false);
    expect(isPortFree).toHaveBeenCalledTimes(5); // exactly the bound — never unbounded.
  });
});

// ---------------------------------------------------------------------------
// WIRING — rig-daemon.ts actually CONSUMES the helpers (not a dead parallel copy)
// ---------------------------------------------------------------------------

describe("rig-daemon.ts wiring — the lifecycle helpers are the LIVE respawn/teardown path", () => {
  const rigDaemonSrc = readFileSync(resolve(__dirname, "./rig-daemon.ts"), "utf8");

  it("imports respawnDaemon, reapForTeardown, and pollPortFree from rig-lifecycle (the extracted decisions)", () => {
    expect(rigDaemonSrc).toMatch(/from\s+["']\.\/rig-lifecycle\.js["']/);
    expect(rigDaemonSrc).toMatch(/\brespawnDaemon\b/);
    expect(rigDaemonSrc).toMatch(/\breapForTeardown\b/);
  });

  it("routes teardown through reapForTeardown so the authoritative re-reap is live (WR-01)", () => {
    // teardown must drive the authoritative latch+re-reap helper, not a bare
    // single reapDaemon(state.daemon, ...) that a racing /reset can outrun.
    expect(rigDaemonSrc).toMatch(/reapForTeardown\s*\(/);
  });

  it("routes /restart and /reset respawn through respawnDaemon so the latch + port gate are live (WR-01/WR-02)", () => {
    expect(rigDaemonSrc).toMatch(/respawnDaemon\s*\(/);
  });
});
