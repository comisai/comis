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

import { ok } from "@comis/shared";
import { TypedEventBus, type EventMap } from "@comis/core";

import {
  createWakeGateRunner,
  type WakeGateRunnerDeps,
  type WakeGateRunContext,
} from "./wake-gate-runner.js";

/** A content-free capability:audited event for the scoped tool-call counter tests. */
function makeAudit(rootRunId: string, decision: "allow" | "deny"): EventMap["capability:audited"] {
  return { timestamp: 0, agentId: "agent-1", capability: "orch:read", method: "tool.invoke", decision, rootRunId };
}

function makeLogger(): WakeGateRunnerDeps["logger"] {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { child: vi.fn(() => child), ...child } as unknown as WakeGateRunnerDeps["logger"];
}

/** A logger whose child `warn` spy is returned so a test can read its fields. */
function makeCapturingLogger(): { logger: WakeGateRunnerDeps["logger"]; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const child = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  const logger = { child: vi.fn(() => child), ...child } as unknown as WakeGateRunnerDeps["logger"];
  return { logger, warn };
}

const GATE = { script: "noop", language: "js" as const, timeoutSeconds: 30 };
const CTX: WakeGateRunContext = { agentId: "agent-1", jobId: "job-1", sessionKey: "main:agent-1" };

/**
 * The richer runWakeGate outcome wrapped around a bare verdict. Under the default
 * constant test clock `durationMs` is 0; with no event bus in deps `toolCalls` is 0.
 */
function outcome(verdict: unknown, over: { durationMs?: number; toolCalls?: number } = {}) {
  return { verdict, durationMs: over.durationMs ?? 0, toolCalls: over.toolCalls ?? 0 };
}

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
      await expect(runner.runWakeGate(GATE, CTX)).resolves.toEqual(outcome({ wake: true }));
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
    await expect(runner.runWakeGate(GATE, CTX)).resolves.toEqual(outcome({ wake: true }));
  });
});

describe("createWakeGateRunner — fail-open WARN classifies the cause honestly", () => {
  /** Read the errorKind field of the (single) fail-open WARN. */
  function warnedErrorKind(warn: ReturnType<typeof vi.fn>): unknown {
    expect(warn).toHaveBeenCalledTimes(1);
    return (warn.mock.calls[0]![0] as { errorKind?: unknown }).errorKind;
  }

  it("classifies a genuine timeout as errorKind:timeout", async () => {
    const { logger, warn } = makeCapturingLogger();
    const { deps, runJailedScriptFn } = makeDeps({ logger });
    runJailedScriptFn.mockRejectedValue(new Error("orchestrate run exceeded its 30000ms timeout"));
    await createWakeGateRunner(deps).runWakeGate(GATE, CTX);
    expect(warnedErrorKind(warn)).toBe("timeout");
  });

  it("classifies a stdout overflow as errorKind:resource (NOT timeout)", async () => {
    const { logger, warn } = makeCapturingLogger();
    const { deps, runJailedScriptFn } = makeDeps({ logger });
    runJailedScriptFn.mockRejectedValue(new Error("orchestrate stdout exceeded the 4194304B hard cap"));
    await createWakeGateRunner(deps).runWakeGate(GATE, CTX);
    expect(warnedErrorKind(warn)).toBe("resource");
  });

  it("classifies a non-zero gate exit as errorKind:dependency (NOT timeout)", async () => {
    const { logger, warn } = makeCapturingLogger();
    const { deps, runJailedScriptFn } = makeDeps({ logger });
    runJailedScriptFn.mockRejectedValue(new Error("orchestrate jailed child exited with code 1"));
    await createWakeGateRunner(deps).runWakeGate(GATE, CTX);
    expect(warnedErrorKind(warn)).toBe("dependency");
  });

  it("classifies a lease-mint fault as errorKind:dependency (NOT timeout)", async () => {
    const { logger, warn } = makeCapturingLogger();
    const { deps, mintLease } = makeDeps({ logger });
    mintLease.mockImplementation(() => {
      throw new Error("lease mint boom");
    });
    await createWakeGateRunner(deps).runWakeGate(GATE, CTX);
    expect(warnedErrorKind(warn)).toBe("dependency");
  });
});

