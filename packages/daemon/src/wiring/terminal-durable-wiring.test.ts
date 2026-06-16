// SPDX-License-Identifier: Apache-2.0
/**
 * LO-03 (165-REVIEW) regression: the LIVE-01 liveness check's `lastActivity` refresh.
 *
 * `checkLiveness` (the daemon-bound single liveness probe) round-trips `registry.status`,
 * which ALREADY stamps `handle.lastActivity = nowMs()` as a side effect (the registry's
 * status method). So the per-session `lastActivity` is refreshed by the liveness check
 * itself — making the holder's separate explicit `refreshLastActivity` dep REDUNDANT
 * (165-REVIEW LO-03). This file pins the load-bearing behavior so the removal of that
 * redundant dep is safe: a `checkLiveness` round-trip advances `lastActivity` (the ENDURE-01
 * idle-reaper unify, I9 — a quiet-but-busy compile's lastActivity stays fresh so the idle
 * sweep never evicts it), via the `status` stamp, with NO separate refresh hook.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { buildWakeDurabilityDeps } from "./terminal-durable-wiring.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn(function (this: unknown) { return this; }) };
}

describe("buildWakeDurabilityDeps — LO-03: checkLiveness refreshes lastActivity via the status round-trip", () => {
  it("a checkLiveness round-trip advances the handle's lastActivity (the status stamp IS the I9 reaper-unify — no separate refresh needed)", async () => {
    let now = 1_000;
    // A live handle whose lastActivity is stale (an old quiet-but-busy compile).
    const handle = { sessionId: "s-1", status: "running" as const, lastActivity: 1, durable: false as const, tmuxName: undefined };
    const registry = {
      get: vi.fn(() => handle as never),
      // The registry's status stamps lastActivity (mirrors the production registry.status side
      // effect) and returns the worker classifier perception.
      status: vi.fn(async () => {
        handle.lastActivity = now;
        return { state: "working" as const, lastActivity: now, interactions: 1, cursorParked: false, screenDiffEmpty: false, confidence: "high" as const, reason: "working" };
      }),
    };
    const registries = new Map([["a", registry]]);
    const deps = buildWakeDurabilityDeps({
      dataDir: "/tmp/nonexistent-comis-lo03",
      registries: registries as never,
      workerStuckMs: 600_000,
      nowMs: () => now,
    });

    now = 50_000; // time advances before the liveness check
    const signal = await deps.checkLiveness("s-1", "a");

    // The liveness check ran the status round-trip (the worker classifier perception, I2 — no screen).
    expect(registry.status).toHaveBeenCalledTimes(1);
    expect(signal, "a working classifier → a busy signal (alive, recent progress)").toBeDefined();
    // The status round-trip advanced lastActivity to now — the I9 reaper-unify, with NO separate
    // refreshLastActivity dep (LO-03: the explicit refresh was redundant given this side effect).
    expect(handle.lastActivity, "checkLiveness's status round-trip refreshes lastActivity (the I9 unify)").toBe(50_000);
  });

  it("the wake-durability bundle no longer exposes a redundant refreshLastActivity dep (LO-03 removed)", () => {
    const deps = buildWakeDurabilityDeps({
      dataDir: "/tmp/nonexistent-comis-lo03",
      registries: new Map() as never,
      workerStuckMs: 0,
      nowMs: () => 1,
    });
    // LO-03: the redundant explicit refresh hook is gone — checkLiveness's status round-trip
    // refreshes lastActivity, so the bundle is {driveJournalStore, checkLiveness} only.
    expect(Object.keys(deps).sort()).toEqual(["checkLiveness", "driveJournalStore"]);
  });
});
