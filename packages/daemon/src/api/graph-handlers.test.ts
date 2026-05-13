// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGraphHandlers, transformNodes, validateGraphWarnings, schemaToExample, type GraphHandlerDeps } from "./graph-handlers.js";
import { ok } from "@comis/shared";
import type { NodeExecutionState } from "@comis/core";
import { z } from "zod";
import { createAgentDriver } from "../graph/drivers/agent-driver.js";
import { createDebateDriver } from "../graph/drivers/debate-driver.js";

// ---------------------------------------------------------------------------
// Mock coordinator
// ---------------------------------------------------------------------------

function createMockCoordinator() {
  return {
    run: vi.fn(),
    getStatus: vi.fn(),
    cancel: vi.fn(),
    listGraphs: vi.fn(),
    getConcurrencyStats: vi.fn().mockReturnValue({ activeGraphs: 0, queuedNodes: 0, runningNodes: 0, maxConcurrentNodes: 4 }),
    shutdown: vi.fn(),
  };
}

function createDeps(overrides?: Partial<GraphHandlerDeps>): GraphHandlerDeps {
  return {
    graphCoordinator: createMockCoordinator(),
    defaultAgentId: "default-agent",
    securityConfig: { agentToAgent: { enabled: true } },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Minimal valid graph params (snake_case -- as the tool would send them)
// ---------------------------------------------------------------------------

const VALID_NODES = [
  { node_id: "a", task: "Do task A" },
  { node_id: "b", task: "Do task B", depends_on: ["a"] },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("graph-handlers", () => {
  let deps: GraphHandlerDeps;
  let handlers: ReturnType<typeof createGraphHandlers>;

  beforeEach(() => {
    deps = createDeps();
    handlers = createGraphHandlers(deps);
  });

  // -------------------------------------------------------------------------
  // transformNodes
  // -------------------------------------------------------------------------

  describe("transformNodes", () => {
    it("transforms snake_case to camelCase", () => {
      const result = transformNodes([
        {
          node_id: "fetch",
          task: "Fetch data",
          agent: "fetcher",
          depends_on: ["init"],
          timeout_ms: 5000,
          max_steps: 10,
          model: "claude-sonnet-4-20250514",
        },
      ]);

      expect(result).toEqual([
        {
          nodeId: "fetch",
          task: "Fetch data",
          agentId: "fetcher",
          dependsOn: ["init"],
          timeoutMs: 5000,
          maxSteps: 10,
          model: "claude-sonnet-4-20250514",
        },
      ]);
    });

    it("transforms barrier_mode to barrierMode", () => {
      const result = transformNodes([
        { node_id: "fan-in", task: "Aggregate", barrier_mode: "majority" },
      ]);

      expect(result[0]).toMatchObject({
        nodeId: "fan-in",
        barrierMode: "majority",
      });
    });

    it("passes through camelCase barrierMode", () => {
      const result = transformNodes([
        { nodeId: "fan-in", task: "Aggregate", barrierMode: "best-effort" },
      ]);

      expect(result[0]).toMatchObject({
        nodeId: "fan-in",
        barrierMode: "best-effort",
      });
    });

    it("omits barrierMode when neither barrier_mode nor barrierMode provided", () => {
      const result = transformNodes([
        { node_id: "simple", task: "No barrier" },
      ]);

      expect(result[0]).not.toHaveProperty("barrierMode");
    });

    it("transforms context_mode to contextMode", () => {
      const result = transformNodes([
        { node_id: "a", task: "test", context_mode: "summary" },
      ]);

      expect(result[0]).toMatchObject({
        nodeId: "a",
        contextMode: "summary",
      });
    });

    it("passes through camelCase contextMode", () => {
      const result = transformNodes([
        { nodeId: "a", task: "test", contextMode: "none" },
      ]);

      expect(result[0]).toMatchObject({
        nodeId: "a",
        contextMode: "none",
      });
    });

    it("omits contextMode when neither context_mode nor contextMode provided", () => {
      const result = transformNodes([
        { node_id: "simple", task: "No context mode" },
      ]);

      expect(result[0]).not.toHaveProperty("contextMode");
    });

    it("passes through camelCase fields when snake_case absent", () => {
      const result = transformNodes([
        { nodeId: "a", task: "Do A", agentId: "test", dependsOn: [], timeoutMs: 1000 },
      ]);

      expect(result[0]).toMatchObject({
        nodeId: "a",
        task: "Do A",
        agentId: "test",
        dependsOn: [],
        timeoutMs: 1000,
      });
    });

    it("maps type_id and type_config to camelCase", () => {
      const result = transformNodes([
        { node_id: "typed", task: "Run debate", type_id: "debate", type_config: { agents: ["a", "b"] } },
      ]);

      expect(result[0]).toMatchObject({
        nodeId: "typed",
        typeId: "debate",
        typeConfig: { agents: ["a", "b"] },
      });
      expect(result[0]).not.toHaveProperty("type_id");
      expect(result[0]).not.toHaveProperty("type_config");
    });

    it("omits typeId/typeConfig when not provided", () => {
      const result = transformNodes([
        { node_id: "plain", task: "Simple" },
      ]);

      expect(result[0]).not.toHaveProperty("typeId");
      expect(result[0]).not.toHaveProperty("typeConfig");
    });

    it("migrates legacy debate to typeId/typeConfig", () => {
      const result = transformNodes([
        { node_id: "old", task: "Discuss", debate: { agents: ["a", "b"], rounds: 3, synthesizer: "judge" } },
      ]);

      expect(result[0]).toMatchObject({
        nodeId: "old",
        typeId: "debate",
        typeConfig: { agents: ["a", "b"], rounds: 3, synthesizer: "judge" },
      });
      expect(result[0]).not.toHaveProperty("debate");
    });

    it("downgrades single-agent legacy debate to regular node", () => {
      const result = transformNodes([
        { node_id: "solo", task: "Think", debate: { agents: ["solo-agent"], rounds: 2 } },
      ]);

      expect(result[0]).not.toHaveProperty("typeId");
      expect(result[0]).not.toHaveProperty("typeConfig");
      expect(result[0]).not.toHaveProperty("debate");
      expect((result[0] as Record<string, unknown>).agentId).toBe("solo-agent");
    });
  });

  // -------------------------------------------------------------------------
  // graph.define
  // -------------------------------------------------------------------------

  describe("graph.define", () => {
    it("validates and returns structure without calling coordinator", async () => {
      const result = await handlers["graph.define"]!({
        nodes: VALID_NODES,
        label: "Test Graph",
      });

      const r = result as Record<string, unknown>;
      expect(r.valid).toBe(true);
      expect(r.nodeCount).toBe(2);
      expect(r.executionOrder).toEqual(["a", "b"]);
      expect(r.label).toBe("Test Graph");
      expect(Array.isArray(r.warnings)).toBe(true);
      expect(Array.isArray(r.errors)).toBe(true);

      // Should NOT interact with coordinator
      expect(deps.graphCoordinator.run).not.toHaveBeenCalled();
    });

    it("throws on missing nodes", async () => {
      await expect(handlers["graph.define"]!({ label: "No Nodes" })).rejects.toThrow(
        "Missing required parameter: nodes",
      );
    });

    it("throws on invalid graph (cycle)", async () => {
      await expect(
        handlers["graph.define"]!({
          nodes: [
            { node_id: "a", task: "A", depends_on: ["b"] },
            { node_id: "b", task: "B", depends_on: ["a"] },
          ],
        }),
      ).rejects.toThrow("Graph validation failed");
    });

    it("includes userVariables for nodes with ${VAR} patterns", async () => {
      const result = await handlers["graph.define"]!({
        nodes: [
          { node_id: "a", task: "Analyze ${TICKER} for ${BRAND}" },
          { node_id: "b", task: "Report on ${TICKER}", depends_on: ["a"] },
        ],
      });

      const r = result as Record<string, unknown>;
      expect(r.userVariables).toEqual(["BRAND", "TICKER"]);
    });

    it("returns empty userVariables when no ${VAR} patterns exist", async () => {
      const result = await handlers["graph.define"]!({
        nodes: VALID_NODES,
      });

      const r = result as Record<string, unknown>;
      expect(r.userVariables).toEqual([]);
    });

    it("does NOT produce unresolved_variable warnings at define time", async () => {
      const result = await handlers["graph.define"]!({
        nodes: [
          { node_id: "a", task: "Analyze ${TICKER}" },
        ],
      });

      const r = result as Record<string, unknown>;
      const warnings = r.warnings as Array<{ type: string }>;
      const unresolvedVarWarnings = warnings.filter((w) => w.type === "unresolved_variable");
      expect(unresolvedVarWarnings).toHaveLength(0);
    });

    it("returns typed_node_agentid_ignored warning for typed node with agentId", async () => {
      const result = await handlers["graph.define"]!({
        nodes: [
          { node_id: "typed", task: "Run debate", type_id: "debate", type_config: { agents: ["a", "b"] }, agent: "extra" },
        ],
      });

      const r = result as Record<string, unknown>;
      const warnings = r.warnings as Array<{ type: string; nodeId: string }>;
      const typedWarnings = warnings.filter((w) => w.type === "typed_node_agentid_ignored");
      expect(typedWarnings).toHaveLength(1);
      expect(typedWarnings[0]!.nodeId).toBe("typed");
    });
  });

  // -------------------------------------------------------------------------
  // graph.execute
  // -------------------------------------------------------------------------

  describe("graph.execute", () => {
    it("calls coordinator.run with correct params", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.run.mockResolvedValue(ok("graph-uuid-123"));

      const result = await handlers["graph.execute"]!({
        nodes: VALID_NODES,
        label: "Exec Test",
        _callerSessionKey: "session-1",
        _agentId: "agent-1",
        _callerChannelType: "telegram",
        _callerChannelId: "chat-42",
      });

      const r = result as Record<string, unknown>;
      expect(r.graphId).toBe("graph-uuid-123");
      expect(r.async).toBe(true);
      expect(r.nodeCount).toBe(2);
      expect(r.label).toBe("Exec Test");

      expect(mockCoord.run).toHaveBeenCalledWith(
        expect.objectContaining({
          callerSessionKey: "session-1",
          callerAgentId: "agent-1",
          announceChannelType: "telegram",
          announceChannelId: "chat-42",
        }),
      );
    });

    it("throws when agentToAgent.enabled is false", async () => {
      deps = createDeps({ securityConfig: { agentToAgent: { enabled: false } } });
      handlers = createGraphHandlers(deps);

      await expect(
        handlers["graph.execute"]!({ nodes: VALID_NODES }),
      ).rejects.toThrow("Agent-to-agent messaging is disabled by policy.");
    });

    it("throws when agentToAgent is undefined", async () => {
      deps = createDeps({ securityConfig: {} });
      handlers = createGraphHandlers(deps);

      await expect(
        handlers["graph.execute"]!({ nodes: VALID_NODES }),
      ).rejects.toThrow("Agent-to-agent messaging is disabled by policy.");
    });

    it("throws when coordinator.run returns error", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.run.mockResolvedValue({ ok: false, error: "Too many active graphs" });

      await expect(
        handlers["graph.execute"]!({ nodes: VALID_NODES }),
      ).rejects.toThrow("Too many active graphs");
    });

    it("substitutes ${VAR} in node tasks before calling coordinator.run", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.run.mockResolvedValue(ok("graph-uuid-sub"));

      await handlers["graph.execute"]!({
        nodes: [
          { node_id: "a", task: "Analyze ${TICKER} stock" },
          { node_id: "b", task: "Report on ${TICKER}", depends_on: ["a"] },
        ],
        variables: { TICKER: "AAPL" },
      });

      const callArgs = mockCoord.run.mock.calls[0]![0] as { graph: { graph: { nodes: Array<{ task: string }> } } };
      const tasks = callArgs.graph.graph.nodes.map((n: { task: string }) => n.task);
      expect(tasks).toEqual(["Analyze AAPL stock", "Report on AAPL"]);
    });

    it("escapes {{template}} patterns in variable values", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.run.mockResolvedValue(ok("graph-uuid-esc"));

      await handlers["graph.execute"]!({
        nodes: [
          { node_id: "a", task: "Process ${INPUT}" },
        ],
        variables: { INPUT: "{{secret.result}}" },
      });

      const callArgs = mockCoord.run.mock.calls[0]![0] as { graph: { graph: { nodes: Array<{ task: string }> } } };
      const task = callArgs.graph.graph.nodes[0]!.task;
      // Should contain escaped braces (zero-width space), NOT literal {{secret.result}}
      const templateRe = /\{\{([\w-]+)\.result\}\}/g;
      expect(templateRe.test(task)).toBe(false);
      expect(task).toContain("{\u200B{secret.result}}");
    });

    it("returns unresolved_variable warnings for ${VAR} remaining after substitution", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.run.mockResolvedValue(ok("graph-uuid-warn"));

      const result = await handlers["graph.execute"]!({
        nodes: [
          { node_id: "a", task: "Use ${A} and ${MISSING}" },
        ],
        variables: { A: "val" },
      });

      const r = result as Record<string, unknown>;
      const warnings = r.warnings as Array<{ type: string; nodeId: string; message: string }>;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.type).toBe("unresolved_variable");
      expect(warnings[0]!.nodeId).toBe("a");
      expect(warnings[0]!.message).toContain("MISSING");
    });

    it("no unresolved_variable warnings when all variables are substituted", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.run.mockResolvedValue(ok("graph-uuid-clean"));

      const result = await handlers["graph.execute"]!({
        nodes: [
          { node_id: "a", task: "Use ${A}" },
        ],
        variables: { A: "val" },
      });

      const r = result as Record<string, unknown>;
      expect(r.warnings).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // graph.status
  // -------------------------------------------------------------------------

  describe("graph.status", () => {
    it("returns serialized snapshot with Map->Object conversion", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      const nodesMap = new Map<string, NodeExecutionState>([
        ["a", { nodeId: "a", status: "completed", output: "result-a", startedAt: 1000, completedAt: 2000 }],
        ["b", { nodeId: "b", status: "running", runId: "run-b", startedAt: 1500 }],
      ]);

      mockCoord.getStatus.mockReturnValue({
        graphStatus: "running",
        nodes: nodesMap,
        executionOrder: ["a", "b"],
        isTerminal: false,
      });

      const result = await handlers["graph.status"]!({ graphId: "graph-1" });
      const r = result as Record<string, unknown>;

      expect(r.graphId).toBe("graph-1");
      expect(r.status).toBe("running");
      expect(r.isTerminal).toBe(false);
      expect(r.executionOrder).toEqual(["a", "b"]);

      const nodes = r.nodes as Record<string, Record<string, unknown>>;
      expect(nodes["a"]!.status).toBe("completed");
      expect(nodes["a"]!.output).toBe("result-a");
      expect(nodes["a"]!.durationMs).toBe(1000);
      expect(nodes["b"]!.status).toBe("running");
      expect(nodes["b"]!.runId).toBe("run-b");
      expect(nodes["b"]!.durationMs).toBeUndefined();

      const stats = r.stats as Record<string, number>;
      expect(stats.total).toBe(2);
      expect(stats.completed).toBe(1);
      expect(stats.running).toBe(1);
      expect(stats.failed).toBe(0);
    });

    it("truncates output to 500 chars", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      const longOutput = "x".repeat(600);
      const nodesMap = new Map<string, NodeExecutionState>([
        ["a", { nodeId: "a", status: "completed", output: longOutput, startedAt: 1000, completedAt: 2000 }],
      ]);

      mockCoord.getStatus.mockReturnValue({
        graphStatus: "completed",
        nodes: nodesMap,
        executionOrder: ["a"],
        isTerminal: true,
      });

      const result = await handlers["graph.status"]!({ graphId: "graph-1" });
      const r = result as Record<string, unknown>;
      const nodes = r.nodes as Record<string, Record<string, unknown>>;
      const output = nodes["a"]!.output as string;

      expect(output.length).toBe(500 + "... [truncated]".length);
      expect(output.endsWith("... [truncated]")).toBe(true);
    });

    it("returns list from listGraphs without graphId", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      const summaries = [
        { graphId: "g-1", status: "completed", startedAt: 1000, completedAt: 2000 },
        { graphId: "g-2", status: "running", startedAt: 1500 },
      ];
      mockCoord.listGraphs.mockReturnValue(summaries);

      const result = await handlers["graph.status"]!({ recentMinutes: 10 });
      const r = result as Record<string, unknown>;

      expect(r.graphs).toEqual(summaries);
      expect(mockCoord.listGraphs).toHaveBeenCalledWith(10);
    });

    it("throws when graph not found", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.getStatus.mockReturnValue(undefined);

      await expect(
        handlers["graph.status"]!({ graphId: "non-existent" }),
      ).rejects.toThrow("Graph not found");
    });

    it("accepts graph_id (snake_case) as well as graphId", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      const nodesMap = new Map<string, NodeExecutionState>([
        ["a", { nodeId: "a", status: "completed", startedAt: 100, completedAt: 200 }],
      ]);
      mockCoord.getStatus.mockReturnValue({
        graphStatus: "completed",
        nodes: nodesMap,
        executionOrder: ["a"],
        isTerminal: true,
      });

      const result = await handlers["graph.status"]!({ graph_id: "graph-snake" });
      const r = result as Record<string, unknown>;
      expect(r.graphId).toBe("graph-snake");
      expect(mockCoord.getStatus).toHaveBeenCalledWith("graph-snake");
    });
  });

  // -------------------------------------------------------------------------
  // graph.cancel
  // -------------------------------------------------------------------------

  describe("graph.cancel", () => {
    it("calls coordinator.cancel and returns result", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.cancel.mockReturnValue(true);

      const result = await handlers["graph.cancel"]!({ graphId: "graph-1" });
      const r = result as Record<string, unknown>;

      expect(r.cancelled).toBe(true);
      expect(r.graphId).toBe("graph-1");
      expect(mockCoord.cancel).toHaveBeenCalledWith("graph-1");
    });

    it("throws when agentToAgent disabled", async () => {
      deps = createDeps({ securityConfig: { agentToAgent: { enabled: false } } });
      handlers = createGraphHandlers(deps);

      await expect(
        handlers["graph.cancel"]!({ graphId: "graph-1" }),
      ).rejects.toThrow("Agent-to-agent messaging is disabled by policy.");
    });

    it("throws when graph not found (cancel returns false)", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.cancel.mockReturnValue(false);

      await expect(
        handlers["graph.cancel"]!({ graphId: "graph-1" }),
      ).rejects.toThrow("Graph not found or already terminal");
    });

    it("throws when graphId is missing", async () => {
      await expect(
        handlers["graph.cancel"]!({}),
      ).rejects.toThrow("Missing required parameter: graphId");
    });
  });

  // -------------------------------------------------------------------------
  // validateGraphWarnings
  // -------------------------------------------------------------------------

  describe("validateGraphWarnings", () => {
    it("returns empty warnings for a clean two-node graph", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", agentId: "x", dependsOn: [], barrierMode: "all" },
          { nodeId: "b", task: "Do B", agentId: "x", dependsOn: ["a"], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      expect(result.warnings).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("warns on orphan node in multi-node graph", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", agentId: "x", dependsOn: [], barrierMode: "all" },
          { nodeId: "b", task: "Do B", agentId: "x", dependsOn: ["a"], barrierMode: "all" },
          { nodeId: "c", task: "Do C", agentId: "x", dependsOn: [], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      const orphanWarnings = result.warnings.filter((w) => w.type === "orphan_node");
      expect(orphanWarnings).toHaveLength(1);
      expect(orphanWarnings[0].nodeId).toBe("c");
    });

    it("does not warn on orphan for single-node graph", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", dependsOn: [], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      const orphanWarnings = result.warnings.filter((w) => w.type === "orphan_node");
      expect(orphanWarnings).toHaveLength(0);
    });

    it("warns on barrier mode with 0 or 1 dependencies", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", agentId: "x", dependsOn: [], barrierMode: "all" },
          {
            nodeId: "b",
            task: "Do B",
            agentId: "x",
            dependsOn: ["a"],
            barrierMode: "majority",
          },
        ],
        onFailure: "fail-fast",
      });

      const barrierWarnings = result.warnings.filter((w) => w.type === "barrier_mode_low_deps");
      expect(barrierWarnings).toHaveLength(1);
      expect(barrierWarnings[0].nodeId).toBe("b");
      expect(barrierWarnings[0].message).toContain("majority");
      expect(barrierWarnings[0].message).toContain("1 dependency");
    });

    it("does not warn on barrier mode with 2+ dependencies", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", agentId: "x", dependsOn: [], barrierMode: "all" },
          { nodeId: "b", task: "Do B", agentId: "x", dependsOn: [], barrierMode: "all" },
          {
            nodeId: "c",
            task: "Do C",
            agentId: "x",
            dependsOn: ["a", "b"],
            barrierMode: "majority",
          },
        ],
        onFailure: "fail-fast",
      });

      const barrierWarnings = result.warnings.filter((w) => w.type === "barrier_mode_low_deps");
      expect(barrierWarnings).toHaveLength(0);
    });

    it("warns on missing agentId when typeId also absent", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", dependsOn: [], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      const agentWarnings = result.warnings.filter((w) => w.type === "no_agent_id");
      expect(agentWarnings).toHaveLength(1);
      expect(agentWarnings[0].nodeId).toBe("a");
    });

    it("does not warn on missing agentId when agentId present", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", agentId: "x", dependsOn: [], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      const agentWarnings = result.warnings.filter((w) => w.type === "no_agent_id");
      expect(agentWarnings).toHaveLength(0);
    });

    it("does not warn on missing agentId when typeId is present", () => {
      const result = validateGraphWarnings({
        nodes: [
          {
            nodeId: "typed",
            task: "Run debate",
            dependsOn: [],
            barrierMode: "all" as const,
            typeId: "debate" as const,
            typeConfig: { agents: ["a", "b"] },
          },
        ],
        onFailure: "fail-fast",
      });

      const agentWarnings = result.warnings.filter((w) => w.type === "no_agent_id");
      expect(agentWarnings).toHaveLength(0);
    });

    it("returns errors as empty array always", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", agentId: "x", dependsOn: [], barrierMode: "all" },
          { nodeId: "b", task: "Do B", agentId: "x", dependsOn: ["a"], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      expect(result.errors).toEqual([]);
    });

    it("no warning when {{nodeId.result}} references a node in dependsOn", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "analyzer", task: "Analyze data", agentId: "x", dependsOn: [], barrierMode: "all" },
          { nodeId: "reporter", task: "Report on {{analyzer.result}}", agentId: "x", dependsOn: ["analyzer"], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      const templateWarnings = result.warnings.filter((w) => w.type === "unresolved_template");
      expect(templateWarnings).toHaveLength(0);
    });

    it("warns when {{nodeId.result}} references a node NOT in dependsOn", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "analyzer", task: "Analyze data", agentId: "x", dependsOn: [], barrierMode: "all" },
          { nodeId: "reporter", task: "Report on {{analyzer.result}}", agentId: "x", dependsOn: [], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      const templateWarnings = result.warnings.filter((w) => w.type === "unresolved_template");
      expect(templateWarnings).toHaveLength(1);
      expect(templateWarnings[0]!.nodeId).toBe("reporter");
      expect(templateWarnings[0]!.message).toContain("analyzer");
      expect(templateWarnings[0]!.message).toContain("not in its dependsOn");
      expect(templateWarnings[0]!.fix).toContain("Add");
    });

    it("handles hyphenated nodeIds in templates ({{step-1.result}})", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "step-1", task: "Step one", agentId: "x", dependsOn: [], barrierMode: "all" },
          { nodeId: "step-2", task: "Continue from {{step-1.result}}", agentId: "x", dependsOn: ["step-1"], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      const templateWarnings = result.warnings.filter((w) => w.type === "unresolved_template");
      expect(templateWarnings).toHaveLength(0);
    });

    it("no unresolved_template warning when task has no templates", () => {
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Plain task with no templates", agentId: "x", dependsOn: [], barrierMode: "all" },
        ],
        onFailure: "fail-fast",
      });

      const templateWarnings = result.warnings.filter((w) => w.type === "unresolved_template");
      expect(templateWarnings).toHaveLength(0);
    });

    it("returns typed_node_agentid_ignored warning when typeId and agentId both set", () => {
      const result = validateGraphWarnings({
        nodes: [
          {
            nodeId: "mixed",
            task: "Discuss",
            agentId: "extra",
            dependsOn: [],
            barrierMode: "all" as const,
            typeId: "debate" as const,
            typeConfig: { agents: ["a", "b"] },
          },
        ],
        onFailure: "fail-fast",
      });

      const ignoredWarnings = result.warnings.filter((w) => w.type === "typed_node_agentid_ignored");
      expect(ignoredWarnings).toHaveLength(1);
      expect(ignoredWarnings[0]!.nodeId).toBe("mixed");
      expect(ignoredWarnings[0]!.message).toContain("agentId is ignored");
    });

    it("returns typed_node_expensive_retry warning for typed node with retries", () => {
      const result = validateGraphWarnings({
        nodes: [
          {
            nodeId: "retry-debate",
            task: "Discuss",
            dependsOn: [],
            barrierMode: "all" as const,
            retries: 2,
            typeId: "debate" as const,
            typeConfig: { agents: ["a", "b"] },
          },
        ],
        onFailure: "fail-fast",
      });

      const retryWarnings = result.warnings.filter((w) => w.type === "typed_node_expensive_retry");
      expect(retryWarnings).toHaveLength(1);
      expect(retryWarnings[0]!.nodeId).toBe("retry-debate");
      expect(retryWarnings[0]!.message).toContain("retries=2");
    });

    it("returns typed_node_approval_retry warning for approval-gate with retries", () => {
      const result = validateGraphWarnings({
        nodes: [
          {
            nodeId: "gate",
            task: "Approve",
            dependsOn: [],
            barrierMode: "all" as const,
            retries: 1,
            typeId: "approval-gate" as const,
            typeConfig: { message: "Approve?" },
          },
        ],
        onFailure: "fail-fast",
      });

      const approvalWarnings = result.warnings.filter((w) => w.type === "typed_node_approval_retry");
      expect(approvalWarnings).toHaveLength(1);
      expect(approvalWarnings[0]!.nodeId).toBe("gate");
      expect(approvalWarnings[0]!.message).toContain("re-prompt the user");
    });

    it("no typed-node warnings for valid typed node (typeId set, no agentId, no retries)", () => {
      const result = validateGraphWarnings({
        nodes: [
          {
            nodeId: "clean-typed",
            task: "Vote",
            dependsOn: [],
            barrierMode: "all" as const,
            typeId: "vote" as const,
            typeConfig: { voters: ["a", "b", "c"] },
          },
        ],
        onFailure: "fail-fast",
      });

      const typedWarnings = result.warnings.filter(
        (w) => w.type === "typed_node_agentid_ignored" ||
               w.type === "typed_node_expensive_retry" ||
               w.type === "typed_node_approval_retry",
      );
      expect(typedWarnings).toHaveLength(0);
    });

    it("warns on information bottleneck in linear chain", () => {
      // 4 analysts -> debate (depends on a,b,c,d) -> trader (depends only on debate)
      // trader loses access to a,b,c,d
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Analyze A", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "b", task: "Analyze B", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "c", task: "Analyze C", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "d", task: "Analyze D", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "debate", task: "Debate results", agentId: "x", dependsOn: ["a", "b", "c", "d"], barrierMode: "all" as const },
          { nodeId: "trader", task: "Make trade", agentId: "x", dependsOn: ["debate"], barrierMode: "all" as const },
        ],
        onFailure: "fail-fast",
      });

      const bottleneckWarnings = result.warnings.filter((w) => w.type === "information_bottleneck");
      expect(bottleneckWarnings).toHaveLength(1);
      expect(bottleneckWarnings[0]!.nodeId).toBe("trader");
      expect(bottleneckWarnings[0]!.message).toContain("4 upstream node(s)");
      // All 4 analysts should be listed as lost
      expect(bottleneckWarnings[0]!.message).toContain("a");
      expect(bottleneckWarnings[0]!.message).toContain("b");
      expect(bottleneckWarnings[0]!.message).toContain("c");
      expect(bottleneckWarnings[0]!.message).toContain("d");
      expect(bottleneckWarnings[0]!.fix).toContain('"a"');
      expect(bottleneckWarnings[0]!.fix).toContain('"d"');
    });

    it("no bottleneck warning when downstream lists all upstream", () => {
      // Same structure but trader depends on [debate, a, b, c, d]
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Analyze A", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "b", task: "Analyze B", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "c", task: "Analyze C", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "d", task: "Analyze D", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "debate", task: "Debate results", agentId: "x", dependsOn: ["a", "b", "c", "d"], barrierMode: "all" as const },
          { nodeId: "trader", task: "Make trade", agentId: "x", dependsOn: ["debate", "a", "b", "c", "d"], barrierMode: "all" as const },
        ],
        onFailure: "fail-fast",
      });

      const bottleneckWarnings = result.warnings.filter((w) => w.type === "information_bottleneck");
      expect(bottleneckWarnings).toHaveLength(0);
    });

    it("no bottleneck warning for simple two-node chain", () => {
      // a -> b: b's dep a has no upstream to lose
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "b", task: "Do B", agentId: "x", dependsOn: ["a"], barrierMode: "all" as const },
        ],
        onFailure: "fail-fast",
      });

      const bottleneckWarnings = result.warnings.filter((w) => w.type === "information_bottleneck");
      expect(bottleneckWarnings).toHaveLength(0);
    });

    it("deduplicates when multiple deps share the same lost upstream", () => {
      // a,b,c,d -> bull (depends on a,b,c,d), bear (depends on a,b,c,d) -> trader (depends on bull,bear)
      // trader loses a,b,c,d via BOTH bull and bear, but should emit only ONE warning
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "A", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "b", task: "B", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "c", task: "C", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "d", task: "D", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "bull", task: "Bull", agentId: "x", dependsOn: ["a", "b", "c", "d"], barrierMode: "all" as const },
          { nodeId: "bear", task: "Bear", agentId: "x", dependsOn: ["a", "b", "c", "d"], barrierMode: "all" as const },
          { nodeId: "trader", task: "Trade", agentId: "x", dependsOn: ["bull", "bear"], barrierMode: "all" as const },
        ],
        onFailure: "fail-fast",
      });

      const bottleneckWarnings = result.warnings.filter((w) => w.type === "information_bottleneck");
      // ONE deduplicated warning for trader, not two
      expect(bottleneckWarnings).toHaveLength(1);
      expect(bottleneckWarnings[0]!.nodeId).toBe("trader");
      expect(bottleneckWarnings[0]!.message).toContain("4 upstream node(s)");
      expect(bottleneckWarnings[0]!.fix).toContain('"a"');
      expect(bottleneckWarnings[0]!.fix).toContain('"d"');
    });

    it("partial bottleneck warns only for missing upstreams", () => {
      // a, b -> c (depends on a, b) -> d (depends on c, a)
      // d has a in its reachable set (direct dep) but not b — warn only about b
      const result = validateGraphWarnings({
        nodes: [
          { nodeId: "a", task: "Do A", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "b", task: "Do B", agentId: "x", dependsOn: [], barrierMode: "all" as const },
          { nodeId: "c", task: "Do C", agentId: "x", dependsOn: ["a", "b"], barrierMode: "all" as const },
          { nodeId: "d", task: "Do D", agentId: "x", dependsOn: ["c", "a"], barrierMode: "all" as const },
        ],
        onFailure: "fail-fast",
      });

      const bottleneckWarnings = result.warnings.filter((w) => w.type === "information_bottleneck");
      expect(bottleneckWarnings).toHaveLength(1);
      expect(bottleneckWarnings[0]!.nodeId).toBe("d");
      expect(bottleneckWarnings[0]!.message).toContain("1 upstream node(s)");
      expect(bottleneckWarnings[0]!.message).toContain("b");
      // Should NOT mention "a" since d already depends on a
      expect(bottleneckWarnings[0]!.fix).toContain('"b"');
      expect(bottleneckWarnings[0]!.fix).not.toContain('"a"');
    });
  });

  // -------------------------------------------------------------------------
  // graph.outputs
  // -------------------------------------------------------------------------

  describe("graph.outputs", () => {
    it("returns outputs from in-memory snapshot", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      const nodesMap = new Map<string, NodeExecutionState>([
        ["a", { nodeId: "a", status: "completed", output: "result-a", startedAt: 1000, completedAt: 2000 }],
        ["b", { nodeId: "b", status: "completed", output: "result-b", startedAt: 1500, completedAt: 2500 }],
      ]);

      mockCoord.getStatus.mockReturnValue({
        graphStatus: "completed",
        nodes: nodesMap,
        executionOrder: ["a", "b"],
        isTerminal: true,
      });

      const result = await handlers["graph.outputs"]!({ graphId: "graph-1" });
      const r = result as Record<string, unknown>;

      expect(r.graphId).toBe("graph-1");
      expect(r.source).toBe("memory");
      expect(r.outputs).toEqual({ a: "result-a", b: "result-b" });
    });

    it("returns null for nodes without output", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      const nodesMap = new Map<string, NodeExecutionState>([
        ["a", { nodeId: "a", status: "completed", output: "result-a", startedAt: 1000, completedAt: 2000 }],
        ["b", { nodeId: "b", status: "running", startedAt: 1500 }],
      ]);

      mockCoord.getStatus.mockReturnValue({
        graphStatus: "running",
        nodes: nodesMap,
        executionOrder: ["a", "b"],
        isTerminal: false,
      });

      const result = await handlers["graph.outputs"]!({ graphId: "graph-2" });
      const r = result as Record<string, unknown>;
      const outputs = r.outputs as Record<string, string | null>;

      expect(outputs.a).toBe("result-a");
      expect(outputs.b).toBeNull();
    });

    it("truncates outputs exceeding 12000 chars", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      const longOutput = "x".repeat(13000);
      const nodesMap = new Map<string, NodeExecutionState>([
        ["a", { nodeId: "a", status: "completed", output: longOutput, startedAt: 1000, completedAt: 2000 }],
      ]);

      mockCoord.getStatus.mockReturnValue({
        graphStatus: "completed",
        nodes: nodesMap,
        executionOrder: ["a"],
        isTerminal: true,
      });

      const result = await handlers["graph.outputs"]!({ graphId: "graph-3" });
      const r = result as Record<string, unknown>;
      const outputs = r.outputs as Record<string, string | null>;

      expect(outputs.a!.length).toBe(12000 + "... [truncated]".length);
      expect(outputs.a!.endsWith("... [truncated]")).toBe(true);
    });

    it("throws when graphId is missing", async () => {
      await expect(
        handlers["graph.outputs"]!({}),
      ).rejects.toThrow("Missing required parameter: graphId");
    });

    it("throws when graph not found and no dataDir", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.getStatus.mockReturnValue(undefined);
      mockCoord.listGraphs.mockReturnValue([]);

      await expect(
        handlers["graph.outputs"]!({ graphId: "non-existent" }),
      ).rejects.toThrow("Graph not found (no in-memory snapshot and no dataDir configured)");
    });

    it("resolves label to graphId via listGraphs fallback", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;

      // First call with "my-pipeline" (the label) -- no in-memory snapshot
      // Second call with "uuid-123" (the resolved UUID) -- has in-memory snapshot
      const nodesMap = new Map<string, import("@comis/core").NodeExecutionState>([
        ["a", { nodeId: "a", status: "completed", output: "result-a", startedAt: 1000, completedAt: 2000 }],
      ]);
      mockCoord.getStatus
        .mockReturnValueOnce(undefined) // "my-pipeline" not found
        .mockReturnValueOnce({          // "uuid-123" found
          graphStatus: "completed",
          nodes: nodesMap,
          executionOrder: ["a"],
          isTerminal: true,
        });
      mockCoord.listGraphs.mockReturnValue([
        { graphId: "uuid-123", label: "my-pipeline", status: "completed", startedAt: 1000 },
      ]);

      // Set dataDir to a temp path where the graph dir does not exist
      deps = createDeps({ dataDir: "/tmp/test-graph-outputs-label" });
      handlers = createGraphHandlers(deps);
      (deps.graphCoordinator as ReturnType<typeof createMockCoordinator>).getStatus = mockCoord.getStatus;
      (deps.graphCoordinator as ReturnType<typeof createMockCoordinator>).listGraphs = mockCoord.listGraphs;

      const result = await handlers["graph.outputs"]!({ graphId: "my-pipeline" }) as Record<string, unknown>;
      expect(result.graphId).toBe("uuid-123");
      expect(result.source).toBe("memory");
      expect(result.outputs).toEqual({ a: "result-a" });
    });

    it("resolves label case-insensitively", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;

      const nodesMap = new Map<string, import("@comis/core").NodeExecutionState>([
        ["a", { nodeId: "a", status: "completed", output: "ok", startedAt: 1000, completedAt: 2000 }],
      ]);
      mockCoord.getStatus
        .mockReturnValueOnce(undefined) // "MY-PIPELINE" not found
        .mockReturnValueOnce({          // "uuid-456" found
          graphStatus: "completed",
          nodes: nodesMap,
          executionOrder: ["a"],
          isTerminal: true,
        });
      mockCoord.listGraphs.mockReturnValue([
        { graphId: "uuid-456", label: "my-pipeline", status: "completed", startedAt: 1000 },
      ]);

      deps = createDeps({ dataDir: "/tmp/test-graph-outputs-case" });
      handlers = createGraphHandlers(deps);
      (deps.graphCoordinator as ReturnType<typeof createMockCoordinator>).getStatus = mockCoord.getStatus;
      (deps.graphCoordinator as ReturnType<typeof createMockCoordinator>).listGraphs = mockCoord.listGraphs;

      const result = await handlers["graph.outputs"]!({ graphId: "MY-PIPELINE" }) as Record<string, unknown>;
      expect(result.graphId).toBe("uuid-456");
      expect(result.source).toBe("memory");
    });

    it("throws when label also not found", async () => {
      const mockCoord = deps.graphCoordinator as ReturnType<typeof createMockCoordinator>;
      mockCoord.getStatus.mockReturnValue(undefined);
      mockCoord.listGraphs.mockReturnValue([]);

      deps = createDeps({ dataDir: "/tmp/test-graph-outputs-notfound" });
      handlers = createGraphHandlers(deps);
      (deps.graphCoordinator as ReturnType<typeof createMockCoordinator>).getStatus = mockCoord.getStatus;
      (deps.graphCoordinator as ReturnType<typeof createMockCoordinator>).listGraphs = mockCoord.listGraphs;

      await expect(
        handlers["graph.outputs"]!({ graphId: "no-such-label" }),
      ).rejects.toThrow("Graph not found");
    });
  });

  // -------------------------------------------------------------------------
  // graph.load migration strip
  // -------------------------------------------------------------------------

  describe("graph.load migration strip", () => {
    it("strips inputFrom and inputMapping from persisted graph data", async () => {
      const mockStore = {
        save: vi.fn(),
        load: vi.fn().mockReturnValue({
          id: "g-1",
          tenantId: "default",
          label: "legacy",
          nodes: [
            { nodeId: "a", task: "Do A", inputFrom: { b: "result" }, input_from: { b: "result" } },
            { nodeId: "b", task: "Do B" },
          ],
          edges: [
            { id: "a->b", source: "a", target: "b", inputMapping: "data", input_mapping: "data" },
          ],
        }),
        list: vi.fn(),
        softDelete: vi.fn(),
      };
      deps = createDeps({ namedGraphStore: mockStore as unknown as GraphHandlerDeps["namedGraphStore"] });
      handlers = createGraphHandlers(deps);

      const result = await handlers["graph.load"]!({ id: "g-1" }) as Record<string, unknown>;

      // Nodes should not have inputFrom or input_from
      const nodes = result.nodes as Record<string, unknown>[];
      expect(nodes[0]).not.toHaveProperty("inputFrom");
      expect(nodes[0]).not.toHaveProperty("input_from");
      expect(nodes[0]).toMatchObject({ nodeId: "a", task: "Do A" });
      expect(nodes[1]).toMatchObject({ nodeId: "b", task: "Do B" });

      // Edges should not have inputMapping or input_mapping
      const edges = result.edges as Record<string, unknown>[];
      expect(edges[0]).not.toHaveProperty("inputMapping");
      expect(edges[0]).not.toHaveProperty("input_mapping");
      expect(edges[0]).toMatchObject({ id: "a->b", source: "a", target: "b" });
    });
  });

  // -------------------------------------------------------------------------
  // graph.save validation
  // -------------------------------------------------------------------------

  describe("graph.save validation", () => {
    const mockStore = {
      save: vi.fn(),
      load: vi.fn(),
      list: vi.fn(),
      softDelete: vi.fn(),
    };

    let saveHandlers: ReturnType<typeof createGraphHandlers>;

    beforeEach(() => {
      mockStore.save.mockReset();
      mockStore.load.mockReset();
      mockStore.list.mockReset();
      mockStore.softDelete.mockReset();
      saveHandlers = createGraphHandlers(
        createDeps({ namedGraphStore: mockStore as unknown as GraphHandlerDeps["namedGraphStore"] }),
      );
    });

    it("rejects nodes with type_id but missing type_config", async () => {
      await expect(
        saveHandlers["graph.save"]!({
          label: "bad",
          nodes: [{ node_id: "a", task: "Do A", type_id: "agent" }],
        }),
      ).rejects.toThrow(/Graph validation failed/);

      expect(mockStore.save).not.toHaveBeenCalled();
    });

    it("rejects nodes with type_config but missing type_id", async () => {
      await expect(
        saveHandlers["graph.save"]!({
          label: "bad",
          nodes: [{ node_id: "a", task: "Do A", type_config: { agent: "x" } }],
        }),
      ).rejects.toThrow(/Graph validation failed/);

      expect(mockStore.save).not.toHaveBeenCalled();
    });

    it("accepts valid typed nodes", async () => {
      const result = await saveHandlers["graph.save"]!({
        label: "good",
        nodes: [{ node_id: "a", task: "Do A", type_id: "agent", type_config: { agent: "x" } }],
      });

      const r = result as Record<string, unknown>;
      expect(r).toMatchObject({ id: expect.any(String), saved: true });
      expect(mockStore.save).toHaveBeenCalledOnce();
    });

    it("accepts plain nodes without type fields", async () => {
      const result = await saveHandlers["graph.save"]!({
        label: "plain",
        nodes: [{ node_id: "a", task: "Do A" }],
      });

      const r = result as Record<string, unknown>;
      expect(r).toMatchObject({ id: expect.any(String), saved: true });
      expect(mockStore.save).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // schemaToExample
  // -------------------------------------------------------------------------

  describe("schemaToExample", () => {
    it("returns 'string' for z.string() field", () => {
      const result = schemaToExample(z.strictObject({ name: z.string() }));
      expect(result).toEqual({ name: "string" });
    });

    it("returns 'number' for z.number() field", () => {
      const result = schemaToExample(z.strictObject({ count: z.number() }));
      expect(result).toEqual({ count: "number" });
    });

    it("returns 'boolean' for z.boolean() field", () => {
      const result = schemaToExample(z.strictObject({ active: z.boolean() }));
      expect(result).toEqual({ active: "boolean" });
    });

    it("returns 'array' for z.array() field", () => {
      const result = schemaToExample(z.strictObject({ items: z.array(z.string()) }));
      expect(result).toEqual({ items: "array" });
    });

    it("returns 'object' for nested z.strictObject() field", () => {
      const result = schemaToExample(z.strictObject({ meta: z.strictObject({ x: z.string() }) }));
      expect(result).toEqual({ meta: "object" });
    });

    it("returns 'string (optional)' for z.string().optional() field", () => {
      const result = schemaToExample(z.strictObject({ opt: z.string().optional() }));
      expect(result).toEqual({ opt: "string (optional)" });
    });

    it("returns inner type for z.number().default() without '(optional)' suffix", () => {
      const result = schemaToExample(z.strictObject({ val: z.number().default(5) }));
      expect(result).toEqual({ val: "number" });
    });

    it("uses description when present on field", () => {
      const result = schemaToExample(z.strictObject({ name: z.string().describe("Agent name to use") }));
      expect(result).toEqual({ name: "Agent name to use" });
    });

    it("maps agent driver configSchema to correct type hints", () => {
      const driver = createAgentDriver();
      const result = schemaToExample(driver.configSchema);
      expect(result).toEqual({
        agent: "string",
        model: "string (optional)",
        max_steps: "number (optional)",
      });
    });

    it("maps debate driver configSchema to correct type hints", () => {
      const driver = createDebateDriver();
      const result = schemaToExample(driver.configSchema);
      expect(result).toHaveProperty("agents", "array");
      expect(result).toHaveProperty("rounds", "number");
      expect(result).toHaveProperty("synthesizer", "string (optional)");
    });
  });

  // -------------------------------------------------------------------------
  // transformNodes migration completeness (gap cases)
  // -------------------------------------------------------------------------

  describe("transformNodes migration completeness", () => {
    it("empty agents array in debate removes debate field, preserves agentId", () => {
      const result = transformNodes([
        { node_id: "empty", task: "Topic", agent: "fallback", debate: { agents: [] } },
      ]);

      // Empty agents (length < 2) downgrades to regular node
      expect(result[0]).not.toHaveProperty("typeId");
      expect(result[0]).not.toHaveProperty("typeConfig");
      expect(result[0]).not.toHaveProperty("debate");
      // agents[0] is undefined, so agentId falls back to the original
      expect((result[0] as Record<string, unknown>).agentId).toBe("fallback");
    });

    it("default rounds applied when debate has agents but no explicit rounds", () => {
      const result = transformNodes([
        { node_id: "no-rounds", task: "Discuss", debate: { agents: ["a", "b"] } },
      ]);

      expect(result[0]).toMatchObject({
        nodeId: "no-rounds",
        typeId: "debate",
        typeConfig: { agents: ["a", "b"], rounds: 2 },
      });
    });
  });

  // -------------------------------------------------------------------------
  // validateGraphWarnings negative case (gap)
  // -------------------------------------------------------------------------

  describe("validateGraphWarnings regular node retries", () => {
    it("regular node with retries does NOT produce typed_node_expensive_retry", () => {
      const result = validateGraphWarnings({
        nodes: [
          {
            nodeId: "regular-retry",
            task: "Do something",
            agentId: "agent-x",
            dependsOn: [],
            barrierMode: "all" as const,
            retries: 2,
          },
        ],
        onFailure: "fail-fast",
      });

      const typedRetryWarnings = result.warnings.filter((w) => w.type === "typed_node_expensive_retry");
      expect(typedRetryWarnings).toHaveLength(0);
    });
  });
});
