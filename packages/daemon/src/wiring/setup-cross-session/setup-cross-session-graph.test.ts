// SPDX-License-Identifier: Apache-2.0
/**
 * Graph leaf neighbor test for the setup-cross-session split. Pins the
 * symbol-export shape, the `SUB_AGENT_TOOL_DENYLIST` membership, and the
 * `MIN_SUB_AGENT_STEPS` integer constant for compile-time regression
 * coverage. The `buildExecuteSubAgent` closure-builder integration matrix
 * (parent intersection, ceiling, denylist, graph tool sort, spawn packet,
 * model resolution, cache retention) is exercised end-to-end by
 * setup-cross-session-runtime.test.ts through the setupCrossSession
 * invocation.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks. buildExecuteSubAgent imports concrete symbols from
// @comis/agent at module load; mock them so the daemon test never does real
// LLM/session work (the setup-cross-session-runtime.test.ts harness pattern).
// mockResolveOperationModel returns timeoutSource so the label-threading test pins the
// producer THREADING the label — the resolver's own labeling is pinned by
// the agent-package tests (operation-model-resolver.test.ts).
// ---------------------------------------------------------------------------

const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({
  model: "anthropic:claude-sonnet-4-5-20250929",
  provider: "anthropic",
  modelId: "claude-sonnet-4-5-20250929",
  source: "family_default" as const,
  operationType: "subagent" as const,
  timeoutMs: 120_000,
  timeoutSource: "operation_default" as const,
  cacheRetention: "short" as const,
})));

vi.mock("@comis/agent", () => ({
  createStepCounter: vi.fn(() => ({
    increment: vi.fn().mockReturnValue(1),
    shouldHalt: vi.fn().mockReturnValue(false),
    reset: vi.fn(),
    getCount: vi.fn().mockReturnValue(0),
  })),
  createSpawnPacketBuilder: vi.fn(),
  generateParentSummary: vi.fn(),
  createEphemeralComisSessionManager: vi.fn(() => ({
    withSession: vi.fn(),
    destroySession: vi.fn(),
    getSessionStats: vi.fn(),
    writeSessionMetadata: vi.fn(),
  })),
  createComisSessionManager: vi.fn(() => ({
    withSession: vi.fn(),
    destroySession: vi.fn(),
    getSessionStats: vi.fn(),
    writeSessionMetadata: vi.fn(),
  })),
  getCacheSafeParams: vi.fn(() => undefined),
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: vi.fn(() => "anthropic"),
}));

import {
  buildExecuteSubAgent,
  resolveGraphCacheRetention,
  MIN_SUB_AGENT_STEPS,
  type ExecuteSubAgentDeps,
} from "./setup-cross-session-graph.js";
import { createWorktreeRegistry } from "../setup-worktree-sweep.js";
import { createConversationLocator, runWithContext, SUB_AGENT_TOOL_DENYLIST } from "@comis/core";
import type { ExecutionResult } from "@comis/agent";

function makeConversation(tenantId: string, agentId: string) {
  const result = createConversationLocator({
    tenantId,
    agentId,
    partition: { kind: "agent" },
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe("setup-cross-session-graph", () => {
  it("buildExecuteSubAgent: exported as a callable function", () => {
    expect(typeof buildExecuteSubAgent).toBe("function");
    expect(buildExecuteSubAgent.length).toBeGreaterThanOrEqual(1);
  });

  it("ExecuteSubAgentDeps witness pins the closure-captured key set", () => {
    const witness: Record<keyof ExecuteSubAgentDeps, true> = {
      container: true,
      sessionStore: true,
      assembleToolsForAgent: true,
      getExecutor: true,
      fileLock: true,
      logger: true,
    };
    expect(Object.keys(witness).length).toBe(6);
  });

  it("MIN_SUB_AGENT_STEPS is a positive integer floor", () => {
    expect(Number.isInteger(MIN_SUB_AGENT_STEPS)).toBe(true);
    expect(MIN_SUB_AGENT_STEPS).toBeGreaterThan(0);
    expect(MIN_SUB_AGENT_STEPS).toBe(30);
  });

  it("SUB_AGENT_TOOL_DENYLIST contains the 12 documented management tools", () => {
    const expectedTools = [
      "gateway",
      "channels_manage",
      "agents_manage",
      "models_manage",
      "providers_manage",
      "tokens_manage",
      "skills_manage",
      "sessions_manage",
      "memory_manage",
      "heartbeat_manage",
      "mcp_manage",
      "mcp_login",
    ];
    expect(SUB_AGENT_TOOL_DENYLIST.size).toBe(expectedTools.length);
    for (const tool of expectedTools) {
      expect(SUB_AGENT_TOOL_DENYLIST.has(tool)).toBe(true);
    }
  });

  it("resolveGraphCacheRetention: leaf node returns short", () => {
    expect(resolveGraphCacheRetention(0, true)).toBe("short");
    expect(resolveGraphCacheRetention(3, true)).toBe("short");
    expect(resolveGraphCacheRetention(undefined, true)).toBe("short");
  });

  it("resolveGraphCacheRetention: non-leaf node returns long", () => {
    expect(resolveGraphCacheRetention(0, false)).toBe("long");
    expect(resolveGraphCacheRetention(3, false)).toBe("long");
    expect(resolveGraphCacheRetention(undefined, undefined)).toBe("long");
  });

  // -------------------------------------------------------------------------
  // The spawn producer labels its promptTimeout binding. A graph
  // spawn hardcodes GRAPH_PROMPT_TIMEOUT_MS = 600_000 — a constant NO operator
  // knob controls — so it must be labeled "graph_constant" (hints then render
  // honest prose instead of a fake agents.* key). A non-graph subagent
  // spawn threads subagentResolution.timeoutSource (born at the resolver) —
  // the bare { promptTimeoutMs } shape is the provenance-collapse bug.
  // -------------------------------------------------------------------------
  describe("promptTimeout provenance from the spawn producer", () => {
    const sessionKey = { channelId: "chan-1", userId: "user-1", tenantId: "t-1", agentId: "agent-2" };
    const conversation = makeConversation("t-1", "agent-2");

    function executionResult(
      overrides: Partial<Omit<ExecutionResult, "finishReason" | "terminalErrorKind">> = {},
    ): ExecutionResult {
      return {
        response: "done",
        sessionKey,
        executionId: "child-execution-a",
        responseLocalePolicy: { source: "unset", enforceLocale: false },
        sideEffectSummary: {
          schedulingCapabilityInvoked: false,
          outboundDeliveryCapabilityInvoked: false,
          deferredWorkCapabilityInvoked: false,
          unclassifiedInvocationObserved: false,
        },
        tokensUsed: { input: 5, output: 5, total: 10 },
        cost: { total: 0.01 },
        finishReason: "stop",
        stepsExecuted: 1,
        llmCalls: 1,
        ...overrides,
      };
    }

    function makeGraphDeps(metadata: Record<string, unknown>) {
      const capturedOverrides: Array<Record<string, unknown>> = [];
      const executor = {
        execute: vi.fn(async (...args: unknown[]): Promise<ExecutionResult> => {
          capturedOverrides.push(args[7] as Record<string, unknown>);
          return executionResult();
        }),
      };
      const deps = {
        container: {
          config: {
            agents: {
              default: { name: "Default", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
              "agent-2": { name: "Agent 2", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
            },
            security: {
              agentToAgent: {
                enabled: true,
                subAgentMaxSteps: 50,
                subAgentToolGroups: ["coding"],
                subAgentMcpTools: "inherit",
              },
            },
            providers: { entries: {} },
          },
          secretManager: { get: vi.fn(() => "test-key") },
        },
        sessionStore: { load: vi.fn(() => ({ ok: true, value: { messages: [], metadata } })) },
        assembleToolsForAgent: vi.fn(async () => [{ name: "tool-1" }]),
        getExecutor: vi.fn(() => executor),
        fileLock: {
          acquire: vi.fn(),
          release: vi.fn(),
          withLock: vi.fn(),
          isLocked: vi.fn(async () => false),
          cleanupStaleLocks: vi.fn(async () => 0),
        },
      } as unknown as ExecuteSubAgentDeps;
      return { deps, capturedOverrides, executor };
    }

    it("a graph spawn labels its hardcoded 600000ms constant source graph_constant (not a fake operator knob)", async () => {
      const { deps, capturedOverrides, executor } = makeGraphDeps({ graphSharedDir: "/tmp/graph-shared" });
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey, conversation, "task");

      expect(executor.execute).toHaveBeenCalledOnce();
      expect(capturedOverrides[0].promptTimeout).toEqual({
        promptTimeoutMs: 600_000,
        source: "graph_constant",
      });
    });

    it("a non-graph subagent spawn threads subagentResolution.timeoutSource alongside its timeoutMs", async () => {
      const { deps, capturedOverrides, executor } = makeGraphDeps({});
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey, conversation, "task");

      expect(executor.execute).toHaveBeenCalledOnce();
      expect(capturedOverrides[0].promptTimeout).toEqual({
        promptTimeoutMs: 120_000,
        source: "operation_default",
      });
    });

    it("acknowledges provider start only after child preparation completes", async () => {
      const { deps, executor } = makeGraphDeps({});
      const order: string[] = [];
      vi.mocked(deps.assembleToolsForAgent).mockImplementation(async () => {
        order.push("assembled");
        return [{ name: "tool-1" }] as never;
      });
      vi.mocked(executor.execute).mockImplementation(async () => {
        order.push("executed");
        return executionResult();
      });
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent(
        "agent-2",
        sessionKey,
        conversation,
        "task",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { onProviderStart: () => order.push("provider-started") },
      );

      expect(order).toEqual(["assembled", "provider-started", "executed"]);
    });

    // -----------------------------------------------------------------------
    // The per-spawn tokenBudget (the 7th executeSubAgent arg) rides
    // the existing executionOverrides channel into the child executor, where
    // pi-executor feeds it to budgetGuard.resetExecution(cap) as the child's
    // per-execution cap. Absent ⇒ no tokenBudget on the overrides (no-op,
    // byte-identical to today).
    // -----------------------------------------------------------------------
    it("threads the 7th tokenBudget arg onto executionOverrides for the child executor", async () => {
      const { deps, capturedOverrides, executor } = makeGraphDeps({});
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent(
        "agent-2",
        sessionKey,
        conversation,
        "task",
        undefined,
        undefined,
        undefined,
        5_000,
      );

      expect(executor.execute).toHaveBeenCalledOnce();
      expect(capturedOverrides[0].tokenBudget).toBe(5_000);
    });

    it("omits tokenBudget from executionOverrides when no per-spawn budget is given", async () => {
      const { deps, capturedOverrides, executor } = makeGraphDeps({});
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey, conversation, "task");

      expect(executor.execute).toHaveBeenCalledOnce();
      expect(capturedOverrides[0].tokenBudget).toBeUndefined();
    });

    it("threads the executor terminal kind through the subagent execution boundary", async () => {
      const { deps, executor } = makeGraphDeps({});
      vi.mocked(executor.execute).mockResolvedValueOnce({
        ...executionResult({ response: "" }),
        finishReason: "error",
        terminalErrorKind: "dependency",
      });
      const executeSubAgent = buildExecuteSubAgent(deps);

      const result = await executeSubAgent("agent-2", sessionKey, conversation, "task");

      expect((result as { terminalErrorKind?: string }).terminalErrorKind).toBe("dependency");
    });

    it("binds child tool assembly to the exact child session and inherited delivery origin", async () => {
      const { deps } = makeGraphDeps({});
      const executeSubAgent = buildExecuteSubAgent(deps);
      const deliveryOrigin = Object.freeze({
        channelType: "telegram",
        channelId: "chan-1",
        userId: "user-1",
        tenantId: "t-1",
        threadId: "topic-1",
      });

      await runWithContext({
        tenantId: "t-1",
        userId: "user-1",
        sessionKey: "t-1:user-1:parent-channel:thread:topic-1",
        agentId: "parent-agent",
        traceId: "30000000-0000-4000-8000-000000000003",
        startedAt: 1_700_000_000_000,
        trustLevel: "user",
        channelType: "telegram",
        deliveryOrigin,
      }, () => executeSubAgent(
        "agent-2",
        { ...sessionKey, threadId: "topic-1" },
        conversation,
        "task",
      ));

      expect(deps.assembleToolsForAgent).toHaveBeenCalledWith("agent-2", expect.objectContaining({
        sessionKey: { ...sessionKey, threadId: "topic-1" },
        requesterOrigin: deliveryOrigin,
      }));
    });

    it("threads the authenticated parent lease and capability ceiling into child tool assembly", async () => {
      const { deps } = makeGraphDeps({});
      const executeSubAgent = buildExecuteSubAgent(deps);
      const onAssemblyAuthority = vi.fn();

      await executeSubAgent(
        "agent-2",
        sessionKey,
        conversation,
        "task",
        undefined,
        undefined,
        undefined,
        undefined,
        {
          rootRunId: "root-parent",
          parentLeaseId: "lease-parent",
          parentCaps: ["orch:read"],
          onAssemblyAuthority,
        },
      );

      expect(deps.assembleToolsForAgent).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          autonomyParent: {
            rootRunId: "root-parent",
            leaseId: "lease-parent",
            caps: ["orch:read"],
          },
          onAutonomyAssembly: onAssemblyAuthority,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // END-TO-END: executeSubAgent runs a `worktree:true` child IN an
  // isolated git worktree. These are the HONEST-WIRING proofs —
  // they assert the call SITE actually fires (createWorktree runs,
  // the child's executionOverrides.workspaceDir IS the worktree dir, and the
  // worktree is auto-cleaned-if-unchanged on terminal settle), not just that
  // the lifecycle module exists.
  // -------------------------------------------------------------------------
  describe("executeSubAgent worktree create/run/clean wiring", () => {
    const sessionKey = { channelId: "chan-wt", userId: "user-wt", tenantId: "t-wt", agentId: "agent-2" };
    const conversation = makeConversation("t-wt", "agent-2");
    const DATA_DIR = "/data";
    // workspace-agent-2 (resolveWorkspaceDir: <dataDir>/workspace-<agentId>).
    const WORKSPACE = "/data/workspace-agent-2";

    /**
     * Build deps with the worktree seam wired + a GitExec fake driven by a status
     * reply (clean vs dirty). Captures git calls + the child's executionOverrides.
     */
    function makeWorktreeDeps(opts: {
      metadata: Record<string, unknown>;
      statusPorcelain?: string;
      headSha?: string;
      baseSha?: string;
      omitSeam?: boolean;
    }) {
      const gitCalls: Array<{ args: string[]; cwd: string }> = [];
      const head = opts.headSha ?? "sha-x";
      const base = opts.baseSha ?? "sha-x";
      const worktreeGitExec = async (args: string[], cwd: string) => {
        gitCalls.push({ args, cwd });
        if (args[0] === "status" && args[1] === "--porcelain")
          return { stdout: opts.statusPorcelain ?? "", exitCode: 0 };
        if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: head, exitCode: 0 };
        if (args[0] === "rev-parse") return { stdout: base, exitCode: 0 };
        return { stdout: "", exitCode: 0 };
      };
      const registry = createWorktreeRegistry();
      const capturedOverrides: Array<Record<string, unknown>> = [];
      const executor = {
        execute: vi.fn(async (...args: unknown[]) => {
          capturedOverrides.push(args[7] as Record<string, unknown>);
          return { response: "done", tokensUsed: { total: 10 }, cost: { total: 0.01 }, finishReason: "stop", stepsExecuted: 1 };
        }),
      };
      const deps = {
        container: {
          config: {
            dataDir: DATA_DIR,
            agents: {
              default: { name: "Default", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
              "agent-2": { name: "Agent 2", provider: "anthropic", model: "claude-sonnet-4-5-20250929", operationModels: {} },
            },
            security: { agentToAgent: { enabled: true, subAgentMaxSteps: 50, subAgentToolGroups: ["coding"], subAgentMcpTools: "inherit" } },
            providers: { entries: {} },
          },
          secretManager: { get: vi.fn(() => "test-key") },
        },
        sessionStore: { load: vi.fn(() => ({ ok: true, value: { messages: [], metadata: opts.metadata } })) },
        assembleToolsForAgent: vi.fn(async () => [{ name: "tool-1" }]),
        getExecutor: vi.fn(() => executor),
        fileLock: { acquire: vi.fn(), release: vi.fn(), withLock: vi.fn(), isLocked: vi.fn(async () => false), cleanupStaleLocks: vi.fn(async () => 0) },
        ...(opts.omitSeam ? {} : { worktreeGitExec, worktreeRegistry: registry }),
      } as unknown as ExecuteSubAgentDeps;
      return { deps, gitCalls, registry, capturedOverrides, executor };
    }

    it("creates a worktree (git worktree add) and runs the child with executionOverrides.workspaceDir = the worktree dir", async () => {
      const { deps, gitCalls, capturedOverrides } = makeWorktreeDeps({
        metadata: { worktree: true, runId: "run-77" },
      });
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey, conversation, "wt task");

      // Honest wiring: git worktree add actually ran.
      const addCall = gitCalls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
      expect(addCall).toBeDefined();
      // The worktree dir is confined under the agent's jailed workspace.
      const expectedDir = `${WORKSPACE}/.worktrees/wt-run-77`;
      expect(addCall!.args).toContain(expectedDir);
      // The child ran IN the worktree: its executionOverrides.workspaceDir IS it.
      expect(capturedOverrides[0].workspaceDir).toBe(expectedDir);
    });

    it("auto-cleans a CLEAN worktree on completion (git worktree remove) and drops the registry entry", async () => {
      const { deps, gitCalls, registry } = makeWorktreeDeps({
        metadata: { worktree: true, runId: "run-clean" },
        statusPorcelain: "", headSha: "x", baseSha: "x",
      });
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey, conversation, "wt task");

      expect(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
      // Clean worktree reclaimed in-line → registry empty.
      expect(registry.snapshot()).toHaveLength(0);
    });

    it("DANGEROUS case: PRESERVES a DIRTY worktree on completion (remove never attempted; registry keeps it for the sweep)", async () => {
      const { deps, gitCalls, registry } = makeWorktreeDeps({
        metadata: { worktree: true, runId: "run-dirty" },
        statusPorcelain: "?? scratch.txt",
      });
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey, conversation, "wt task");

      // The dangerous op was NEVER attempted on the dirty tree.
      expect(gitCalls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
      // The entry is preserved (marked completed) so the boot sweep retries it.
      const snap = registry.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0]!.completed).toBe(true);
    });

    it("does NOT create a worktree when meta.worktree is absent (byte-identical default path)", async () => {
      const { deps, gitCalls, capturedOverrides } = makeWorktreeDeps({
        metadata: { runId: "run-plain" },
      });
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey, conversation, "plain task");

      expect(gitCalls).toHaveLength(0);
      expect(capturedOverrides[0].workspaceDir).toBeUndefined();
    });

    it("honestly SKIPS (no crash) when worktree requested but the git seam is not wired", async () => {
      const { deps, gitCalls, capturedOverrides, executor } = makeWorktreeDeps({
        metadata: { worktree: true, runId: "run-noseam" },
        omitSeam: true,
      });
      const executeSubAgent = buildExecuteSubAgent(deps);

      await executeSubAgent("agent-2", sessionKey, conversation, "wt task");

      // No git calls (no seam), but the child still ran in its shared workspace.
      expect(gitCalls).toHaveLength(0);
      expect(executor.execute).toHaveBeenCalledOnce();
      expect(capturedOverrides[0].workspaceDir).toBeUndefined();
    });
  });
});
