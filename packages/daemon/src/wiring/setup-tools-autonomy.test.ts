// SPDX-License-Identifier: Apache-2.0
/**
 * `setup-tools-autonomy` — the Phase-212 Gap-3 dormancy-activation tool wiring.
 * Asserts `buildAutonomyToolWiring`: mints the per-spawn lease + registers the
 * bearer (Pitfall 1) + injects COMIS_CAP_LEASE/COMIS_ORCH_SOCKET for an autonomy
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

function makeHandle(overrides: { mintBearer?: string } = {}) {
  return {
    leaseManager: {
      mintLease: vi.fn(() => ({ bearer: overrides.mintBearer ?? "lease-xyz" })),
      validate: vi.fn(),
      renew: vi.fn(),
      revoke: vi.fn(),
    },
    endpoint: { handleCapCall: vi.fn(), startSocket: vi.fn(), stopSocket: vi.fn() },
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

  it("does NOT mint a lease for a non-autonomy (assistant) agent", () => {
    const input = baseInput({ agentConfig: { autonomy: { profile: "assistant" } } as never });
    const { brokerSpawnEnv, orchestrateTool } = buildAutonomyToolWiring(input);
    const handle = input.capEndpointHandle!;
    expect((handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease).not.toHaveBeenCalled();
    expect(brokerSpawnEnv).toBeUndefined();
    expect(orchestrateTool).toBeUndefined();
  });
});
