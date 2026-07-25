// SPDX-License-Identifier: Apache-2.0
/**
 * `buildBrokerSpawnEnv` capability-lease mint+inject.
 *
 * Extends the broker-activation spawn-env construction so that, for an
 * autonomy-bearing agent, it ALSO mints an attenuated capability lease, registers
 * the bearer in OutputGuard (so it is never logged — Pitfall 1), and injects
 * `COMIS_CAP_LEASE` (the bearer) + `COMIS_ORCH_SOCKET` (the cap socket path) into
 * the `placeholders` slot (which `buildExecEnv` merges LAST so the
 * daemon-injected vars survive the existing exec/terminal scrub, distinct from
 * the workspace-`.env` source the COMIS_ block fail-closes).
 *
 * The lease vars must be injected for an autonomy-bearing agent EVEN WHEN no
 * broker is configured (the cap socket is independent of the HTTPS-proxy broker),
 * so these tests drive both the broker-present and broker-absent paths.
 *
 * Uses the REAL `createLeaseManager` (@comis/infra) + a fake OutputGuard so the
 * mint/attenuate/register behavior is unit-testable without a daemon.
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { createLeaseManager } from "@comis/infra";
import type { AgentCapability, ClockPort, OutputGuardPort } from "@comis/core";
import {
  buildBrokerSpawnEnv,
  type BrokerContextDeps,
  type CapabilityMintDeps,
} from "./setup-broker-activation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestClock(startMs = 1_700_000_000_000): ClockPort {
  return { now: () => startMs };
}

/** A fake OutputGuard that records every registerSecret call (scan is unused). */
function createFakeOutputGuard(): OutputGuardPort & { registered: string[] } {
  const registered: string[] = [];
  return {
    registered,
    registerSecret(value: string) {
      registered.push(value);
    },
    scan: vi.fn(() => ({ ok: true, value: { sanitized: "", findings: [] } })) as never,
  };
}

function createBrokerContext(): BrokerContextDeps {
  return {
    tcpPort: 9999,
    socketPath: "/tmp/test-broker.sock",
    caPath: "/tmp/broker-ca.pem",
    sessionManager: { issueToken: vi.fn(() => ({ sessionId: "sid", proxyToken: "ptok" })) } as never,
    placeholders: { ANTHROPIC_API_KEY: "comis-broker-placeholder" },
  };
}

