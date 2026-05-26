// SPDX-License-Identifier: Apache-2.0
/**
 * Activity-transparency emit-site tests for the PiEventBridge (plan 70-06,
 * EVT-01/02/10). Co-located (NOT a __tests__/ dir — Pitfall 1).
 *
 * Asserts the producer-side redaction obligation at the bridge's two tool-event
 * emit sites and the failureDetector hook placement (§16.1 + §16.10):
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
import type { ModelOperationType } from "@comis/core";
import { registerToolMetadata } from "@comis/core";
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

describe("PiEventBridge activity emit-site redaction (EVT-01/02)", () => {
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

describe("PiEventBridge $HOME compaction at the emit sites (WR-05)", () => {
  const HOME = "/home/operator";

  it("tool:started compacts a $HOME-rooted param path to ~ when homeDir is wired", () => {
    const deps = createMockDeps({ homeDir: HOME });
    const { listener } = createPiEventBridge(deps);

    listener(startEvent("read", "tc-h1", { path: `${HOME}/.comis/agents.md` }) as any);

    const started = emitPayload(deps, "tool:started");
    // $HOME compacts to ~; the trailing 2 segments (.comis/agents.md) survive
    // per the SEC-02 compaction contract.
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

describe("PiEventBridge failureDetector hook (EVT-10, §16.10)", () => {
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
