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
// A REAL LeaseManager (ground truth) for the revoke-reaches-child proof — the
// child-lease attribution is the security keystone, never a green mock.
import { createLeaseManager, type LeaseManager } from "@comis/infra";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

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
    trustLevel: "user",
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

  it("binds the exact requester origin to both assembly and per-run child leases", () => {
    const requesterOrigin = Object.freeze({
      channelType: "telegram",
      channelId: "chat-1",
      userId: "user-1",
      tenantId: "tenant-1",
      threadId: "topic-1",
    });
    const input = baseInput({
      trustLevel: "admin",
      sessionKey: {
        tenantId: "tenant-1",
        userId: "user-1",
        channelId: "chat-1",
        threadId: "topic-1",
      },
      requesterOrigin,
    });
    buildAutonomyToolWiring(input);
    const handle = input.capEndpointHandle!;
    const mint = (handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease;
    expect(mint.mock.calls[0]![0]).toMatchObject({
      sessionKey: "tenant-1:user-1:chat-1:thread:topic-1",
      trustLevel: "admin",
      deliveryOrigin: requesterOrigin,
    });

    const args = mockCreateOrchestrateTool.mock.calls[0]![0] as {
      mintRunLease?: (runId: string, timeoutMs: number) => { leaseId: string; bearer: string };
    };
    args.mintRunLease!("run-child", 30_000);
    expect(mint.mock.calls[1]![0]).toMatchObject({
      sessionKey: "tenant-1:user-1:chat-1:thread:topic-1",
      trustLevel: "admin",
      deliveryOrigin: requesterOrigin,
    });
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

  it("attenuates a child assembly against the authenticated parent capabilities and lease", () => {
    const input = baseInput({
      parentAuthority: {
        rootRunId: "root-parent",
        leaseId: "lease-parent",
        caps: ["orch:read"],
      },
    } as Partial<AutonomyToolInputs>);
    const result = buildAutonomyToolWiring(input);
    const mint = (input.capEndpointHandle!.leaseManager as never as {
      mintLease: ReturnType<typeof vi.fn>;
    }).mintLease;

    expect(mint.mock.calls[0]![0]).toEqual(expect.objectContaining({
      rootRunId: "root-parent",
      parentLeaseId: "lease-parent",
      caps: ["orch:read"],
    }));
    expect(result.assemblyAuthority).toEqual({
      rootRunId: "root-parent",
      leaseId: "leaseid-1",
      caps: ["orch:read"],
    });
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

  // -------------------------------------------------------------------------
  // Static pre-flight wiring: the daemon threads the agent's HELD cap set
  // (resolved.capabilities) as allowedCaps for the pre-spawn cap fail-fast, and
  // the (approvals.enabled-gated) approvalGate seam — both into
  // createOrchestrateTool, mirroring the shipped eventBus/mintRunLease threads.
  // -------------------------------------------------------------------------
  describe("pre-flight wiring (allowedCaps + approvalGate)", () => {
    it("threads allowedCaps = resolved.capabilities (the held-cap set) into createOrchestrateTool", () => {
      const input = baseInput();
      buildAutonomyToolWiring(input);
      const handle = input.capEndpointHandle!;
      const mint = (handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease;
      // Ground truth: the SAME resolved.capabilities the assembly lease is minted
      // with — the advisory pre-flight cap set must not drift from the endpoint's.
      const mintedCaps = (mint.mock.calls[0]![0] as { caps: unknown }).caps;
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as { allowedCaps?: readonly string[] };
      expect(args.allowedCaps).toBeDefined();
      expect(args.allowedCaps).toEqual(mintedCaps);
      // A standard agent holds orch:web — the cap the pre-flight fail-fast keys on.
      expect(args.allowedCaps).toContain("orch:web");
    });

    it("threads the approvalGate seam into createOrchestrateTool when one is wired (approvals.enabled)", () => {
      const approvalGate = { requestApproval: vi.fn() } as never as NonNullable<
        AutonomyToolInputs["approvalGate"]
      >;
      buildAutonomyToolWiring(baseInput({ approvalGate }));
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as { approvalGate?: unknown };
      expect(args.approvalGate).toBe(approvalGate);
    });

    it("OMITS the approvalGate key when none is wired (approvals disabled) — the conditional-spread stays off", () => {
      buildAutonomyToolWiring(baseInput());
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as Record<string, unknown>;
      expect("approvalGate" in args).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // One-shot repair wiring: setup-tools resolves the effective capabilityClass +
  // (for a repair-eligible class) a daemon-minted repairSeam and threads BOTH into
  // createOrchestrateTool — conditional-spread like eventBus/approvalGate. The
  // class-gate is pure (off the model profile); there is no config toggle.
  // -------------------------------------------------------------------------
  describe("one-shot repair wiring (capabilityClass + repairSeam)", () => {
    it("threads capabilityClass + the daemon-minted repairSeam into createOrchestrateTool for a small-class agent", () => {
      const repairSeam = vi.fn(async () => "regenerated") as never as NonNullable<
        AutonomyToolInputs["repairSeam"]
      >;
      buildAutonomyToolWiring(baseInput({ capabilityClass: "small", repairSeam }));
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as {
        capabilityClass?: string;
        repairSeam?: unknown;
      };
      expect(args.capabilityClass).toBe("small");
      expect(args.repairSeam).toBe(repairSeam);
    });

    it("threads capabilityClass but OMITS repairSeam for a frontier agent (class-gated OFF → no seam resolved)", () => {
      buildAutonomyToolWiring(baseInput({ capabilityClass: "frontier" }));
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.capabilityClass).toBe("frontier");
      expect("repairSeam" in args).toBe(false);
    });

    it("OMITS both capabilityClass and repairSeam keys when neither is threaded (older wiring)", () => {
      buildAutonomyToolWiring(baseInput());
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as Record<string, unknown>;
      expect("capabilityClass" in args).toBe(false);
      expect("repairSeam" in args).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Resumable-durable seam: the durable-run store is threaded into the
  // orchestrate runner ONLY when the agent's autonomy.durability.orchestrateResume
  // is ON — so a timed-out run records a resumable row + honors resumeRunId + skips
  // cleanupRun. Default-OFF: an agent without the toggle gets NO durable row (the
  // runner stays byte-identical to a non-resumable run). The gate lives HERE
  // (co-located with the tool assembly), reading the same config path as the
  // capability-endpoint's orchestrateResumeEnabled surface predicate — so the
  // store the composition root always threads is forwarded to the runner only
  // under the resume surface.
  // -------------------------------------------------------------------------
  describe("resumable-durable seam (durableRuns under orchestrateResume)", () => {
    const fakeDurableRuns = {
      upsertCheckpoint: vi.fn(),
      getByRootRun: vi.fn(),
    } as never as NonNullable<AutonomyToolInputs["durableRuns"]>;

    it("threads durableRuns into createOrchestrateTool when autonomy.durability.orchestrateResume is ON", () => {
      const input = baseInput({
        agentConfig: {
          autonomy: { profile: "standard", durability: { orchestrateResume: true } },
        } as never,
        durableRuns: fakeDurableRuns,
      });
      buildAutonomyToolWiring(input);
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as { durableRuns?: unknown };
      expect(args.durableRuns).toBe(fakeDurableRuns);
    });

    it("OMITS durableRuns when orchestrateResume is OFF, even when the store is supplied (default-off byte-identity)", () => {
      const input = baseInput({
        agentConfig: { autonomy: { profile: "standard" } } as never, // no durability block
        durableRuns: fakeDurableRuns,
      });
      buildAutonomyToolWiring(input);
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as Record<string, unknown>;
      expect("durableRuns" in args).toBe(false);
    });

    it("OMITS durableRuns when orchestrateResume is explicitly false", () => {
      const input = baseInput({
        agentConfig: {
          autonomy: { profile: "standard", durability: { orchestrateResume: false } },
        } as never,
        durableRuns: fakeDurableRuns,
      });
      buildAutonomyToolWiring(input);
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as Record<string, unknown>;
      expect("durableRuns" in args).toBe(false);
    });
  });

  it("does NOT mint a lease for a non-autonomy (assistant) agent", () => {
    const input = baseInput({ agentConfig: { autonomy: { profile: "assistant" } } as never });
    const { brokerSpawnEnv, orchestrateTool } = buildAutonomyToolWiring(input);
    const handle = input.capEndpointHandle!;
    expect((handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease).not.toHaveBeenCalled();
    expect(brokerSpawnEnv).toBeUndefined();
    expect(orchestrateTool).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Per-run child lease seam — the correlation keystone.
  // buildAutonomyToolWiring threads a mintRunLease(runId, timeoutMs) closure into
  // createOrchestrateTool. The closure mints a short-TTL CHILD lease per run:
  // same caps, SAME rootRunId (tree accounting untouched — registerRoot is NOT
  // called for the child), parentLeaseId = the assembly leaseId, TTL clamped to
  // the run timeout; it registers the child bearer in OutputGuard at mint.
  // revokeByRootRun still reaches the child (it scans by the inherited rootRunId),
  // so tree-wide kill remains effective.
  // -------------------------------------------------------------------------
  describe("per-run child lease seam (mintRunLease, D5)", () => {
    it("threads a mintRunLease closure into createOrchestrateTool", () => {
      buildAutonomyToolWiring(baseInput());
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as { mintRunLease?: unknown };
      expect(typeof args.mintRunLease).toBe("function");
    });

    it("mints a registered child lease under the assembly root without registering a second root", () => {
      const input = baseInput({ callerRootRunId: "root-stable-1" });
      buildAutonomyToolWiring(input);
      const handle = input.capEndpointHandle!;
      const mint = (handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease;
      const reg = (handle.boundedAutonomy as never as { registerRoot: ReturnType<typeof vi.fn> }).registerRoot;
      const registerSecret = (handle.outputGuard as never as { registerSecret: ReturnType<typeof vi.fn> }).registerSecret;

      // The assembly lease was minted ONCE (buildBrokerSpawnEnv) and its root
      // anchored ONCE — the seam is a closure, not invoked at wiring time.
      expect(mint).toHaveBeenCalledTimes(1);
      expect(reg).toHaveBeenCalledTimes(1);

      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as {
        mintRunLease?: (runId: string, timeoutMs: number) => { leaseId: string; bearer: string };
      };
      expect(typeof args.mintRunLease).toBe("function");
      const child = args.mintRunLease!("orch-abc", 42_000);

      // A SECOND mintLease — the per-run child — with the D5 shape.
      expect(mint).toHaveBeenCalledTimes(2);
      const assemblyInput = mint.mock.calls[0]![0] as { caps: unknown };
      const childInput = mint.mock.calls[1]![0] as {
        parentLeaseId?: string;
        rootRunId?: string;
        ttlMs?: number;
        maxTtlMs?: number;
        caps: unknown;
      };
      expect(childInput.parentLeaseId).toBe("leaseid-1"); // = the assembly leaseId (BrokerSpawnEnv.leaseId)
      expect(childInput.rootRunId).toBe("root-stable-1"); // same as the assembly
      expect(childInput.ttlMs).toBe(42_000); // TTL clamped to the run timeout...
      expect(childInput.maxTtlMs).toBe(42_000); // ...hard ceiling === soft TTL === timeoutMs
      expect(childInput.caps).toEqual(assemblyInput.caps); // resolved.capabilities (never broadened)

      // The child bearer is registered in OutputGuard at mint (Pitfall 1) —
      // assembly (1) + child (1) = 2 registrations. The seam returns {leaseId,bearer}.
      expect(registerSecret).toHaveBeenCalledTimes(2);
      expect(registerSecret).toHaveBeenCalledWith(child.bearer);

      // D5: registerRoot is NOT called for the child — the per-root
      // budget/semaphore/kill accounting stays keyed on the single registered
      // assembly lease; the child rides the same rootRunId.
      expect(reg).toHaveBeenCalledTimes(1);
    });

    it("re-mints a resumed run with its persisted root, trust, identity, and attenuated capabilities", () => {
      const input = baseInput({
        trustLevel: "admin",
        callerRootRunId: "root-current",
        sessionKey: { tenantId: "tenant-current", userId: "user-current", channelId: "chat-current" },
        requesterOrigin: {
          channelType: "telegram",
          channelId: "chat-current",
          userId: "user-current",
          tenantId: "tenant-current",
        },
      });
      buildAutonomyToolWiring(input);
      const handle = input.capEndpointHandle!;
      const mint = (handle.leaseManager as never as { mintLease: ReturnType<typeof vi.fn> }).mintLease;
      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as {
        mintRunLease?: (
          runId: string,
          timeoutMs: number,
          authority?: {
            agentId: string;
            sessionKey: string;
            trustLevel: "user";
            caps: readonly ["orch:read"];
            rootRunId: string;
            sourceCheckpointId: string;
            ownerTenantId: string;
            ownerUserId: string;
            deliveryOrigin: null;
          },
        ) => { leaseId: string; bearer: string };
      };

      args.mintRunLease!("replacement-checkpoint", 25_000, {
        agentId: "agent-owner",
        sessionKey: "tenant-owner:user-owner:chat-owner",
        ownerTenantId: "tenant-owner",
        ownerUserId: "user-owner",
        deliveryOrigin: null,
        trustLevel: "user",
        caps: ["orch:read"],
        rootRunId: "root-persisted",
        sourceCheckpointId: "source-checkpoint",
      });

      expect(mint.mock.calls[1]![0]).toEqual(expect.objectContaining({
        agentId: "agent-owner",
        sessionKey: "tenant-owner:user-owner:chat-owner",
        trustLevel: "user",
        caps: ["orch:read"],
        rootRunId: "root-persisted",
        checkpointId: "replacement-checkpoint",
        ttlMs: 25_000,
        maxTtlMs: 25_000,
      }));
      expect(mint.mock.calls[1]![0]).not.toHaveProperty("parentLeaseId");
      expect(mint.mock.calls[1]![0]).not.toHaveProperty("deliveryOrigin");
    });

    it("revokeByRootRun reaches every child lease even when child root registration is skipped", () => {
      // A REAL LeaseManager (ground truth — not the fixed mock): the assembly
      // lease + each per-run child share the rootRunId, so revokeByRootRun (which
      // scans by rootRunId) reaches the children even though registerRoot was
      // skipped for them. This proves tree-wide kill end-to-end.
      const realLease = createLeaseManager({ clock: createFakeClock(1_700_000_000_000) });
      const handle = makeHandle();
      (handle as unknown as { leaseManager: LeaseManager }).leaseManager = realLease;
      const input = baseInput({ capEndpointHandle: handle, callerRootRunId: "root-kill-1" });
      buildAutonomyToolWiring(input);

      const args = mockCreateOrchestrateTool.mock.calls[0]![0] as {
        mintRunLease?: (runId: string, timeoutMs: number) => { leaseId: string; bearer: string };
      };
      expect(typeof args.mintRunLease).toBe("function");
      // Two per-run child leases off the SAME assembly (same rootRunId).
      const c1 = args.mintRunLease!("orch-1", 60_000);
      const c2 = args.mintRunLease!("orch-2", 60_000);
      // Two sequential runs → DISJOINT child leaseIds (a fresh id per run).
      expect(c1.leaseId).not.toBe(c2.leaseId);

      // revokeByRootRun scans by the inherited rootRunId → assembly + BOTH children.
      const { revoked } = realLease.revokeByRootRun("root-kill-1");
      expect(revoked).toBe(3);
    });
  });
});
