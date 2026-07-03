// SPDX-License-Identifier: Apache-2.0
/**
 * `wake-gate-runner` — the exception-safe, fail-open pre-payload gate runner.
 *
 * Asserts `createWakeGateRunner`:
 *   - EXCEPTION-SAFETY: every jailed-run rejection (SIGKILL-timeout / stdout
 *     overflow / non-zero exit / spawn error) maps to fail-open `{ wake: true }`
 *     and NEVER throws to the scheduler; a clean run resolves via the pure parser.
 *   - BEARER-THREADING: a fire mints a fresh per-fire lease, registers the bearer
 *     with OutputGuard, and threads `COMIS_CAP_LEASE` + `COMIS_ORCH_SOCKET` into
 *     the jail env under a fresh `root-wakegate-<jobId>-<ts>` root.
 *   - LEASE CAPS = the agent's resolved autonomy caps (never a job tool policy).
 *   - HONEST DEGRADE: no sandbox (preflight failed) or autonomy disabled yields a
 *     run-as-today signal — no lease minted, no jailed run.
 * @module
 */
import { describe, it, expect, vi } from "vitest";

// The jailed-run core + the store factory are injected over per test (the runner
// takes both as seams), so the real module is mocked to keep the unit suite off a
// real bwrap jail on macOS.
vi.mock("@comis/skills/tools", () => ({
  runJailedScript: vi.fn(),
  createResultRefStore: vi.fn(() => ({
    materialize: vi.fn(),
    gcRun: vi.fn(),
    cleanupRun: vi.fn(),
  })),
}));

import {
  createWakeGateRunner,
  type WakeGateRunnerDeps,
  type WakeGateRunContext,
} from "./wake-gate-runner.js";

function makeLogger(): WakeGateRunnerDeps["logger"] {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { child: vi.fn(() => child), ...child } as unknown as WakeGateRunnerDeps["logger"];
}

const GATE = { script: "noop", language: "js" as const, timeoutSeconds: 30 };
const CTX: WakeGateRunContext = { agentId: "agent-1", jobId: "job-1", sessionKey: "main:agent-1" };

/**
 * Hand-built fakes (AGENTS §2.5): a mint returning a neutral placeholder bearer,
 * spies for registerSecret + registerRoot, a fake sandbox, a workspace resolver,
 * and an agents map whose autonomy resolves ENABLED with caps
 * `["orch:read","orch:web"]` (base `orch:read` + the `web` surface toggle).
 */
function makeDeps(over: Partial<WakeGateRunnerDeps> = {}) {
  const mintLease = vi.fn(() => ({ leaseId: "lease-x", bearer: "bearer-x" }));
  const registerSecret = vi.fn();
  const registerRoot = vi.fn();
  const resolveWorkspace = vi.fn((id: string) => `/ws/${id}`);
  // Default: a clean run that emits an explicit skip verdict.
  const runJailedScriptFn = vi.fn(async () => '{"wake":false}');

  const deps: WakeGateRunnerDeps = {
    logger: makeLogger(),
    leaseManager: {
      mintLease,
      validate: vi.fn(),
      renew: vi.fn(),
      revoke: vi.fn(),
      cascadeRevoke: vi.fn(),
      revokeByRootRun: vi.fn(),
    } as unknown as WakeGateRunnerDeps["leaseManager"],
    outputGuard: { scan: vi.fn(), registerSecret } as unknown as WakeGateRunnerDeps["outputGuard"],
    capSocketPath: "/data/cap.sock",
    registerRoot,
    sandbox: {
      name: "mock",
      available: () => true,
      buildArgs: () => [],
      wrapEnv: (e: unknown) => e,
    } as unknown as WakeGateRunnerDeps["sandbox"],
    resolveWorkspace,
    // base `orch:read` + `web` toggle → resolved caps ["orch:read","orch:web"], enabled.
    agents: {
      "agent-1": { autonomy: { profile: "standard", capabilities: ["orch:read"], web: true } },
    } as unknown as WakeGateRunnerDeps["agents"],
    // A credential-named var proves the runner hands the RAW base env to the core
    // (the core owns the scrub); nothing here asserts on it beyond identity.
    baseEnv: { PATH: "/usr/bin", SECRET_TOKEN: "unused" },
    namespacePreflightOk: true,
    now: () => 1_700_000_000_000,
    runJailedScriptFn,
    store: {
      materialize: vi.fn(),
      gcRun: vi.fn(),
      cleanupRun: vi.fn(),
    } as unknown as WakeGateRunnerDeps["store"],
    ...over,
  };
  return { deps, mintLease, registerSecret, registerRoot, resolveWorkspace, runJailedScriptFn };
}

