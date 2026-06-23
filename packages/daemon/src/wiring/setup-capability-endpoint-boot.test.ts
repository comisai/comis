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
import type { PerAgentConfig, ClockPort } from "@comis/core";
import { constructCapabilityLayer } from "./setup-capability-endpoint-boot.js";

/** Track temp data dirs + stop thunks so each socket-binding test tears down. */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function createDeps(
  agents: Record<string, PerAgentConfig>,
  opts: { dataDir?: string } = {},
) {
  const clock: ClockPort = { now: () => 1_700_000_000_000 };
  // The boot helper threads daemonLogger into createCapabilityEndpoint, which
  // binds a `submodule` child for the socket boundary (WR-02) — so the mock must
  // carry a `child` that returns a logger with the level methods.
  const childLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemonLogger = {
    info: vi.fn(),
    child: vi.fn(() => childLogger),
  } as unknown as Parameters<typeof constructCapabilityLayer>[0]["daemonLogger"];
  return {
    agents,
    rpcCall: vi.fn(async () => ({})),
    clock,
    dataDir: opts.dataDir ?? "/test/data",
    daemonLogger,
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
});
