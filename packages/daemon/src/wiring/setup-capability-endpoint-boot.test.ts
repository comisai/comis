// SPDX-License-Identifier: Apache-2.0
/**
 * `constructCapabilityLayer` — the daemon-wide capability-layer boot wiring
 * (Phase 211 ENDPOINT-01/03 + JAIL-03). Asserts the autonomy gate (construct
 * ONLY when an agent is autonomy-bearing, mirroring the broker gate) and that
 * the JAIL-03 namespace preflight runs unconditionally and returns its boolean.
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { PerAgentConfig, ClockPort } from "@comis/core";
import { constructCapabilityLayer } from "./setup-capability-endpoint-boot.js";

function createDeps(agents: Record<string, PerAgentConfig>) {
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
    dataDir: "/test/data",
    daemonLogger,
  };
}

describe("constructCapabilityLayer autonomy gate + boot preflight", () => {
  // No agents → not autonomy-bearing → no cap handle (mirrors the broker being
  // absent without executor.broker). The preflight still runs (a host check).
  it("returns no cap handle when no agent is autonomy-bearing, but still runs the preflight", () => {
    const result = constructCapabilityLayer(createDeps({}));
    expect(result.capEndpointHandle).toBeUndefined();
    expect(result.capEndpointStop).toBeUndefined();
    expect(typeof result.namespacePreflightOk).toBe("boolean");
  });

  // An explicitly non-autonomy agent (profile: "assistant" → enabled:false) does
  // NOT trigger construction.
  it("returns no cap handle for an assistant-profile (enabled:false) agent", () => {
    const agents = {
      a1: { autonomy: { profile: "assistant" } } as unknown as PerAgentConfig,
    };
    const result = constructCapabilityLayer(createDeps(agents));
    expect(result.capEndpointHandle).toBeUndefined();
  });

  // An autonomy-bearing agent (profile: "standard" → enabled:true) DOES trigger
  // construction: a LeaseManager + endpoint + a cap.sock path under the data dir,
  // plus a stop thunk. The construction is logged once.
  it("constructs the lease layer for an autonomy-bearing (standard-profile) agent", () => {
    const deps = createDeps({
      a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig,
    });
    const result = constructCapabilityLayer(deps);
    expect(result.capEndpointHandle).toBeDefined();
    expect(result.capEndpointHandle!.leaseManager).toBeDefined();
    expect(result.capEndpointHandle!.endpoint).toBeDefined();
    expect(result.capEndpointHandle!.capSocketPath).toContain("cap.sock");
    expect(typeof result.capEndpointStop).toBe("function");
    expect(deps.daemonLogger.info).toHaveBeenCalledTimes(1);
  });

  // The cap socket path lives under the supplied data dir.
  it("places the cap socket under the data dir", () => {
    const deps = createDeps({
      a1: { autonomy: { profile: "standard" } } as unknown as PerAgentConfig,
    });
    const result = constructCapabilityLayer(deps);
    expect(result.capEndpointHandle!.capSocketPath).toBe("/test/data/cap.sock");
  });
});