describe("createWakeGateRunner — exception-safety (fail-open, never throws)", () => {
  const rejections: ReadonlyArray<readonly [string, Error]> = [
    ["a SIGKILL timeout", new Error("run exceeded its 30000ms timeout")],
    ["a stdout overflow", new Error("stdout exceeded the 4194304B hard cap")],
    ["a non-zero exit", new Error("jailed child exited with code 1")],
    ["a spawn error", new Error("spawn bwrap ENOENT")],
  ];

  for (const [label, err] of rejections) {
    it(`resolves to wake (fail-open) and NEVER throws when the jailed run rejects with ${label}`, async () => {
      const { deps, runJailedScriptFn } = makeDeps();
      runJailedScriptFn.mockRejectedValue(err);
      const runner = createWakeGateRunner(deps);
      // `.resolves` proves the promise did not reject — the never-throw invariant.
      await expect(runner.runWakeGate(GATE, CTX)).resolves.toEqual({ wake: true });
    });
  }

  it("still mints + registers the bearer even on a rejecting run (the lease is set up before the run)", async () => {
    const { deps, runJailedScriptFn, mintLease, registerSecret } = makeDeps();
    runJailedScriptFn.mockRejectedValue(new Error("run exceeded its 30000ms timeout"));
    await createWakeGateRunner(deps).runWakeGate(GATE, CTX);
    expect(mintLease).toHaveBeenCalledTimes(1);
    expect(registerSecret).toHaveBeenCalledWith("bearer-x");
  });

  it("resolves to wake (fail-open) and NEVER throws when the lease MINT itself throws", async () => {
    // A mint fault (LeaseManager/OutputGuard invariant, entropy failure, a future
    // registerRoot ceiling) must fail OPEN like every other cause. If it escaped,
    // the scheduler would record status:error → backoff → auto-suspend: the exact
    // silent-drop the gate exists to prevent. `.resolves` proves it never rejects.
    const { deps, mintLease } = makeDeps();
    mintLease.mockImplementation(() => {
      throw new Error("lease mint boom");
    });
    const runner = createWakeGateRunner(deps);
    await expect(runner.runWakeGate(GATE, CTX)).resolves.toEqual({ wake: true });
  });
});

describe("createWakeGateRunner — clean-run verdict resolution", () => {
  it("resolves an explicit {wake:false} to skip", async () => {
    const { deps, runJailedScriptFn } = makeDeps();
    runJailedScriptFn.mockResolvedValue('{"wake":false}');
    await expect(createWakeGateRunner(deps).runWakeGate(GATE, CTX)).resolves.toEqual({ wake: false });
  });

  it("resolves {wake:true,context} preserving the context", async () => {
    const { deps, runJailedScriptFn } = makeDeps();
    runJailedScriptFn.mockResolvedValue('{"wake":true,"context":"x"}');
    await expect(createWakeGateRunner(deps).runWakeGate(GATE, CTX)).resolves.toEqual({
      wake: true,
      context: "x",
    });
  });

  it("fails open (wake:true) on empty stdout — an empty gate is never resolved to silent", async () => {
    const { deps, runJailedScriptFn } = makeDeps();
    runJailedScriptFn.mockResolvedValue("");
    await expect(createWakeGateRunner(deps).runWakeGate(GATE, CTX)).resolves.toEqual({ wake: true });
  });
});

