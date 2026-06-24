// SPDX-License-Identifier: Apache-2.0
/**
 * `constructCapabilityLayer` — the daemon-wide capability-layer boot wiring +
 * ACTIVATION (Phase 211 ENDPOINT-01/03 + JAIL-03 → Phase 212 Plan 05 Gap 3).
 * Asserts: the autonomy gate (construct ONLY when an agent is autonomy-bearing,
 * mirroring the broker gate); the JAIL-03 namespace preflight runs unconditionally;
 * and the Phase-212 dormancy ACTIVATION — when autonomy is on, the cap socket is
 * STARTED (`active:true` logged, the 0600 socket file exists); when autonomy is
 * off, NO socket is bound (`active:false` residue gone).
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PerAgentConfig, ClockPort, TimerPort, TimerHandle } from "@comis/core";
import { constructCapabilityLayer } from "./setup-capability-endpoint-boot.js";

/** Track temp data dirs + stop thunks so each socket-binding test tears down. */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A no-op TimerPort — the bounded-autonomy rate limiter schedules TTL-evict
 *  timers through it; the boot tests do not advance time, so a handle whose
 *  cancel/unref are no-ops is sufficient (and leak-free under `destroy()`). */
function createNoopTimers(): TimerPort {
  const handle: TimerHandle = { cancelled: false, cancel: () => {}, unref: () => {} };
  return { setTimeout: () => handle, setInterval: () => handle };
}

function createDeps(
  agents: Record<string, PerAgentConfig>,
  opts: { dataDir?: string; cronJobCount?: (agentId: string) => number } = {},
) {
  const clock: ClockPort = { now: () => 1_700_000_000_000 };
  // The boot helper threads daemonLogger into createCapabilityEndpoint (a
  // `submodule` child for the socket boundary, WR-02) AND into createBoundedAutonomy,
  // whose sub-modules bind a SECOND-level `submodule` child — so the child logger
  // must itself carry `child` (returns itself). A self-referential child handles
  // arbitrary nesting depth.
  const childLogger: Record<string, unknown> = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  childLogger.child = vi.fn(() => childLogger);
  const daemonLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => childLogger),
  } as unknown as Parameters<typeof constructCapabilityLayer>[0]["daemonLogger"];
  return {
    agents,
    rpcCall: vi.fn(async () => ({})),
    clock,
    timers: createNoopTimers(),
    dataDir: opts.dataDir ?? "/test/data",
    daemonLogger,
    ...(opts.cronJobCount ? { cronJobCount: opts.cronJobCount } : {}),
  };
}

