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
import {
  buildWakeDurabilityDeps,
  buildIsTmuxAlive,
  isTmuxServerStranded,
  recreateStrandedTmuxServerOnBoot,
} from "./terminal-durable-wiring.js";

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

  it("ISSUE-3: a channel/API-stamped session's liveness check resolves the LIVE session (getOwner), NOT skipped as gone cross-owner", async () => {
    // Live VPS finding 2026-06-16: a chat-API/Telegram drive is stamped under (userId, sessionKey).
    // Pre-fix checkLiveness used driveOwner=(agentId,"") → registry.get cross-owner → undefined → the
    // LIVE-01 backstop SKIPPED the live session (a hung channel drive would never be detected; a busy
    // one never refreshed → the ENDURE-01 reaper could evict it as idle). The fix recovers the stamped
    // owner via the registry's getOwner seam.
    const STAMPED = { agentId: "openai-api", sessionKey: "default:openai-api:openai" };
    const handle = { sessionId: "s-1", status: "running" as const, lastActivity: 1, durable: false as const, tmuxName: undefined };
    const owned = (o: { agentId?: string; sessionKey?: string }): boolean => o?.agentId === STAMPED.agentId && o?.sessionKey === STAMPED.sessionKey;
    const registry = {
      getOwner: vi.fn(() => STAMPED),
      get: vi.fn((_id: string, o: { agentId?: string; sessionKey?: string }) => (owned(o) ? (handle as never) : undefined)),
      status: vi.fn(async (_id: string, o: { agentId?: string; sessionKey?: string }) =>
        owned(o)
          ? { state: "working" as const, lastActivity: 50_000, interactions: 1, cursorParked: false, screenDiffEmpty: false, confidence: "high" as const, reason: "working" }
          : { state: "exited" as const, lastActivity: 0, interactions: 0, cursorParked: false, screenDiffEmpty: true, confidence: "high" as const, reason: "exited" }),
    };
    const registries = new Map([["a", registry]]);
    const deps = buildWakeDurabilityDeps({ dataDir: "/tmp/nonexistent-comis-issue3", registries: registries as never, workerStuckMs: 600_000, nowMs: () => 50_000 });

    const signal = await deps.checkLiveness("s-1", "a"); // agentId "a" is the REAL agent; the session is stamped under the userId

    expect(signal, "a live channel/API-stamped session must resolve (busy/alive), not be skipped as gone cross-owner").toBeDefined();
    expect(signal).toMatchObject({ alive: true });
    expect(registry.status.mock.calls[0]?.[1], "the liveness status round-trip must use the recovered STAMPED owner").toMatchObject(STAMPED);
  });

  it("DELIVER-01 (#2): an awaiting-input classifier verdict surfaces awaitingInput:true (a finished, idle backgrounded drive) — still busy, NOT hung", async () => {
    // The completion signal the daemon backstop reads to fire a one-time 'drive finished —
    // waiting for input' notification. An awaiting-input drive is alive + busy (the busy/hung
    // predicate is unchanged); awaitingInput is a PURELY ADDITIVE field on the probe.
    const handle = { sessionId: "s-1", status: "running" as const, lastActivity: 1, durable: false as const, tmuxName: undefined };
    const registry = {
      get: vi.fn(() => handle as never),
      status: vi.fn(async () => ({
        state: "awaiting-input" as const,
        lastActivity: 50_000,
        interactions: 3,
        cursorParked: true,
        screenDiffEmpty: true,
        confidence: "high" as const,
        reason: "settled_cursor_parked",
      })),
    };
    const registries = new Map([["a", registry]]);
    const deps = buildWakeDurabilityDeps({ dataDir: "/tmp/nonexistent-comis-deliver01", registries: registries as never, workerStuckMs: 600_000, nowMs: () => 50_000 });

    const signal = await deps.checkLiveness("s-1", "a");
    expect(signal, "an awaiting-input drive is alive + busy (not hung)").toMatchObject({ alive: true });
    expect(signal?.awaitingInput, "awaiting-input surfaces the DELIVER-01 completion signal").toBe(true);
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

describe("buildIsTmuxAlive — DUR-01: the daemon liveness probe targets the worker's -S data-dir socket", () => {
  const socketPath = "/home/comis/.comis/terminal-worker/tmux.sock";

  it("probes `tmux -S <dataDir socket> has-session -t comis-<id>` — NOT tmux's default /tmp socket", () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const isAlive = buildIsTmuxAlive("/usr/bin/tmux", socketPath, (bin, args) => {
      calls.push({ bin, args });
    });
    expect(isAlive("comis-abc")).toBe(true); // run() did not throw ⇒ exit 0 ⇒ alive
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe("/usr/bin/tmux");
    // -S must lead the args so the probe hits the SAME socket the worker bound; a default
    // /tmp socket is unreachable from a restarted daemon under PrivateTmp=yes.
    expect(calls[0]!.args.slice(0, 2)).toEqual(["-S", socketPath]);
    expect(calls[0]!.args).toEqual(["-S", socketPath, "has-session", "-t", "comis-abc"]);
  });

  it("returns false (the SAFE direction) when the probe throws — a probe that can't confirm alive must not assert it", () => {
    const isAlive = buildIsTmuxAlive("/usr/bin/tmux", socketPath, () => {
      throw new Error("exit 1: no such session");
    });
    expect(isAlive("comis-gone")).toBe(false);
  });

  it("absent tmuxPath ⇒ always-false (durable falls back to the lost floor, I1)", () => {
    expect(buildIsTmuxAlive(undefined, socketPath)("comis-abc")).toBe(false);
  });
});

// RECUR-02 (live VPS 2026-06-17): a durable tmux server that SURVIVES a daemon restart
// (KillMode=process) is STRANDED in the prior daemon generation's mount namespace — systemd
// PrivateTmp/ProtectHome give every daemon START a fresh mount ns, so the surviving server
// (forked by the OLD daemon) sits in a now-dismantled ns. Its EXISTING sessions keep running
// (their bwrap was set up when the ns was healthy) but EVERY NEW `bwrap` session it forks dies
// ~2.5s (exit 1 — mount setup runs in the torn-down ns). PROVEN: server mnt ns 4026532294 ≠
// restarted daemon mnt ns 4026532302; a new claude AND a plain `sh` new-session both die while
// the re-attached durable one survives. The fix recreates the stranded server on boot.
describe("isTmuxServerStranded — the stranded-mount-namespace detector (RECUR-02)", () => {
  it("STRANDED when the surviving server's mnt ns differs from this daemon's (the post-restart strand)", () => {
    expect(isTmuxServerStranded("mnt:[4026532294]", "mnt:[4026532302]")).toBe(true);
  });

  it("NOT stranded when the server shares THIS daemon's mnt ns (a healthy first-boot server)", () => {
    expect(isTmuxServerStranded("mnt:[4026532302]", "mnt:[4026532302]")).toBe(false);
  });

  it("NOT stranded (the SAFE direction) when the server ns is unknowable — no server / unreadable", () => {
    // A probe that cannot confirm STRANDED must never assert it (never needlessly kill a server).
    expect(isTmuxServerStranded(undefined, "mnt:[4026532302]")).toBe(false);
  });

  it("NOT stranded (the SAFE direction) when THIS daemon's own mnt ns is unreadable", () => {
    expect(isTmuxServerStranded("mnt:[4026532294]", undefined)).toBe(false);
  });
});

describe("recreateStrandedTmuxServerOnBoot — kill the stranded server so new sessions get a fresh one (RECUR-02)", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    socketPath: "/data/x/terminal-worker/tmux.sock",
    tmuxPath: "/usr/bin/tmux",
    logger: makeLogger(),
    ...over,
  });

  it("kills the server when it is stranded (ns mismatch) — new sessions then fork a fresh server in the live ns", () => {
    const killServer = vi.fn();
    const r = recreateStrandedTmuxServerOnBoot(
      base({
        readServerMntNs: () => "mnt:[4026532294]", // the surviving prior-generation server
        readDaemonMntNs: () => "mnt:[4026532302]", // THIS daemon
        killServer,
      }) as never,
    );
    expect(r.stranded).toBe(true);
    expect(r.killed).toBe(true);
    expect(killServer).toHaveBeenCalledTimes(1);
    expect(killServer).toHaveBeenCalledWith("/data/x/terminal-worker/tmux.sock");
  });

  it("does NOT kill a healthy server sharing this daemon's ns (durable sessions survive a no-op boot)", () => {
    const killServer = vi.fn();
    const r = recreateStrandedTmuxServerOnBoot(
      base({
        readServerMntNs: () => "mnt:[4026532302]",
        readDaemonMntNs: () => "mnt:[4026532302]",
        killServer,
      }) as never,
    );
    expect(r.stranded).toBe(false);
    expect(r.killed).toBe(false);
    expect(killServer).not.toHaveBeenCalled();
  });

  it("does NOT kill when there is no server / the ns is unreadable (nothing to recreate, SAFE)", () => {
    const killServer = vi.fn();
    const r = recreateStrandedTmuxServerOnBoot(
      base({ readServerMntNs: () => undefined, readDaemonMntNs: () => "mnt:[4026532302]", killServer }) as never,
    );
    expect(r.killed).toBe(false);
    expect(killServer).not.toHaveBeenCalled();
  });

  it("absent tmuxPath ⇒ no-op (no tmux on this host — durable already degrades to the lost floor)", () => {
    const killServer = vi.fn();
    const r = recreateStrandedTmuxServerOnBoot(
      base({ tmuxPath: undefined, readServerMntNs: () => "mnt:[4026532294]", readDaemonMntNs: () => "mnt:[4026532302]", killServer }) as never,
    );
    expect(r.killed).toBe(false);
    expect(killServer).not.toHaveBeenCalled();
  });
});
