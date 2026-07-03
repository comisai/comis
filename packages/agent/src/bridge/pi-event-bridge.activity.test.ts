// SPDX-License-Identifier: Apache-2.0
/**
 * Activity-transparency emit-site tests for the PiEventBridge. Co-located
 * with the source (the repo's test-placement convention — no __tests__/ dirs).
 *
 * Asserts the producer-side redaction obligation at the bridge's two tool-event
 * emit sites and the failureDetector hook placement:
 *
 *  - tool:started forwards REDACTED params (no raw apiKey) + an `action` field.
 *  - tool:executed forwards toolCallId (matching the paired start), traceId
 *    (= deps.executionId), and REDACTED params.
 *  - the failureDetector (from tool metadata) runs BEFORE the tool:executed emit,
 *    folds into success/errorKind, and a THROWING detector is caught (original
 *    success preserved, WARN logged with errorKind:"internal").
 */
import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type { ModelOperationType, EventMap, TurnActivityContext, ActivityEvent } from "@comis/core";
import { registerToolMetadata, TypedEventBus, formatSessionKey, runWithContext } from "@comis/core";
import { createActivityStream } from "@comis/observability";
import { createPiEventBridge } from "./pi-event-bridge.js";
import type { PiEventBridgeDeps } from "./pi-event-bridge.js";

// Mock @comis/observability so session-index writes don't hit real fs.
vi.mock("@comis/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/observability")>();
  return {
    ...actual,
    appendSessionIndexEntry: vi.fn().mockReturnValue("queued"),
  };
});

function createMockDeps(overrides?: Partial<PiEventBridgeDeps>): PiEventBridgeDeps {
  return {
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      listenerCount: vi.fn().mockReturnValue(0),
    } as any,
    budgetGuard: {
      recordUsage: vi.fn(),
      checkBudget: vi.fn().mockReturnValue(ok(undefined)),
      estimateCost: vi.fn(),
      resetExecution: vi.fn(),
    },
    costTracker: {
      record: vi.fn(),
      getByAgent: vi.fn(),
      getByChannel: vi.fn(),
      getByExecution: vi.fn(),
      getBySession: vi.fn(),
      getByProvider: vi.fn(),
      getAll: vi.fn(),
      prune: vi.fn(),
    } as any,
    stepCounter: {
      increment: vi.fn().mockReturnValue(1),
      shouldHalt: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
      getCount: vi.fn().mockReturnValue(0),
    },
    circuitBreaker: {
      isOpen: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      getState: vi.fn(),
      reset: vi.fn(),
    },
    sessionKey: { tenantId: "t1", channelId: "c1", userId: "u1" },
    agentId: "test-agent",
    channelId: "test-channel",
    executionId: "exec-001",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    operationType: "interactive" as ModelOperationType,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
      fatal: vi.fn(),
      trace: vi.fn(),
    } as any,
    onDelta: vi.fn(),
    onAbort: vi.fn(),
    ...overrides,
  };
}

function startEvent(toolName: string, toolCallId: string, args?: unknown) {
  return {
    type: "tool_execution_start" as const,
    toolCallId,
    toolName,
    args: args ?? { path: "/tmp/test" },
  };
}

function endEvent(
  toolName: string,
  toolCallId: string,
  isError = false,
  result?: unknown,
) {
  return {
    type: "tool_execution_end" as const,
    toolCallId,
    toolName,
    result: result ?? { content: [{ type: "text", text: "ok" }] },
    isError,
  };
}

/** Pull the first emit call payload matching an event name from the spy. */
function emitPayload(deps: PiEventBridgeDeps, name: string): any {
  const call = vi
    .mocked(deps.eventBus.emit)
    .mock.calls.find((c) => c[0] === name);
  return call?.[1];
}