/** A real temp data dir so `startSocket` can bind the 0600 cap.sock (auto-cleaned). */
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cap-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("constructCapabilityLayer autonomy gate + boot preflight", () => {
  // No agents → not autonomy-bearing → no cap handle (mirrors the broker being
  // absent without executor.broker). The preflight still runs (a host check).
  it("returns no cap handle when no agent is autonomy-bearing, but still runs the preflight", async () => {
    const result = await constructCapabilityLayer(createDeps({}));
    expect(result.capEndpointHandle).toBeUndefined();
    expect(result.capEndpointStop).toBeUndefined();
    expect(typeof result.namespacePreflightOk).toBe("boolean");
  });

  // An explicitly non-autonomy agent (profile: "assistant" → enabled:false) does
  // NOT trigger construction — and so NO socket is started (the gate holds).
  it("returns no cap handle and starts NO socket for an assistant-profile (enabled:false) agent", async () => {
    const agents = {
      a1: { autonomy: { profile: "assistant" } } as unknown as PerAgentConfig,
    };
    const deps = createDeps(agents);
    const result = await constructCapabilityLayer(deps);
    expect(result.capEndpointHandle).toBeUndefined();
    // Activation did NOT happen → the active:true INFO is never logged.
    expect(deps.daemonLogger.info).not.toHaveBeenCalled();
  });

  // An autonomy-bearing agent (profile: "standard" → enabled:true) DOES trigger
  // construction: a LeaseManager + endpoint + a cap.sock path under the data dir,
  // plus a stop thunk. The construction is logged once.
  it("constructs the lease layer for an autonomy-bearing (standard-profile) agent", async () => {
    const dataDir = tempDataDir();
    const deps = createDeps(
      { a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig },
      { dataDir },
    );
    const result = await constructCapabilityLayer(deps);
    cleanups.push(() => result.capEndpointStop?.());
    expect(result.capEndpointHandle).toBeDefined();
    expect(result.capEndpointHandle!.leaseManager).toBeDefined();
    expect(result.capEndpointHandle!.endpoint).toBeDefined();
    expect(result.capEndpointHandle!.capSocketPath).toContain("cap.sock");
    expect(typeof result.capEndpointStop).toBe("function");
    expect(deps.daemonLogger.info).toHaveBeenCalledTimes(1);
  });

  // PHASE 213 (CEIL/BUDGET/RATE/QUOTA): the daemon-wide BoundedAutonomy service
  // is constructed alongside the LeaseManager and held on the handle — the single
  // chokepoint the spawn ceiling / rate limit / outward quota / budget meter all
  // consult. Without it, none of the 213 bounds are live.
  it("constructs the BoundedAutonomy service and holds it on the handle", async () => {
    const dataDir = tempDataDir();
    const deps = createDeps(
      { a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig },
      { dataDir },
    );
    const result = await constructCapabilityLayer(deps);
    cleanups.push(() => result.capEndpointHandle?.boundedAutonomy?.destroy());
    cleanups.push(() => result.capEndpointStop?.());
    expect(result.capEndpointHandle!.boundedAutonomy).toBeDefined();
    // The composed surface is callable (the real per-root meter for the web charge).
    const outcome = result.capEndpointHandle!.boundedAutonomy.reserveBudget(
      "root-x", "_web", "_web", 0, 0,
    );
    expect(outcome.kind).toBeDefined();
  });

  // RATE-02 count source: the cronJobCount provider threaded into
  // constructCapabilityLayer is bound INTO the service — boundedAutonomy.cronCount
  // delegates to it (so the cap endpoint's cronSelfMax cap reads a REAL count, not
  // an undefined/0 stub). daemon.ts binds the provider to the per-agent
  // CronScheduler.getJobs().length.
  it("binds the cronJobCount provider into BoundedAutonomy.cronCount", async () => {
    const dataDir = tempDataDir();
    const deps = createDeps(
      { a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig },
      { dataDir, cronJobCount: (id: string) => (id === "a1" ? 4 : 0) },
    );
    const result = await constructCapabilityLayer(deps);
    cleanups.push(() => result.capEndpointHandle?.boundedAutonomy?.destroy());
    cleanups.push(() => result.capEndpointStop?.());
    // The provider is threaded all the way through to the service.
    expect(result.capEndpointHandle!.boundedAutonomy.cronCount("a1")).toBe(4);
    expect(result.capEndpointHandle!.boundedAutonomy.cronCount("other")).toBe(0);
  });

  // PHASE 213-08 (BUDGET-01/02): the late-bound budget holder is POPULATED by the
  // cap layer after construction (the seam the bridge reads — schedulers/agents are
  // built BEFORE the cap layer, so they hold the holder and read `current` at fire
  // time). After construction, holder.current is defined and its reserveBudget
  // reaches the constructed per-root meter.
  it("populates the late-bound boundedAutonomyBudget holder with the per-root reserve after construction", async () => {
    const dataDir = tempDataDir();
    const holder: { current?: { reserveBudget: (...a: unknown[]) => { kind: string }; registerRoot: (...a: unknown[]) => void; evictRootIfIdle?: (...a: unknown[]) => void } } = {};
    const deps = {
      ...createDeps({ a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig }, { dataDir }),
      boundedAutonomyHolder: holder,
    };
    const result = await constructCapabilityLayer(deps as Parameters<typeof constructCapabilityLayer>[0]);
    cleanups.push(() => result.capEndpointStop?.());
    // Before this plan the holder is never touched; after, current is the budget port.
    expect(holder.current).toBeDefined();
    const outcome = holder.current!.reserveBudget("root-x", "_web", "_web", 0, 0);
    expect(outcome.kind).toBeDefined();
    // KEYING-01 (built-but-not-wired guard): the holder.current literal MUST also
    // expose evictRootIfIdle — the bridge calls it once per turn to re-anchor a
    // session root's wall-clock. Omitting it (the literal only bound reserve +
    // register) silently no-ops the per-turn re-anchor LIVE while the bridge unit
    // test still passes on its mock. It must delegate to the composite (no throw).
    expect(typeof holder.current!.evictRootIfIdle).toBe("function");
    expect(() => holder.current!.evictRootIfIdle!("root-x")).not.toThrow();
  });

  // The resolver returns a STABLE rootRunId per session: an unregistered (top-level,
  // non-spawned) session gets a SYNTHETIC `root-session-<key>` id, registered on
  // first use so a self-spawning loop on ANY run is bounded (criterion #2 — not only
  // orchestrate children). The same session resolves to the SAME id on a second call.
  it("resolveRootRunId returns a stable synthetic root for an unregistered session and registers it on first use", async () => {
    const dataDir = tempDataDir();
    const holder: { current?: { reserveBudget: (...a: unknown[]) => unknown; registerRoot: (...a: unknown[]) => void } } = {};
    const deps = {
      ...createDeps({ a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig }, { dataDir }),
      boundedAutonomyHolder: holder,
    };
    const result = await constructCapabilityLayer(deps as Parameters<typeof constructCapabilityLayer>[0]);
    cleanups.push(() => result.capEndpointStop?.());
    const resolveRootRunId = result.resolveRootRunId;
    expect(resolveRootRunId).toBeDefined();
    const sk = { tenantId: "t1", channelId: "c1", userId: "u1" };
    const id1 = resolveRootRunId!(sk);
    const id2 = resolveRootRunId!(sk);
    expect(id1).toContain("root-session-");
    expect(id2).toBe(id1); // stable across calls
  });

  // The cap socket path lives under the supplied data dir.
  it("places the cap socket under the data dir", async () => {
    const dataDir = tempDataDir();
    const deps = createDeps(
      { a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig },
      { dataDir },
    );
    const result = await constructCapabilityLayer(deps);
    cleanups.push(() => result.capEndpointStop?.());
    expect(result.capEndpointHandle!.capSocketPath).toBe(join(dataDir, "cap.sock"));
  });

  // PHASE 212 ACTIVATION (Gap 3): the daemon-wide socket is STARTED (the file
  // exists on disk) and the boot log reports active:true — no active:false residue.
  it("ACTIVATES the cap socket (the 0600 socket file is bound) and logs active:true", async () => {
    const dataDir = tempDataDir();
    const deps = createDeps(
      { a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig },
      { dataDir },
    );
    const result = await constructCapabilityLayer(deps);
    cleanups.push(() => result.capEndpointStop?.());
    // The unix socket file is bound on disk (startSocket was called).
    expect(existsSync(join(dataDir, "cap.sock"))).toBe(true);
    // The boot INFO carries active:true (the dormant active:false is gone).
    const infoMock = deps.daemonLogger.info as unknown as ReturnType<typeof vi.fn>;
    const [fields] = infoMock.mock.calls[0]!;
    expect(fields).toMatchObject({ active: true });
  });

  // stopSocket tears down the bound socket (the file is unlinked) — the teardown
  // the composition root wires into setupShutdown.
  it("stopSocket unlinks the bound cap socket on teardown", async () => {
    const dataDir = tempDataDir();
    const deps = createDeps(
      { a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig },
      { dataDir },
    );
    const result = await constructCapabilityLayer(deps);
    expect(existsSync(join(dataDir, "cap.sock"))).toBe(true);
    await result.capEndpointStop!();
    expect(existsSync(join(dataDir, "cap.sock"))).toBe(false);
  });

  // HONEST DEGRADE: a cap-socket activation failure (here an unusable empty dataDir
  // that safePath rejects) must NOT crash the daemon boot — the layer returns no
  // handle + logs a WARN (errorKind:"config"), the daemon continues. Production
  // dataDir is always absolute (~/.comis); this guards the boot against a malformed
  // data dir taking the whole daemon down. (Regression: the dormancy activation
  // previously let the PathTraversalError propagate out of main().)
  it("DEGRADES with a WARN (no cap handle) when cap-socket activation fails, never crashing boot", async () => {
    // A data dir whose parent does not exist → startSocket's bind fails (ENOENT).
    // The layer must catch it and degrade, not let it propagate out of boot.
    const deps = createDeps(
      { a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig },
      { dataDir: "/nonexistent-comis-cap-degrade-zzz/sub" },
    );
    const result = await constructCapabilityLayer(deps);
    expect(result.capEndpointHandle).toBeUndefined();
    expect(result.capEndpointStop).toBeUndefined();
    // The host preflight still ran (it is a host check, independent of the socket).
    expect(typeof result.namespacePreflightOk).toBe("boolean");
    const warnMock = deps.daemonLogger.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config", submodule: "capability-endpoint" }),
      expect.stringContaining("DEGRADED"),
    );
  });
});