/** Build the cap-mint deps over a real LeaseManager + fake OutputGuard. */
function createCapMint(
  overrides: Partial<CapabilityMintDeps> = {},
): { capMint: CapabilityMintDeps; outputGuard: ReturnType<typeof createFakeOutputGuard> } {
  const outputGuard = createFakeOutputGuard();
  const leaseManager = createLeaseManager({ clock: createTestClock() });
  const capMint: CapabilityMintDeps = {
    leaseManager,
    outputGuard,
    capSocketPath: "/test/data/cap.sock",
    resolvedCaps: ["orch:cron", "orch:read"] as AgentCapability[],
    budgetRef: "budget-1",
    sessionKey: "tenant:channel:user",
    trustLevel: "user",
    rootRunId: "run-1",
    ...overrides,
  };
  return { capMint, outputGuard };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildBrokerSpawnEnv capability-lease mint+inject", () => {
  // mint + inject — broker present: the env placeholders carry COMIS_CAP_LEASE
  // (the minted bearer) AND COMIS_ORCH_SOCKET (the cap socket path), alongside
  // the existing broker placeholders.
  it("mints a lease and injects COMIS_CAP_LEASE + COMIS_ORCH_SOCKET (broker present)", () => {
    const { capMint, outputGuard } = createCapMint();
    const env = buildBrokerSpawnEnv(createBrokerContext(), "agent-1", capMint);

    expect(env).toBeDefined();
    const placeholders = env!.placeholders;
    // The lease bearer is present and non-empty.
    expect(typeof placeholders.COMIS_CAP_LEASE).toBe("string");
    expect(placeholders.COMIS_CAP_LEASE.length).toBeGreaterThan(0);
    expect(placeholders.COMIS_ORCH_SOCKET).toBe("/test/data/cap.sock");
    // The broker placeholders + token survive.
    expect(placeholders.COMIS_BROKER_TOKEN).toBe("ptok");
    expect(placeholders.ANTHROPIC_API_KEY).toBe("comis-broker-placeholder");
    // The minted bearer is exactly the registered secret.
    expect(outputGuard.registered).toContain(placeholders.COMIS_CAP_LEASE);
  });

  // mint + inject — broker ABSENT: the cap socket is independent of the broker,
  // so an autonomy-bearing agent still gets COMIS_CAP_LEASE + COMIS_ORCH_SOCKET
  // even with brokerContext undefined.
  it("injects COMIS_CAP_LEASE + COMIS_ORCH_SOCKET when no broker is configured but autonomy is on", () => {
    const { capMint } = createCapMint();
    const env = buildBrokerSpawnEnv(undefined, "agent-1", capMint);

    expect(env).toBeDefined();
    const placeholders = env!.placeholders;
    expect(typeof placeholders.COMIS_CAP_LEASE).toBe("string");
    expect(placeholders.COMIS_CAP_LEASE.length).toBeGreaterThan(0);
    expect(placeholders.COMIS_ORCH_SOCKET).toBe("/test/data/cap.sock");
    // No broker → no broker proxy vars / token.
    expect(placeholders.COMIS_BROKER_TOKEN).toBeUndefined();
    expect(env!.HTTPS_PROXY).toBeUndefined();
  });

  // register: the OutputGuard.registerSecret was called with the minted bearer
  // (Pitfall 1 — the bearer is registered at mint so it is never logged).
  it("registers the minted bearer in OutputGuard at mint", () => {
    const { capMint, outputGuard } = createCapMint();
    const env = buildBrokerSpawnEnv(undefined, "agent-1", capMint);

    expect(outputGuard.registered).toHaveLength(1);
    expect(outputGuard.registered[0]).toBe(env!.placeholders.COMIS_CAP_LEASE);
  });

  // attenuation: when a parentCaps + requestedCaps are supplied (child spawn),
  // the minted lease's caps === attenuateCaps(parent, requested) — the child
  // cannot broaden beyond the parent.
  it("attenuates child caps to parent ∩ requested (never broadens)", () => {
    const outputGuard = createFakeOutputGuard();
    const leaseManager = createLeaseManager({ clock: createTestClock() });
    // Spy on mintLease so we can read the caps it was minted with.
    const mintSpy = vi.spyOn(leaseManager, "mintLease");

    const capMint: CapabilityMintDeps = {
      leaseManager,
      outputGuard,
      capSocketPath: "/test/data/cap.sock",
      resolvedCaps: ["orch:cron", "orch:read"] as AgentCapability[],
      // The PARENT holds {orch:cron, orch:read}; the child REQUESTS
      // {orch:read, orch:graph} → intersection is {orch:read} (graph dropped).
      parentCaps: ["orch:cron", "orch:read"] as AgentCapability[],
      requestedCaps: ["orch:read", "orch:graph"] as AgentCapability[],
      budgetRef: "b",
      sessionKey: "t:c:u",
      trustLevel: "user",
      rootRunId: "run-1",
    };

    buildBrokerSpawnEnv(undefined, "agent-child", capMint);

    expect(mintSpy).toHaveBeenCalledTimes(1);
    const minted = mintSpy.mock.calls[0][0];
    expect(minted.caps).toEqual(["orch:read"]); // graph dropped — never broadened
  });

  // non-autonomy: an agent with no cap-mint deps (no autonomy-bearing profile)
  // gets NO COMIS_CAP_LEASE / COMIS_ORCH_SOCKET (no lease minted).
  it("injects no lease vars when capMint is absent (non-autonomy agent)", () => {
    const env = buildBrokerSpawnEnv(createBrokerContext(), "agent-plain");
    expect(env).toBeDefined();
    expect(env!.placeholders.COMIS_CAP_LEASE).toBeUndefined();
    expect(env!.placeholders.COMIS_ORCH_SOCKET).toBeUndefined();
    // The broker token still rides (broker present).
    expect(env!.placeholders.COMIS_BROKER_TOKEN).toBe("ptok");
  });

  // no-op: no broker AND no capMint → undefined (the original no-regression path).
  it("returns undefined when neither broker nor capMint is present (no-regression)", () => {
    const env = buildBrokerSpawnEnv(undefined, "agent-plain");
    expect(env).toBeUndefined();
  });

  // source-distinct: the injected COMIS_CAP_LEASE rides the
  // placeholders slot (merged LAST in buildExecEnv) — distinct from any
  // workspace-.env source. Assert it is IN placeholders specifically.
  it("places COMIS_CAP_LEASE in the placeholders slot (daemon source, merged last)", () => {
    const { capMint } = createCapMint();
    const env = buildBrokerSpawnEnv(undefined, "agent-1", capMint);
    expect(env).toBeDefined();
    // The var lives under .placeholders, not as a top-level env key.
    expect(env!.placeholders).toHaveProperty("COMIS_CAP_LEASE");
    expect((env as unknown as Record<string, unknown>).COMIS_CAP_LEASE).toBeUndefined();
  });
});