describe("PiEventBridge activity emit-site redaction", () => {
  it("tool:started forwards redacted params (no raw apiKey) and an action field", () => {
    const deps = createMockDeps();
    const { listener } = createPiEventBridge(deps);

    listener(
      startEvent("exec", "tc-1", { apiKey: "sk-ant-secret123456789", action: "run" }) as any,
    );

    const started = emitPayload(deps, "tool:started");
    expect(started).toBeDefined();
    // params present but REDACTED — raw secret must not appear.
    expect(started.params).toBeDefined();
    expect(started.params.apiKey).toBe("<redacted>");
    expect(JSON.stringify(started.params)).not.toContain("sk-ant-secret123456789");
    // action field threaded onto the started emit.
    expect(started.action).toBe("run");
  });

  it("tool:executed threads toolCallId, traceId (=executionId), and redacted params", () => {
    const deps = createMockDeps();
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("exec", "tc-42", { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }) as any);
    listener(endEvent("exec", "tc-42", false) as any);

    const executed = emitPayload(deps, "tool:executed");
    expect(executed).toBeDefined();
    expect(executed.toolCallId).toBe("tc-42");
    expect(executed.traceId).toBe("exec-001");
    expect(executed.params).toBeDefined();
    expect(executed.params.token).toBe("<redacted>");
    expect(JSON.stringify(executed.params)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("PiEventBridge $HOME compaction at the emit sites", () => {
  const HOME = "/home/operator";

  it("tool:started compacts a $HOME-rooted param path to ~ when homeDir is wired", () => {
    const deps = createMockDeps({ homeDir: HOME });
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("read", "tc-h1", { path: `${HOME}/.comis/agents.md` }) as any);

    const started = emitPayload(deps, "tool:started");
    // $HOME compacts to ~; the trailing 2 segments (.comis/agents.md) survive
    // per the compaction contract.
    expect(started.params.path).toContain("~/.comis/agents.md");
    expect(JSON.stringify(started.params)).not.toContain(HOME);
  });

  it("tool:executed compacts a $HOME-rooted param path to ~ when homeDir is wired", () => {
    const deps = createMockDeps({ homeDir: HOME });
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("read", "tc-h2", { path: `${HOME}/.comis/config.yaml` }) as any);
    listener(endEvent("read", "tc-h2", false) as any);

    const executed = emitPayload(deps, "tool:executed");
    expect(executed.params.path).toContain("~/.comis/config.yaml");
    expect(JSON.stringify(executed.params)).not.toContain(HOME);
  });
});

describe("PiEventBridge failureDetector hook", () => {
  it("a failureDetector returning true marks success:false with an errorKind on an isError:false result", () => {
    registerToolMetadata("activity_flaky_70_06", { failureDetector: () => true });
    const deps = createMockDeps();
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("activity_flaky_70_06", "tc-1") as any);
    listener(endEvent("activity_flaky_70_06", "tc-1", false) as any);

    const executed = emitPayload(deps, "tool:executed");
    expect(executed.success).toBe(false);
    expect(executed.errorKind).toBe("internal");
  });

  it("a failureDetector returning {errorKind} stamps that closed-union errorKind", () => {
    registerToolMetadata("activity_classified_70_06", {
      failureDetector: () => ({ errorKind: "validation" as const }),
    });
    const deps = createMockDeps();
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("activity_classified_70_06", "tc-1") as any);
    listener(endEvent("activity_classified_70_06", "tc-1", false) as any);

    const executed = emitPayload(deps, "tool:executed");
    expect(executed.success).toBe(false);
    expect(executed.errorKind).toBe("validation");
  });

  it("a THROWING failureDetector is caught: original success preserved, WARN with errorKind:internal", () => {
    registerToolMetadata("activity_boom_70_06", {
      failureDetector: () => {
        throw new Error("detector exploded");
      },
    });
    const deps = createMockDeps();
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("activity_boom_70_06", "tc-1") as any);
    listener(endEvent("activity_boom_70_06", "tc-1", false) as any);

    const executed = emitPayload(deps, "tool:executed");
    // Original success preserved (the detector throw must not flip it).
    expect(executed.success).toBe(true);
    // WARN logged with errorKind:"internal".
    const warnCall = vi
      .mocked(deps.logger.warn)
      .mock.calls.find(
        (c) => (c[0] as Record<string, unknown>)?.errorKind === "internal",
      );
    expect(warnCall).toBeDefined();
    expect((warnCall![0] as Record<string, unknown>).hint).toBeDefined();
  });

  it("no failureDetector leaves a clean success untouched", () => {
    const deps = createMockDeps();
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("plain", "tc-1") as any);
    listener(endEvent("plain", "tc-1", false) as any);

    const executed = emitPayload(deps, "tool:executed");
    expect(executed.success).toBe(true);
    expect(executed.errorKind).toBeUndefined();
  });
});