describe("createWakeGateRunner — bearer-threading (full mint treatment)", () => {
  it("mints one fresh per-fire lease, registers the bearer, and threads COMIS_CAP_LEASE + COMIS_ORCH_SOCKET", async () => {
    const { deps, runJailedScriptFn, mintLease, registerSecret } = makeDeps();
    await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(mintLease).toHaveBeenCalledTimes(1);
    expect(registerSecret).toHaveBeenCalledWith("bearer-x");

    const runnerDeps = runJailedScriptFn.mock.calls[0]![0] as {
      brokerSpawnEnv?: { placeholders?: Record<string, string> };
    };
    expect(runnerDeps.brokerSpawnEnv?.placeholders?.COMIS_CAP_LEASE).toBe("bearer-x");
    expect(runnerDeps.brokerSpawnEnv?.placeholders?.COMIS_ORCH_SOCKET).toBe("/data/cap.sock");
  });

  it("anchors a fresh root-wakegate-<jobId>-<ts> root with the minted leaseId", async () => {
    const { deps, mintLease, registerRoot } = makeDeps();
    await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(registerRoot).toHaveBeenCalledTimes(1);
    const [rootRunId, leaseId] = registerRoot.mock.calls[0]!;
    expect(rootRunId).toMatch(/^root-wakegate-job-1-/);
    expect(leaseId).toBe("lease-x");

    // The lease is minted under the SAME per-fire root + the job's session key.
    const mintInput = mintLease.mock.calls[0]![0] as { rootRunId: string; sessionKey: string };
    expect(mintInput.rootRunId).toMatch(/^root-wakegate-job-1-/);
    expect(mintInput.sessionKey).toBe("main:agent-1");
  });

  it("mints with the agent's resolveAutonomy caps — NOT a job tool policy", async () => {
    const { deps, mintLease } = makeDeps();
    await createWakeGateRunner(deps).runWakeGate(GATE, CTX);
    const mintInput = mintLease.mock.calls[0]![0] as { caps: readonly string[] };
    expect(mintInput.caps).toEqual(["orch:read", "orch:web"]);
  });
});

describe("createWakeGateRunner — per-fire jailed-run deps assembly", () => {
  it("hands the jailed core the cap socket, the sandbox, the agent workspace, the base env, and the gate params", async () => {
    const { deps, runJailedScriptFn, resolveWorkspace } = makeDeps();
    await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    const runnerDeps = runJailedScriptFn.mock.calls[0]![0] as {
      capSocketPath: string;
      sandbox: unknown;
      workspaceResolver: () => string;
      baseEnv: Record<string, string | undefined>;
    };
    expect(runnerDeps.capSocketPath).toBe("/data/cap.sock");
    expect(runnerDeps.sandbox).toBe(deps.sandbox);
    expect(runnerDeps.workspaceResolver()).toBe("/ws/agent-1");
    expect(resolveWorkspace).toHaveBeenCalledWith("agent-1");
    expect(runnerDeps.baseEnv).toBe(deps.baseEnv);

    const params = runJailedScriptFn.mock.calls[0]![1] as {
      script: string;
      language: string;
      timeoutMs?: number;
    };
    expect(params).toMatchObject({ script: "noop", language: "js", timeoutMs: 30_000 });
  });
});

describe("createWakeGateRunner — honest degrade (run as today)", () => {
  it("returns runAsToday and mints/runs nothing when the namespace preflight failed", async () => {
    const { deps, mintLease, registerSecret, registerRoot, runJailedScriptFn } = makeDeps({
      namespacePreflightOk: false,
    });
    const result = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);
    expect(result).toEqual({ runAsToday: true });
    expect(mintLease).not.toHaveBeenCalled();
    expect(registerSecret).not.toHaveBeenCalled();
    expect(registerRoot).not.toHaveBeenCalled();
    expect(runJailedScriptFn).not.toHaveBeenCalled();
  });

  it("returns runAsToday when the agent's autonomy resolves disabled (assistant)", async () => {
    const { deps, mintLease, runJailedScriptFn } = makeDeps({
      agents: {
        "agent-1": { autonomy: { profile: "assistant" } },
      } as unknown as WakeGateRunnerDeps["agents"],
    });
    const result = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);
    expect(result).toEqual({ runAsToday: true });
    expect(mintLease).not.toHaveBeenCalled();
    expect(runJailedScriptFn).not.toHaveBeenCalled();
  });
});