describe("createWakeGateRunner — clean-run verdict resolution", () => {
  it("resolves an explicit {wake:false} to skip", async () => {
    const { deps, runJailedScriptFn } = makeDeps();
    runJailedScriptFn.mockResolvedValue('{"wake":false}');
    await expect(createWakeGateRunner(deps).runWakeGate(GATE, CTX)).resolves.toEqual(outcome({ wake: false }));
  });

  it("resolves {wake:true,context} preserving the context", async () => {
    const { deps, runJailedScriptFn } = makeDeps();
    runJailedScriptFn.mockResolvedValue('{"wake":true,"context":"x"}');
    await expect(createWakeGateRunner(deps).runWakeGate(GATE, CTX)).resolves.toEqual(
      outcome({ wake: true, context: "x" }),
    );
  });

  it("fails open (wake:true) on empty stdout — an empty gate is never resolved to silent", async () => {
    const { deps, runJailedScriptFn } = makeDeps();
    runJailedScriptFn.mockResolvedValue("");
    await expect(createWakeGateRunner(deps).runWakeGate(GATE, CTX)).resolves.toEqual(outcome({ wake: true }));
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

describe("createWakeGateRunner — deliver egress-scrub", () => {
  // The delivered status text is untrusted (model-authored gate stdout) and the
  // downstream cron-delivery listener ships it VERBATIM, so the gate must scrub
  // it. A stand-in secret token proves the returned `deliver` is redacted, and
  // the scan spy proves WHICH raw text the gate handed to OutputGuard.
  const SECRET = "SEKRET-abcdefgh";
  const REDACTED = "[REDACTED:known_secret]";

  /**
   * An OutputGuard whose `scan` REDACTS `SECRET` → `REDACTED`, exposing the scan
   * spy so a test can assert the RAW deliver text it was handed. `registerSecret`
   * is preserved (the per-fire lease mint calls it — a bare `{ scan }` would make
   * the mint throw and fail open, masking the assertion).
   */
  function makeRedactingGuard() {
    const scan = vi.fn((text: string) =>
      ok({
        safe: !text.includes(SECRET),
        blocked: text.includes(SECRET),
        findings: [],
        sanitized: text.replaceAll(SECRET, REDACTED),
      }),
    );
    const outputGuard = { scan, registerSecret: vi.fn() } as unknown as WakeGateRunnerDeps["outputGuard"];
    return { outputGuard, scan };
  }

  it("redacts a registered-secret token in the deliver text before the verdict is returned", async () => {
    const { outputGuard, scan } = makeRedactingGuard();
    const { deps, runJailedScriptFn } = makeDeps({ outputGuard });
    runJailedScriptFn.mockResolvedValue(`{"wake":false,"deliver":"backup OK ${SECRET}"}`);

    const verdict = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(verdict).toEqual(outcome({ wake: false, deliver: `backup OK ${REDACTED}` }));
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(`backup OK ${SECRET}`);
  });

  it("routes a trailing [SILENT] <text> status through the scrub", async () => {
    const { outputGuard, scan } = makeRedactingGuard();
    const { deps, runJailedScriptFn } = makeDeps({ outputGuard });
    runJailedScriptFn.mockResolvedValue("[SILENT] backup OK");

    const verdict = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(verdict).toEqual(outcome({ wake: false, deliver: "backup OK" }));
    expect(scan).toHaveBeenCalledWith("backup OK");
  });

  it("leaves a context-only wake verdict untouched — only deliver is scrubbed", async () => {
    const { outputGuard, scan } = makeRedactingGuard();
    const { deps, runJailedScriptFn } = makeDeps({ outputGuard });
    runJailedScriptFn.mockResolvedValue('{"wake":true,"context":"CI red"}');

    const verdict = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(verdict).toEqual(outcome({ wake: true, context: "CI red" }));
    expect(scan).not.toHaveBeenCalled();
  });

  it("does not scan a HEARTBEAT_OK skip — there is no deliver to egress", async () => {
    const { outputGuard, scan } = makeRedactingGuard();
    const { deps, runJailedScriptFn } = makeDeps({ outputGuard });
    runJailedScriptFn.mockResolvedValue("HEARTBEAT_OK");

    const verdict = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(verdict).toEqual(outcome({ wake: false }));
    expect(scan).not.toHaveBeenCalled();
  });
});

describe("createWakeGateRunner — richer outcome (durationMs on the clean AND fail-open paths)", () => {
  it("returns { verdict, durationMs, toolCalls } with durationMs = the injected-clock delta across the run", async () => {
    let clock = 5_000;
    const now = vi.fn(() => clock);
    const { deps, runJailedScriptFn } = makeDeps({ now });
    // The run advances the injected clock by a known span; durationMs must equal it.
    runJailedScriptFn.mockImplementation(async () => {
      clock += 75;
      return '{"wake":false}';
    });

    const result = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(result).toEqual(outcome({ wake: false }, { durationMs: 75 }));
  });

  it("still reports a real durationMs on the fail-open catch path (a rejecting run has a span, never a throw)", async () => {
    let clock = 1_000;
    const now = vi.fn(() => clock);
    const { deps, runJailedScriptFn } = makeDeps({ now });
    // The run advances the clock THEN rejects — the timing wrap must cover the catch.
    runJailedScriptFn.mockImplementation(async () => {
      clock += 42;
      throw new Error("run exceeded its 30000ms timeout");
    });

    const result = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(result).toEqual(outcome({ wake: true }, { durationMs: 42 }));
  });
});

describe("createWakeGateRunner — scoped, leak-safe capability:audited toolCalls counter", () => {
  it("counts N allow-decision capability:audited events under the gate's OWN rootRunId → toolCalls === N", async () => {
    const bus = new TypedEventBus();
    const { deps, runJailedScriptFn, registerRoot } = makeDeps({ eventBus: bus });
    // The gate's per-fire rootRunId is anchored at mint (registerRoot), BEFORE the run.
    runJailedScriptFn.mockImplementation(async () => {
      const rootRunId = registerRoot.mock.calls[0]![0] as string;
      bus.emit("capability:audited", makeAudit(rootRunId, "allow"));
      bus.emit("capability:audited", makeAudit(rootRunId, "allow"));
      bus.emit("capability:audited", makeAudit(rootRunId, "allow"));
      return '{"wake":false}';
    });

    const result = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(result).toEqual(outcome({ wake: false }, { toolCalls: 3 }));
  });

  it("excludes deny decisions AND events under a different rootRunId from the count", async () => {
    const bus = new TypedEventBus();
    const { deps, runJailedScriptFn, registerRoot } = makeDeps({ eventBus: bus });
    runJailedScriptFn.mockImplementation(async () => {
      const rootRunId = registerRoot.mock.calls[0]![0] as string;
      bus.emit("capability:audited", makeAudit(rootRunId, "allow")); // counted
      bus.emit("capability:audited", makeAudit(rootRunId, "deny")); // NOT — a blocked call is no cost incurred
      bus.emit("capability:audited", makeAudit("root-wakegate-other-9z", "allow")); // NOT — another fire's root
      bus.emit("capability:audited", makeAudit(rootRunId, "allow")); // counted
      return '{"wake":false}';
    });

    const result = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(result).toEqual(outcome({ wake: false }, { toolCalls: 2 }));
  });

  it("removes the capability:audited listener after the run resolves (no leak across fires)", async () => {
    const bus = new TypedEventBus();
    const { deps, runJailedScriptFn, registerRoot } = makeDeps({ eventBus: bus });
    runJailedScriptFn.mockImplementation(async () => {
      const rootRunId = registerRoot.mock.calls[0]![0] as string;
      bus.emit("capability:audited", makeAudit(rootRunId, "allow"));
      return '{"wake":false}';
    });

    const result = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    // toolCalls===1 proves it WAS subscribed; listenerCount===0 proves it was cleaned up.
    expect(result).toEqual(outcome({ wake: false }, { toolCalls: 1 }));
    expect(bus.listenerCount("capability:audited")).toBe(0);
  });

  it("removes the listener even when the jailed run REJECTS (unsubscribe in a finally; count reflects allows before the reject)", async () => {
    const bus = new TypedEventBus();
    const { deps, runJailedScriptFn, registerRoot } = makeDeps({ eventBus: bus });
    runJailedScriptFn.mockImplementation(async () => {
      const rootRunId = registerRoot.mock.calls[0]![0] as string;
      bus.emit("capability:audited", makeAudit(rootRunId, "allow"));
      bus.emit("capability:audited", makeAudit(rootRunId, "allow"));
      throw new Error("run exceeded its 30000ms timeout");
    });

    const result = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    // Fail-open wake; the count survives to the fail-open return AND the listener is gone.
    expect(result).toEqual(outcome({ wake: true }, { toolCalls: 2 }));
    expect(bus.listenerCount("capability:audited")).toBe(0);
  });

  it("honest-degrades toolCalls to 0 when no eventBus is available (never fabricated)", async () => {
    // The default deps carry no eventBus — the counter must degrade to 0, not throw.
    const { deps, runJailedScriptFn } = makeDeps();
    runJailedScriptFn.mockResolvedValue('{"wake":false}');

    const result = await createWakeGateRunner(deps).runWakeGate(GATE, CTX);

    expect(result).toEqual(outcome({ wake: false }, { toolCalls: 0 }));
  });
});
