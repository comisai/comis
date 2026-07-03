// SPDX-License-Identifier: Apache-2.0
/**
 * `setup-tools-autonomy` — the dormancy-activation tool wiring.
 * Asserts `buildAutonomyToolWiring`: mints the per-spawn lease + registers the
 * bearer in OutputGuard + injects COMIS_CAP_LEASE/COMIS_ORCH_SOCKET for an autonomy
 * agent; assembles the orchestrate tool only with a handle + a sandbox; and
 * yields neither for a non-autonomy agent / no handle / no sandbox (no regression,
 * never an unjailed run).
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateOrchestrateTool, mockCreateResultRefStore } = vi.hoisted(() => ({
  mockCreateOrchestrateTool: vi.fn(() => ({ name: "orchestrate", execute: vi.fn() })),
  mockCreateResultRefStore: vi.fn(() => ({ materialize: vi.fn(), gcRun: vi.fn(), cleanupRun: vi.fn() })),
}));

vi.mock("@comis/skills/tools", () => ({
  createOrchestrateTool: mockCreateOrchestrateTool,
  createResultRefStore: mockCreateResultRefStore,
}));

import { buildAutonomyToolWiring, type AutonomyToolInputs } from "./setup-tools-autonomy.js";

function makeLogger() {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { child: vi.fn(() => child), ...child } as never;
}

function makeHandle(overrides: { mintBearer?: string; mintLeaseId?: string } = {}) {
  return {
    leaseManager: {
      // mintLease returns BOTH bearer and leaseId (the leaseId feeds registerRoot).
      mintLease: vi.fn(() => ({
        bearer: overrides.mintBearer ?? "lease-xyz",
        leaseId: overrides.mintLeaseId ?? "leaseid-1",
      })),
      validate: vi.fn(),
      renew: vi.fn(),
      revoke: vi.fn(),
    },
    endpoint: { handleCapCall: vi.fn(), startSocket: vi.fn(), stopSocket: vi.fn() },
    // The bounded-autonomy service the wiring anchors the tree root in.
    boundedAutonomy: { registerRoot: vi.fn() },
    capSocketPath: "/data/cap.sock",
    outputGuard: { scan: vi.fn(), registerSecret: vi.fn() },
  } as never as NonNullable<AutonomyToolInputs["capEndpointHandle"]>;
}

function baseInput(over: Partial<AutonomyToolInputs> = {}): AutonomyToolInputs {
  return {
    agentConfig: { autonomy: { profile: "standard" } } as never,
    agentId: "agent-1",
    agentWorkspaceDir: "/ws/agent-1",
    capEndpointHandle: makeHandle(),
    brokerContext: undefined,
    sandboxProvider: { name: "mock", available: () => true, buildArgs: () => [], wrapEnv: (e: never) => e } as never,
    sessionKey: undefined,
    logger: makeLogger(),
    baseEnv: { PATH: "/usr/bin" },
    ...over,
  };
}

describe("buildAutonomyToolWiring", () => {
  beforeEach(() => {
    mockCreateOrchestrateTool.mockClear();
    mockCreateResultRefStore.mockClear();
  });

  it("mints the per-spawn lease + registers the bearer + injects the lease env for an autonomy agent", () => {
    const input = baseInput();
    const { brokerSpawnEnv } = buildAutonomyToolWiring(input);
    const handle = input.capEndpointHandle!;
    expect((handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease).toHaveBeenCalledTimes(1);
    expect((handle.outputGuard as never as { registerSecret: ReturnType<typeof vi.fn> }).registerSecret).toHaveBeenCalledWith("lease-xyz");
    expect(brokerSpawnEnv?.placeholders?.COMIS_CAP_LEASE).toBe("lease-xyz");
    expect(brokerSpawnEnv?.placeholders?.COMIS_ORCH_SOCKET).toBe("/data/cap.sock");
  });

  // The mint anchors the tree root in the bounded-
  // autonomy service with the SAME rootRunId the lease is minted with + the
  // freshly-minted leaseId (so the per-root budget wall-clock anchors).
  it("anchors the tree root in boundedAutonomy.registerRoot after the mint (root mints a fresh id)", () => {
    const input = baseInput();
    buildAutonomyToolWiring(input);
    const handle = input.capEndpointHandle!;
    const reg = (handle.boundedAutonomy as never as { registerRoot: ReturnType<typeof vi.fn> }).registerRoot;
    expect(reg).toHaveBeenCalledTimes(1);
    const [rootRunId, leaseId] = reg.mock.calls[0]!;
    // The root (no callerRootRunId) mints a fresh tree-stable id.
    expect(rootRunId).toMatch(/^root-agent-1-/);
    expect(leaseId).toBe("leaseid-1");
  });

  // Tree-stable rootRunId: a sub-agent assembly INHERITS the
  // caller's rootRunId rather than minting a fresh one — so the whole tree shares
  // one id the semaphore/budget/kill key on (a fresh id per sub-agent would
  // silently under-count the tree). The mint + registerRoot use it.
  it("INHERITS the caller's rootRunId (no fresh mint) when callerRootRunId is supplied", () => {
    const input = baseInput({ callerRootRunId: "root-parent-stable" });
    buildAutonomyToolWiring(input);
    const handle = input.capEndpointHandle!;
    const mint = (handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease;
    expect(mint.mock.calls[0]![0]).toMatchObject({ rootRunId: "root-parent-stable" });
    const reg = (handle.boundedAutonomy as never as { registerRoot: ReturnType<typeof vi.fn> }).registerRoot;
    expect(reg).toHaveBeenCalledWith("root-parent-stable", "leaseid-1", undefined);
  });

  it("assembles the orchestrate tool with the cap socket + the minted env for an autonomy agent with a sandbox", () => {
    const { orchestrateTool } = buildAutonomyToolWiring(baseInput());
    expect(orchestrateTool).toBeDefined();
    expect(mockCreateOrchestrateTool).toHaveBeenCalledTimes(1);
    const args = mockCreateOrchestrateTool.mock.calls[0]![0] as { capSocketPath: string; brokerSpawnEnv?: { placeholders?: Record<string, string> } };
    expect(args.capSocketPath).toBe("/data/cap.sock");
    expect(args.brokerSpawnEnv?.placeholders?.COMIS_CAP_LEASE).toBe("lease-xyz");
  });

  it("yields no mint + no orchestrate tool when no cap handle was constructed", () => {
    const { brokerSpawnEnv, orchestrateTool } = buildAutonomyToolWiring(baseInput({ capEndpointHandle: undefined }));
    expect(brokerSpawnEnv).toBeUndefined(); // no broker + no capMint → undefined
    expect(orchestrateTool).toBeUndefined();
    expect(mockCreateOrchestrateTool).not.toHaveBeenCalled();
  });

  it("yields no orchestrate tool when no sandbox provider is available (jail unbuildable)", () => {
    const { orchestrateTool } = buildAutonomyToolWiring(baseInput({ sandboxProvider: undefined }));
    expect(orchestrateTool).toBeUndefined();
    expect(mockCreateOrchestrateTool).not.toHaveBeenCalled();
  });

  // When the host namespace preflight FAILS the jail cannot be built, so an
  // autonomy-bearing agent must genuinely degrade to `assistant` HERE — no orchestrate
  // tool, no lease mint — not merely in the boot WARN. buildAutonomyToolWiring must
  // resolve the DEGRADED posture: were it to resolve the RAW (un-degraded) posture, then
  // on a non-Linux host (or a Linux host without unprivileged userns) `orchestrate` would
  // still be offered and run network-unrestricted under sandbox-exec (`allow network*`),
  // contradicting the boot WARN's "autonomy surfaces are disabled (no silent unjailed fallback)".
  it("yields NO orchestrate tool + NO lease mint when the host namespace preflight FAILED (jail unbuildable), even for a standard agent with a sandbox", () => {
    const input = baseInput({ namespacePreflightOk: false });
    const { brokerSpawnEnv, orchestrateTool } = buildAutonomyToolWiring(input);
    const handle = input.capEndpointHandle!;
    expect((handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease).not.toHaveBeenCalled();
    expect((handle.boundedAutonomy as never as { registerRoot: ReturnType<typeof vi.fn> }).registerRoot).not.toHaveBeenCalled();
    expect(orchestrateTool).toBeUndefined();
    expect(mockCreateOrchestrateTool).not.toHaveBeenCalled();
    expect(brokerSpawnEnv).toBeUndefined();
  });

  // The inverse guard: an explicit `namespacePreflightOk: true` (the Linux happy
  // path) still offers the surface — the degrade is preflight-driven, not a blanket off.
  it("DOES offer the orchestrate tool + mint when the namespace preflight PASSED", () => {
    const { orchestrateTool } = buildAutonomyToolWiring(baseInput({ namespacePreflightOk: true }));
    expect(orchestrateTool).toBeDefined();
    expect(mockCreateOrchestrateTool).toHaveBeenCalledTimes(1);
  });

  it("does NOT mint a lease for a non-autonomy (assistant) agent", () => {
    const input = baseInput({ agentConfig: { autonomy: { profile: "assistant" } } as never });
    const { brokerSpawnEnv, orchestrateTool } = buildAutonomyToolWiring(input);
    const handle = input.capEndpointHandle!;
    expect((handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease).not.toHaveBeenCalled();
    expect(brokerSpawnEnv).toBeUndefined();
    expect(orchestrateTool).toBeUndefined();
  });
});