// ===========================================================================
// End-to-end: a REAL registered detector flips success BEFORE the
// tool:executed emit, and the flip propagates through ActivityStream as
// status:"failed" + semanticPhase:"error" — without the raw result ever
// reaching the emit or the rendered ActivityEvent.
//
// Per AGENTS.md §2.10 this is a CONTRACT test pinning the existing-correct
// seam (pi-event-bridge.ts:566-593) + downstream mapping
// (activity-stream.ts:414-435). It is the "verified end-to-end"
// success-criterion proof; it must fail if a future edit regresses the
// before-emit flip, the status:"failed" mapping, or the no-raw-result-leak
// boundary.
//
// The synthetic tool name keeps the end-to-end test self-contained — it does
// not depend on the production web_search wiring being driven.
// ===========================================================================

describe("end-to-end -- detector flip produces ActivityStream status:failed", () => {
  const RAW_BODY = "rate limit exceeded";

  // The mock deps emit with these identities (see createMockDeps); the turn
  // subscription must match {agentId, sessionKey, traceId} exactly or the
  // ActivityStream filters the event out.
  const AGENT = "test-agent";
  const TRACE = "exec-001";
  const SESSION = formatSessionKey({ tenantId: "t1", channelId: "c1", userId: "u1" });

  function makeTurnCtx(): TurnActivityContext {
    return {
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
      channelType: "telegram",
      channelKey: "chat-1",
      chatType: "direct",
      inboundMessageId: "m-1",
      rendererKey: "test-agent:telegram:chat-1:direct",
    };
  }

  it("a success-shaped rate-limit body flips to success:false + errorKind:resource and renders status:failed with no raw-result leak", () => {
    registerToolMetadata("activity_ratelimit_75_03", {
      failureDetector: (r, isErr) =>
        !isErr && /rate limit/i.test(JSON.stringify(r) ?? "")
          ? { errorKind: "resource" as const }
          : false,
    });

    // Shared real bus so the bridge emit drives the ActivityStream subscriber.
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus });
    const activityEvents: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeTurnCtx(), (e) => activityEvents.push(e));

    const executedPayloads: EventMap["tool:executed"][] = [];
    bus.on("tool:executed", (p) => executedPayloads.push(p));

    const deps = createMockDeps({ eventBus: bus });
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("activity_ratelimit_75_03", "tc-rl") as any);
    // isError:false (SDK reported success) + a 200-shaped body whose TEXT
    // signals failure — exactly the case the detector exists to catch.
    listener(endEvent("activity_ratelimit_75_03", "tc-rl", false, { content: RAW_BODY }) as any);

    // (1) Before-emit flip: the tool:executed payload is already failed.
    expect(executedPayloads).toHaveLength(1);
    const executed = executedPayloads[0]!;
    expect(executed.success).toBe(false);
    expect(executed.errorKind).toBe("resource");

    // (2) Downstream mapping: the ActivityStream renders the end frame failed.
    const endEvt = activityEvents.find((e) => e.phase === "end");
    expect(endEvt).toBeDefined();
    expect(endEvt!.status).toBe("failed");
    expect(endEvt!.semanticPhase).toBe("error");
    expect(endEvt!.errorKind).toBe("resource");

    // (3) NO RAW RESULT LEAK — the load-bearing guarantee
    // is "observability never sees the raw result". The OBSERVABILITY artifact
    // is the rendered ActivityEvent (what reaches the channel painter): its
    // defaultLabel is built from `params` ONLY (activity-stream.ts:417), never
    // from the raw result or errorMessage. Assert the raw body is absent from
    // the serialized ActivityEvent — the strong no-leak proof.
    expect(JSON.stringify(endEvt)).not.toContain(RAW_BODY);

    // On the tool:executed BUS event, the detector returned a fixed ErrorKind
    // (never a result-derived string — see the registered detector), and the
    // bridge never emits the raw result OBJECT: there is no `result` field and
    // `params` carries only the redacted start args, not the body.
    expect(executed).not.toHaveProperty("result");
    expect(JSON.stringify(executed.params ?? {})).not.toContain(RAW_BODY);

    // The bridge's failure-diagnostics path (pi-event-bridge.ts:606-607,752)
    // DOES surface a sanitized, length-capped `errorMessage` derived from the
    // result via extractErrorText()+sanitizeLogString() — this is the existing,
    // intentional trajectory/alerting diagnostic (logged at WARN), NOT the
    // activity renderer, and it never carries the raw result OBJECT. Pin that
    // contract: errorMessage is a bounded string and the ActivityEvent above
    // proves the raw text never reaches the rendered (observability) surface.
    expect(typeof executed.errorMessage).toBe("string");
    expect(executed.errorMessage!.length).toBeLessThanOrEqual(1500);

    sub.unsubscribe();
  });

  it("a THROWING detector is caught: original success preserved + WARN errorKind:internal (verified, not re-implemented)", () => {
    registerToolMetadata("activity_throw_75_03", {
      failureDetector: () => {
        throw new Error("detector exploded");
      },
    });

    const bus = new TypedEventBus();
    const executedPayloads: EventMap["tool:executed"][] = [];
    bus.on("tool:executed", (p) => executedPayloads.push(p));

    const deps = createMockDeps({ eventBus: bus });
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("activity_throw_75_03", "tc-throw") as any);
    listener(endEvent("activity_throw_75_03", "tc-throw", false) as any);

    // Original SDK-reported success preserved (the throw must not flip it).
    expect(executedPayloads).toHaveLength(1);
    expect(executedPayloads[0]!.success).toBe(true);

    // WARN logged with errorKind:"internal" + an operator hint.
    const warnCall = vi
      .mocked(deps.logger.warn)
      .mock.calls.find((c) => (c[0] as Record<string, unknown>)?.errorKind === "internal");
    expect(warnCall).toBeDefined();
    expect((warnCall![0] as Record<string, unknown>).hint).toBeDefined();
  });
});

