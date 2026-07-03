// SPDX-License-Identifier: Apache-2.0
/**
 * The liveness check's `lastActivity` refresh.
 *
 * `checkLiveness` (the daemon-bound single liveness probe) round-trips `registry.status`,
 * which ALREADY stamps `handle.lastActivity = nowMs()` as a side effect (the registry's
 * status method). So the per-session `lastActivity` is refreshed by the liveness check
 * itself — making the holder's separate explicit `refreshLastActivity` dep REDUNDANT.
 * This file pins the load-bearing behavior so the removal of that
 * redundant dep is safe: a `checkLiveness` round-trip advances `lastActivity` (the
 * idle-reaper unify — a quiet-but-busy compile's lastActivity stays fresh so the idle
 * sweep never evicts it), via the `status` stamp, with NO separate refresh hook.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildWakeDurabilityDeps,
  buildIsTmuxAlive,
  buildKillTmux,
  isTmuxServerStranded,
  recreateStrandedTmuxServerOnBoot,
} from "./terminal-durable-wiring.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn(function (this: unknown) { return this; }) };
}

describe("buildWakeDurabilityDeps — checkLiveness refreshes lastActivity via the status round-trip", () => {
  it("a checkLiveness round-trip advances the handle's lastActivity (the status stamp IS the reaper-unify — no separate refresh needed)", async () => {
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

    // The liveness check ran the status round-trip (the worker classifier perception — no screen).
    expect(registry.status).toHaveBeenCalledTimes(1);
    expect(signal, "a working classifier → a busy signal (alive, recent progress)").toBeDefined();
    // The status round-trip advanced lastActivity to now — the reaper-unify, with NO separate
    // refreshLastActivity dep (the explicit refresh was redundant given this side effect).
    expect(handle.lastActivity, "checkLiveness's status round-trip refreshes lastActivity (the reaper-unify)").toBe(50_000);
  });

  it("a channel/API-stamped session's liveness check resolves the LIVE session (getOwner), NOT skipped as gone cross-owner", async () => {
    // A chat-API/Telegram drive is stamped under (userId, sessionKey).
    // A checkLiveness that used driveOwner=(agentId,"") → registry.get cross-owner → undefined → the
    // liveness backstop SKIPPED the live session (a hung channel drive would never be detected; a busy
    // one never refreshed → the idle reaper could evict it as idle). The fix recovers the stamped
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

  it("an awaiting-input classifier verdict surfaces awaitingInput:true (a finished, idle backgrounded drive) — still busy, NOT hung", async () => {
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
    expect(signal?.awaitingInput, "awaiting-input surfaces the completion signal").toBe(true);
  });

  it("a settled (awaiting-input) UNATTENDED drive does NOT get lastActivity refreshed by the passive probe (so the idle reaper can finally evict it)", async () => {
    // A backgrounded UNATTENDED (webhook/cron, owner
    // sessionKey "") drive that cleanly SETTLES (awaiting-input) is classified BUSY, so the liveness
    // backstop keeps probing it every ~90s and each `registry.status` round-trip stamps lastActivity
    // = now → the idle reaper's `now - lastActivity > idleTtlMs` cap can NEVER fire → the
    // finished drive lingers until clean-restart. The fix: the PASSIVE liveness probe must not
    // refresh a settled unattended drive's idle clock (it made no progress), so the reaper's
    // idleTtlMs measures from its last REAL activity and evicts it.
    let now = 1_000;
    const handle = { sessionId: "s-1", status: "running" as const, lastActivity: 1, durable: false as const, tmuxName: undefined };
    const registry = {
      getOwner: vi.fn(() => ({ agentId: "a", sessionKey: "" })), // the UNATTENDED (webhook/cron) owner
      get: vi.fn(() => handle as never),
      status: vi.fn(async () => {
        handle.lastActivity = now; // the production registry.status lastActivity side effect
        return { state: "awaiting-input" as const, lastActivity: now, interactions: 3, cursorParked: true, screenDiffEmpty: true, confidence: "high" as const, reason: "settled_cursor_parked" };
      }),
    };
    const deps = buildWakeDurabilityDeps({ dataDir: "/tmp/nonexistent-comis-linger01", registries: new Map([["a", registry]]) as never, workerStuckMs: 600_000, nowMs: () => now });

    now = 50_000; // time advances; the drive has been settled since its last real activity
    const signal = await deps.checkLiveness("s-1", "a");

    expect(signal?.awaitingInput, "the completion signal still surfaces (the fix touches only the idle clock)").toBe(true);
    // The passive probe restored lastActivity to its pre-probe (last-REAL-activity) value — NOT `now`.
    expect(handle.lastActivity, "a settled UNATTENDED drive's idle clock is frozen so the reaper's idleTtlMs can evict it").toBe(1);
  });

  it("an awaiting-input INTERACTIVE drive (owner sessionKey set) IS still refreshed — a human owns its lifecycle, the idle reaper does not touch it", async () => {
    let now = 1_000;
    const handle = { sessionId: "s-2", status: "running" as const, lastActivity: 1, durable: false as const, tmuxName: undefined };
    const registry = {
      getOwner: vi.fn(() => ({ agentId: "u", sessionKey: "default:u:u:peer:u" })), // an INTERACTIVE (channel) owner
      get: vi.fn(() => handle as never),
      status: vi.fn(async () => {
        handle.lastActivity = now;
        return { state: "awaiting-input" as const, lastActivity: now, interactions: 3, cursorParked: true, screenDiffEmpty: true, confidence: "high" as const, reason: "settled_cursor_parked" };
      }),
    };
    const deps = buildWakeDurabilityDeps({ dataDir: "/tmp/nonexistent-comis-linger01b", registries: new Map([["a", registry]]) as never, workerStuckMs: 600_000, nowMs: () => now });

    now = 50_000;
    await deps.checkLiveness("s-2", "a");

    // An interactive drive is left warm — reaping it would surprise the human who may reply later.
    expect(handle.lastActivity, "an interactive settled drive keeps the refresh (human-owned lifecycle)").toBe(50_000);
  });

  it("a still-PRODUCING awaiting-input UNATTENDED drive (screen advancing across probes) is NOT frozen — the reaper must not evict a working autonomous drive", async () => {
    // Claude Code parks its cursor at the `❯` composer WHILE autonomously
    // working (subagents running, a multi-phase run building, the status timer/token counter
    // advancing), so the classifier reports awaiting-input. An unconditional freeze then
    // lets the idle reaper EVICT a still-producing drive at idleTtlMs, mid-work. The fix: a
    // CHANGING on-screen render (real progress) keeps lastActivity fresh so the reaper never evicts it.
    let now = 1_000;
    let frame = 0;
    const handle = { sessionId: "s-3", status: "running" as const, lastActivity: 1, durable: false as const, tmuxName: undefined };
    const registry = {
      getOwner: vi.fn(() => ({ agentId: "a", sessionKey: "" })), // the UNATTENDED (webhook/cron) owner
      get: vi.fn(() => handle as never),
      status: vi.fn(async () => {
        handle.lastActivity = now; // the production registry.status lastActivity side effect
        return { state: "awaiting-input" as const, lastActivity: now, interactions: 3, cursorParked: true, screenDiffEmpty: true, confidence: "high" as const, reason: "settled_cursor_parked" };
      }),
      // Each probe sees a DIFFERENT render (an advancing timer / streaming subagent output) → producing.
      read: vi.fn(async () => ({ screen: `... building phase 1 — elapsed ${frame++}m ...`, cursor: { x: 0, y: 0 } })),
    };
    const deps = buildWakeDurabilityDeps({ dataDir: "/tmp/nonexistent-comis-producing01", registries: new Map([["a", registry]]) as never, workerStuckMs: 600_000, nowMs: () => now });

    await deps.checkLiveness("s-3", "a"); // probe 1 seeds the digest (no prior → the safe freeze)
    now = 50_000; // time advances
    const signal = await deps.checkLiveness("s-3", "a"); // probe 2: the screen advanced → producing

    expect(signal?.awaitingInput, "still surfaces the completion/attention signal").toBe(true);
    expect(handle.lastActivity, "a still-PRODUCING unattended drive keeps its fresh lastActivity — the reaper must NOT evict it mid-work").toBe(50_000);
  });

  it("a TRULY-IDLE awaiting-input UNATTENDED drive (screen UNCHANGED across probes) is still frozen — a finished/idle drive still evicts", async () => {
    let now = 1_000;
    const handle = { sessionId: "s-4", status: "running" as const, lastActivity: 1, durable: false as const, tmuxName: undefined };
    const registry = {
      getOwner: vi.fn(() => ({ agentId: "a", sessionKey: "" })),
      get: vi.fn(() => handle as never),
      status: vi.fn(async () => {
        handle.lastActivity = now;
        return { state: "awaiting-input" as const, lastActivity: now, interactions: 3, cursorParked: true, screenDiffEmpty: true, confidence: "high" as const, reason: "settled_cursor_parked" };
      }),
      read: vi.fn(async () => ({ screen: "All phases complete. ❯", cursor: { x: 2, y: 0 } })), // STATIC across probes
    };
    const deps = buildWakeDurabilityDeps({ dataDir: "/tmp/nonexistent-comis-producing01b", registries: new Map([["a", registry]]) as never, workerStuckMs: 600_000, nowMs: () => now });

    await deps.checkLiveness("s-4", "a"); // seed the digest
    now = 50_000;
    await deps.checkLiveness("s-4", "a"); // same screen → NOT producing → freeze

    expect(handle.lastActivity, "a truly-idle unattended drive (static screen) is frozen so idleTtlMs evicts it").toBe(1);
  });

  it("the wake-durability bundle no longer exposes a redundant refreshLastActivity dep", () => {
    const deps = buildWakeDurabilityDeps({
      dataDir: "/tmp/nonexistent-comis-lo03",
      registries: new Map() as never,
      workerStuckMs: 0,
      nowMs: () => 1,
    });
    // The redundant explicit refresh hook is gone — checkLiveness's status round-trip
    // refreshes lastActivity, so the bundle is {driveJournalStore, checkLiveness} only.
    expect(Object.keys(deps).sort()).toEqual(["checkLiveness", "driveJournalStore"]);
  });
});

describe("buildIsTmuxAlive — the daemon liveness probe targets the worker's -S data-dir socket", () => {
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

  it("absent tmuxPath ⇒ always-false (durable falls back to the lost floor)", () => {
    expect(buildIsTmuxAlive(undefined, socketPath)("comis-abc")).toBe(false);
  });
});

describe("buildKillTmux — deterministic durable-evict kill-session by name", () => {
  const socketPath = "/home/comis/.comis/terminal-worker/tmux.sock";

  it("kills `tmux -S <session socket> kill-session -t comis-<id>` — the path proven to reap a durable never-tasked drive", () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const kill = buildKillTmux("/usr/bin/tmux", socketPath, (bin, args) => calls.push({ bin, args }));
    kill("comis-abc", "/home/comis/.comis/terminal-worker/tmux-999.sock");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe("/usr/bin/tmux");
    // the per-session socket (a durable's per-boot server) leads, then kill-session -t <name>.
    expect(calls[0]!.args).toEqual(["-S", "/home/comis/.comis/terminal-worker/tmux-999.sock", "kill-session", "-t", "comis-abc"]);
  });

  it("falls back to the default socket when no per-session socket is given", () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    buildKillTmux("/usr/bin/tmux", socketPath, (bin, args) => calls.push({ bin, args }))("comis-abc");
    expect(calls[0]!.args).toEqual(["-S", socketPath, "kill-session", "-t", "comis-abc"]);
  });

  it("swallows a kill fault (already gone / spawn error) — the session is de-registered regardless (best-effort)", () => {
    const kill = buildKillTmux("/usr/bin/tmux", socketPath, () => {
      throw new Error("exit 1: no such session");
    });
    expect(() => kill("comis-gone")).not.toThrow();
  });

  it("absent tmuxPath ⇒ no-op (no run attempted)", () => {
    let ran = false;
    buildKillTmux(undefined, socketPath, () => { ran = true; })("comis-abc");
    expect(ran).toBe(false);
  });
});

// A durable tmux server that SURVIVES a daemon restart
// (KillMode=process) is STRANDED in the prior daemon generation's mount namespace — systemd
// PrivateTmp/ProtectHome give every daemon START a fresh mount ns, so the surviving server
// (forked by the OLD daemon) sits in a now-dismantled ns. Its EXISTING sessions keep running
// (their bwrap was set up when the ns was healthy) but EVERY NEW `bwrap` session it forks dies
// ~2.5s (exit 1 — mount setup runs in the torn-down ns). Observed: server mnt ns 4026532294 ≠
// restarted daemon mnt ns 4026532302; a new claude AND a plain `sh` new-session both die while
// the re-attached durable one survives. The fix recreates the stranded server on boot.
describe("isTmuxServerStranded — the stranded-mount-namespace detector", () => {
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

describe("recreateStrandedTmuxServerOnBoot — kill the stranded server so new sessions get a fresh one", () => {
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