// ===========================================================================
// pi-event-bridge must honor the ALS RequestContext.traceId at
// every emit site, falling back to deps.executionId only when ALS is absent.
// The bug class guarded here: stamping deps.executionId unconditionally — that
// ID is a per-pi-mono-run UUID, NOT the channel ingress traceId the activity
// stream's 3-way filter (agentId + sessionKey + traceId) keys on, so every
// turn-scoped subscriber would silently filter the bridge's events out. The
// ALS-absent regression-guard pins the executionId fallback.
// ===========================================================================

describe("PiEventBridge traceId honors ALS RequestContext when present", () => {
  // The ingress traceId the channel adapter sets via runWithContext at the
  // pipeline entry — distinct from deps.executionId so the bug is unambiguous.
  const ALS_TRACE = "4efb2c13-946d-43bc-a87e-2fe26fe29fa1";

  function withCtx<T>(fn: () => T): T {
    return runWithContext(
      {
        tenantId: "default",
        traceId: ALS_TRACE,
        startedAt: Date.now(),
        trustLevel: "admin",
      },
      fn,
    );
  }

  it("tool:started uses ALS traceId (not deps.executionId) when called inside runWithContext", () => {
    const deps = createMockDeps(); // executionId: "exec-001"
    const { listener } = createPiEventBridge(deps);

    withCtx(() => {
      listener(startEvent("read", "tc-als-1") as any);
    });

    const started = emitPayload(deps, "tool:started");
    expect(started).toBeDefined();
    expect(started.traceId).toBe(ALS_TRACE);
    expect(started.traceId).not.toBe("exec-001");
  });

  it("tool:executed uses ALS traceId (not deps.executionId) when called inside runWithContext", () => {
    const deps = createMockDeps();
    const { listener } = createPiEventBridge(deps);

    withCtx(() => {
      listener(startEvent("read", "tc-als-2") as any);
      listener(endEvent("read", "tc-als-2", false) as any);
    });

    const executed = emitPayload(deps, "tool:executed");
    expect(executed).toBeDefined();
    expect(executed.traceId).toBe(ALS_TRACE);
    expect(executed.traceId).not.toBe("exec-001");
  });

  it("tool:executed falls back to deps.executionId when called OUTSIDE any runWithContext scope", () => {
    // Regression guard for the ALS-absent path (e.g. SDK async callbacks that
    // may not propagate ALS). This MUST stay exec-001.
    const deps = createMockDeps();
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("read", "tc-no-als") as any);
    listener(endEvent("read", "tc-no-als", false) as any);

    const executed = emitPayload(deps, "tool:executed");
    expect(executed).toBeDefined();
    expect(executed.traceId).toBe("exec-001");
  });
});
