// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pipeline multi-action tool.
 *
 * Covers all 8 actions (define, execute, status, cancel, save, load, list, delete),
 * parameter transformation (snake_case -> camelCase), cancel/delete gating,
 * error handling, and default action behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPipelineTool } from "./pipeline-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRpcCall() {
  return vi.fn<[string, Record<string, unknown>], Promise<unknown>>().mockResolvedValue({ ok: true });
}

function sampleNodes() {
  return [
    { node_id: "a", task: "Do A", depends_on: [], timeout_ms: 5000, max_steps: 10 },
    { node_id: "b", task: "Do B", depends_on: ["a"], agent: "helper", model: "fast" },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPipelineTool", () => {
  let rpcCall: ReturnType<typeof mockRpcCall>;

  beforeEach(() => {
    rpcCall = mockRpcCall();
  });

  it("has correct metadata", () => {
    const tool = createPipelineTool(rpcCall);
    expect(tool.name).toBe("pipeline");
    expect(tool.label).toBe("Pipeline");
    expect(tool.description).toContain("execution graphs");
  });

  // -----------------------------------------------------------------------
  // Default action
  // -----------------------------------------------------------------------

  it("defaults to execute action when no action specified", async () => {
    const tool = createPipelineTool(rpcCall);
    const nodes = [{ node_id: "a", task: "Run" }];
    await tool.execute("tc1", { nodes } as never);
    expect(rpcCall).toHaveBeenCalledWith("graph.execute", expect.objectContaining({
      nodes: [{ nodeId: "a", task: "Run" }],
    }));
  });

  // -----------------------------------------------------------------------
  // Define action
  // -----------------------------------------------------------------------

  describe("define action", () => {
    it("calls graph.define with transformed nodes", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ graphId: "g1", valid: true });

      const result = await tool.execute("tc2", {
        action: "define",
        nodes: sampleNodes(),
        label: "test-graph",
        on_failure: "continue",
        timeout_ms: 30000,
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.define", {
        nodes: [
          { nodeId: "a", task: "Do A", dependsOn: [], timeoutMs: 5000, maxSteps: 10 },
          { nodeId: "b", task: "Do B", dependsOn: ["a"], agent: "helper", model: "fast" },
        ],
        label: "test-graph",
        onFailure: "continue",
        timeoutMs: 30000,
      });

      expect(result.details).toEqual({ graphId: "g1", valid: true });
    });

    it("throws when nodes missing", async () => {
      const tool = createPipelineTool(rpcCall);
      await expect(
        tool.execute("tc3", { action: "define" } as never),
      ).rejects.toThrow(/Missing required parameter: nodes/);
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("throws when nodes array is empty", async () => {
      const tool = createPipelineTool(rpcCall);
      await expect(
        tool.execute("tc3b", { action: "define", nodes: [] } as never),
      ).rejects.toThrow(/Missing required parameter: nodes/);
    });
  });

  // -----------------------------------------------------------------------
  // Execute action
  // -----------------------------------------------------------------------

  describe("execute action", () => {
    it("calls graph.execute with transformed nodes", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ graphId: "g2", status: "running" });

      const result = await tool.execute("tc4", {
        action: "execute",
        nodes: [{ node_id: "x", task: "Process" }],
        label: "run-1",
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.execute", {
        nodes: [{ nodeId: "x", task: "Process" }],
        label: "run-1",
        node_progress: false,
      });

      expect(result.details).toEqual({ graphId: "g2", status: "running" });
    });

    it("throws when nodes missing for execute", async () => {
      const tool = createPipelineTool(rpcCall);
      await expect(
        tool.execute("tc5", { action: "execute" } as never),
      ).rejects.toThrow(/Missing required parameter: nodes/);
    });
  });

  // -----------------------------------------------------------------------
  // Status action
  // -----------------------------------------------------------------------

  describe("status action", () => {
    it("calls graph.status with graphId", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ graphId: "g1", status: "completed" });

      const result = await tool.execute("tc6", {
        action: "status",
        graph_id: "g1",
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.status", { graphId: "g1" });
      expect(result.details).toEqual({ graphId: "g1", status: "completed" });
    });

    it("calls graph.status with recentMinutes", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ graphs: [] });

      await tool.execute("tc7", {
        action: "status",
        recent_minutes: 60,
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.status", { recentMinutes: 60 });
    });

    it("calls graph.status with no params for listing all", async () => {
      const tool = createPipelineTool(rpcCall);
      await tool.execute("tc7b", { action: "status" } as never);
      expect(rpcCall).toHaveBeenCalledWith("graph.status", {});
    });
  });

  // -----------------------------------------------------------------------
  // Cancel action
  // -----------------------------------------------------------------------

  describe("cancel action", () => {
    it("gates cancel action (requires confirmation with hint)", async () => {
      const tool = createPipelineTool(rpcCall);

      const result = await tool.execute("tc8", {
        action: "cancel",
        graph_id: "g1",
      } as never);

      // graph.cancel is classified as destructive -> requires confirmation
      expect(result.details).toMatchObject({
        requiresConfirmation: true,
        actionType: "graph.cancel",
        hint: expect.stringContaining("_confirmed: true"),
      });
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("bypasses gate when _confirmed is true", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ cancelled: true });

      const result = await tool.execute("tc9", {
        action: "cancel",
        graph_id: "g1",
        _confirmed: true,
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.cancel", { graphId: "g1" });
      expect(result.details).toEqual({ cancelled: true });
    });

    it("cancel hint instructs re-call with _confirmed: true", async () => {
      const tool = createPipelineTool(rpcCall);

      const result = await tool.execute("tc8b", {
        action: "cancel",
        graph_id: "g1",
      } as never);

      const details = result.details as Record<string, unknown>;
      expect(details.hint).toBeDefined();
      expect(typeof details.hint).toBe("string");
      expect(details.hint).toContain("_confirmed: true");
      expect(details.hint).toContain("cancellation");
    });
  });

  // -----------------------------------------------------------------------
  // Snake_case -> camelCase transformation
  // -----------------------------------------------------------------------

  describe("parameter transformation", () => {
    it("transforms all snake_case node fields to camelCase", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc10", {
        action: "define",
        nodes: [{
          node_id: "n1",
          task: "test",
          depends_on: ["n0"],
          timeout_ms: 10000,
          max_steps: 5,
        }],
        on_failure: "fail-fast",
        timeout_ms: 60000,
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.define", {
        nodes: [{
          nodeId: "n1",
          task: "test",
          dependsOn: ["n0"],
          timeoutMs: 10000,
          maxSteps: 5,
        }],
        onFailure: "fail-fast",
        timeoutMs: 60000,
      });
    });

    it("omits undefined optional fields from transformed nodes", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc11", {
        action: "execute",
        nodes: [{ node_id: "simple", task: "just a task" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      const node = (calledParams.nodes as Record<string, unknown>[])[0]!;
      expect(node).toEqual({ nodeId: "simple", task: "just a task" });
      expect(node).not.toHaveProperty("dependsOn");
      expect(node).not.toHaveProperty("agent");
      expect(node).not.toHaveProperty("model");
      expect(node).not.toHaveProperty("timeoutMs");
      expect(node).not.toHaveProperty("maxSteps");
    });
  });

  // -----------------------------------------------------------------------
  // Barrier mode and budget passthrough
  // -----------------------------------------------------------------------

  describe("barrier_mode and budget", () => {
    it("transforms barrier_mode on nodes for execute action", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-barrier1", {
        action: "execute",
        nodes: [
          { node_id: "a", task: "Do A" },
          { node_id: "b", task: "Do B", depends_on: ["a"], barrier_mode: "majority" },
        ],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      const nodes = calledParams.nodes as Record<string, unknown>[];
      expect(nodes[0]).not.toHaveProperty("barrierMode");
      expect(nodes[1]).toMatchObject({ barrierMode: "majority" });
    });

    it("passes budget through for execute action", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-budget1", {
        action: "execute",
        nodes: [{ node_id: "a", task: "Do A" }],
        budget: { max_tokens: 50000, max_cost: 1.5 },
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams.budget).toEqual({ maxTokens: 50000, maxCost: 1.5 });
    });

    it("passes budget through for define action", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-budget2", {
        action: "define",
        nodes: [{ node_id: "a", task: "Do A" }],
        budget: { max_tokens: 10000 },
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams.budget).toEqual({ maxTokens: 10000 });
    });

    it("omits budget when not provided", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-budget3", {
        action: "execute",
        nodes: [{ node_id: "a", task: "Do A" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams).not.toHaveProperty("budget");
    });
  });

  // -----------------------------------------------------------------------
  // Save action
  // -----------------------------------------------------------------------

  describe("save action", () => {
    it("calls graph.save with label, transformed nodes, edges, and settings", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ id: "custom-id", saved: true });

      const result = await tool.execute("tc-save1", {
        action: "save",
        label: "my-pipeline",
        nodes: sampleNodes(),
        edges: [{ from: "a", to: "b" }],
        settings: { retries: 3 },
        id: "custom-id",
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.save", {
        label: "my-pipeline",
        nodes: [
          { nodeId: "a", task: "Do A", dependsOn: [], timeoutMs: 5000, maxSteps: 10 },
          { nodeId: "b", task: "Do B", dependsOn: ["a"], agent: "helper", model: "fast" },
        ],
        id: "custom-id",
        edges: [{ id: "a->b", source: "a", target: "b" }],
        settings: { retries: 3 },
      });

      expect(result.details).toEqual({ id: "custom-id", saved: true });
    });

    it("calls graph.save without optional id", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ id: "auto-generated", saved: true });

      await tool.execute("tc-save2", {
        action: "save",
        label: "auto-id",
        nodes: [{ node_id: "a", task: "Run" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams).not.toHaveProperty("id");
      expect(calledParams.edges).toEqual([]);
      expect(calledParams.settings).toEqual({});
      expect(calledParams.label).toBe("auto-id");
    });

    it("throws when label missing for save", async () => {
      const tool = createPipelineTool(rpcCall);
      await expect(
        tool.execute("tc-save3", {
          action: "save",
          nodes: sampleNodes(),
        } as never),
      ).rejects.toThrow(/Missing required parameter: label/);
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("throws when nodes missing and no prior define", async () => {
      const tool = createPipelineTool(rpcCall);
      await expect(
        tool.execute("tc-save4", {
          action: "save",
          label: "no-nodes",
        } as never),
      ).rejects.toThrow(/Missing required parameter: nodes/);
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("uses cached graph from prior define when nodes/label omitted", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValueOnce({ valid: true });
      rpcCall.mockResolvedValueOnce({ id: "cached-save", saved: true });

      // Step 1: define the graph (caches it)
      await tool.execute("tc-cache1", {
        action: "define",
        nodes: [{ node_id: "a", task: "Do A" }, { node_id: "b", task: "Do B", depends_on: ["a"] }],
        label: "cached-pipeline",
        edges: [{ from: "a", to: "b" }],
      } as never);

      // Step 2: save with only id — should use cached nodes, label, edges
      const result = await tool.execute("tc-cache2", {
        action: "save",
        id: "cached-save",
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.save", {
        label: "cached-pipeline",
        nodes: [{ nodeId: "a", task: "Do A" }, { nodeId: "b", task: "Do B", dependsOn: ["a"] }],
        id: "cached-save",
        edges: [{ id: "a->b", source: "a", target: "b" }],
        settings: {},
      });
      expect(result.details).toEqual({ id: "cached-save", saved: true });
    });

    it("save overrides cached label when explicitly provided", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValueOnce({ valid: true });
      rpcCall.mockResolvedValueOnce({ id: "override", saved: true });

      await tool.execute("tc-override1", {
        action: "define",
        nodes: [{ node_id: "a", task: "Do A" }],
        label: "original-label",
      } as never);

      await tool.execute("tc-override2", {
        action: "save",
        id: "override",
        label: "new-label",
      } as never);

      const calledParams = rpcCall.mock.calls[1]![1];
      expect(calledParams.label).toBe("new-label");
    });

    it("uses cached graph from prior execute when nodes omitted for save", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValueOnce({ graphId: "g1", status: "running" });
      rpcCall.mockResolvedValueOnce({ id: "from-exec", saved: true });

      await tool.execute("tc-exec-cache1", {
        action: "execute",
        nodes: [{ node_id: "x", task: "Process" }],
        label: "exec-label",
      } as never);

      const result = await tool.execute("tc-exec-cache2", {
        action: "save",
        id: "from-exec",
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.save", expect.objectContaining({
        label: "exec-label",
        nodes: [{ nodeId: "x", task: "Process" }],
        id: "from-exec",
      }));
      expect(result.details).toEqual({ id: "from-exec", saved: true });
    });
  });

  // -----------------------------------------------------------------------
  // Load action
  // -----------------------------------------------------------------------

  describe("load action", () => {
    it("calls graph.load with id", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ id: "g-123", label: "test", nodes: [] });

      const result = await tool.execute("tc-load1", {
        action: "load",
        id: "g-123",
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.load", { id: "g-123" });
      expect(result.details).toEqual({ id: "g-123", label: "test", nodes: [] });
    });

    it("throws when id missing for load", async () => {
      const tool = createPipelineTool(rpcCall);
      await expect(
        tool.execute("tc-load2", {
          action: "load",
        } as never),
      ).rejects.toThrow(/Missing required parameter: id/);
      expect(rpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // List action
  // -----------------------------------------------------------------------

  describe("list action", () => {
    it("calls graph.list with limit and offset", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ entries: [], total: 0 });

      const result = await tool.execute("tc-list1", {
        action: "list",
        limit: 10,
        offset: 5,
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.list", { limit: 10, offset: 5 });
      expect(result.details).toEqual({ entries: [], total: 0 });
    });

    it("calls graph.list with no params", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ entries: [], total: 0 });

      await tool.execute("tc-list2", {
        action: "list",
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.list", {});
    });
  });

  // -----------------------------------------------------------------------
  // Delete action
  // -----------------------------------------------------------------------

  describe("delete action", () => {
    it("gates delete action (requires confirmation with hint)", async () => {
      const tool = createPipelineTool(rpcCall);

      const result = await tool.execute("tc-del1", {
        action: "delete",
        id: "g-123",
      } as never);

      expect(result.details).toMatchObject({
        requiresConfirmation: true,
        actionType: "graph.delete",
        hint: expect.stringContaining("_confirmed: true"),
      });
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("bypasses gate when _confirmed is true", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ id: "g-123", deleted: true });

      const result = await tool.execute("tc-del2", {
        action: "delete",
        id: "g-123",
        _confirmed: true,
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.delete", { id: "g-123" });
      expect(result.details).toEqual({ id: "g-123", deleted: true });
    });

    it("throws when id missing for confirmed delete", async () => {
      const tool = createPipelineTool(rpcCall);
      await expect(
        tool.execute("tc-del3", {
          action: "delete",
          _confirmed: true,
        } as never),
      ).rejects.toThrow(/Missing required parameter: id/);
      expect(rpcCall).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Unknown action
  // -----------------------------------------------------------------------

  it("throws [invalid_action] for unknown action", async () => {
    const tool = createPipelineTool(rpcCall);
    await expect(
      tool.execute("tc12", { action: "destroy" } as never),
    ).rejects.toThrow(/\[invalid_action\]/);
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it("throws when rpcCall throws", async () => {
    rpcCall.mockRejectedValue(new Error("Network timeout"));
    const tool = createPipelineTool(rpcCall);

    await expect(
      tool.execute("tc13", {
        action: "execute",
        nodes: [{ node_id: "a", task: "fail" }],
      } as never),
    ).rejects.toThrow("Network timeout");
  });

  it("throws non-Error as string", async () => {
    rpcCall.mockRejectedValue("raw string error");
    const tool = createPipelineTool(rpcCall);

    await expect(
      tool.execute("tc14", {
        action: "execute",
        nodes: [{ node_id: "a", task: "fail" }],
      } as never),
    ).rejects.toThrow("raw string error");
  });

  // -----------------------------------------------------------------------
  // Logger integration
  // -----------------------------------------------------------------------

  it("calls logger.debug for each action", async () => {
    const logger = { debug: vi.fn(), info: vi.fn() };
    const tool = createPipelineTool(rpcCall, logger);

    await tool.execute("tc15", {
      action: "define",
      nodes: [{ node_id: "a", task: "test" }],
    } as never);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "pipeline", action: "define" }),
      expect.any(String),
    );
  });

  it("calls logger.debug for save action", async () => {
    const logger = { debug: vi.fn(), info: vi.fn() };
    const tool = createPipelineTool(rpcCall, logger);

    await tool.execute("tc-log-save", {
      action: "save",
      label: "test-save",
      nodes: [{ node_id: "a", task: "test" }],
    } as never);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "pipeline", action: "save" }),
      expect.any(String),
    );
  });

  // -----------------------------------------------------------------------
  // Edge normalization
  // -----------------------------------------------------------------------

  describe("edge normalization", () => {
    it("passes source/target edges through correctly in define action", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-edge1", {
        action: "define",
        nodes: [{ node_id: "a", task: "Do A" }, { node_id: "b", task: "Do B" }],
        edges: [{ source: "a", target: "b" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams.edges).toEqual([{ id: "a->b", source: "a", target: "b" }]);
    });

    it("normalizes from/to to source/target in define action", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-edge2", {
        action: "define",
        nodes: [{ node_id: "a", task: "Do A" }, { node_id: "b", task: "Do B" }],
        edges: [{ from: "a", to: "b" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams.edges).toEqual([{ id: "a->b", source: "a", target: "b" }]);
    });

    it("silently drops edges missing source/from or target/to", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-edge4", {
        action: "define",
        nodes: [{ node_id: "a", task: "Do A" }],
        edges: [
          { source: "a" },  // missing target
          { target: "b" },  // missing source
          {},                // missing both
        ],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      // All dropped -> no edges key
      expect(calledParams).not.toHaveProperty("edges");
    });

    it("auto-generates id as 'source->target' when not provided", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-edge5", {
        action: "define",
        nodes: [{ node_id: "x", task: "X" }, { node_id: "y", task: "Y" }],
        edges: [{ source: "x", target: "y" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect((calledParams.edges as { id: string }[])[0]!.id).toBe("x->y");
    });

    it("preserves explicit id when provided", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-edge6", {
        action: "define",
        nodes: [{ node_id: "a", task: "A" }, { node_id: "b", task: "B" }],
        edges: [{ id: "custom-edge", source: "a", target: "b" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect((calledParams.edges as { id: string }[])[0]!.id).toBe("custom-edge");
    });
  });

  // -----------------------------------------------------------------------
  // Define action edges passthrough
  // -----------------------------------------------------------------------

  describe("define action edges", () => {
    it("passes normalized edges in RPC call when edges are provided", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-def-edge1", {
        action: "define",
        nodes: [{ node_id: "a", task: "A" }, { node_id: "b", task: "B" }],
        edges: [{ from: "a", to: "b" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams.edges).toEqual([
        { id: "a->b", source: "a", target: "b" },
      ]);
    });

    it("omits edges from RPC when no edges provided", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-def-edge2", {
        action: "define",
        nodes: [{ node_id: "a", task: "A" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams).not.toHaveProperty("edges");
    });

    it("omits edges from RPC when edges array is empty", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-def-edge3", {
        action: "define",
        nodes: [{ node_id: "a", task: "A" }],
        edges: [],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams).not.toHaveProperty("edges");
    });
  });

  // -----------------------------------------------------------------------
  // Execute action edges passthrough
  // -----------------------------------------------------------------------

  describe("execute action edges", () => {
    it("passes normalized edges in RPC call when edges are provided", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-exec-edge1", {
        action: "execute",
        nodes: [{ node_id: "a", task: "A" }, { node_id: "b", task: "B" }],
        edges: [{ source: "a", target: "b" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams.edges).toEqual([
        { id: "a->b", source: "a", target: "b" },
      ]);
    });

    it("omits edges from RPC when no edges provided for execute", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-exec-edge2", {
        action: "execute",
        nodes: [{ node_id: "a", task: "A" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams).not.toHaveProperty("edges");
    });
  });

  // -----------------------------------------------------------------------
  // Save action auto-derive edges
  // -----------------------------------------------------------------------

  describe("save action auto-derive edges", () => {
    it("auto-derives edges from dependsOn when no explicit edges provided", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-save-derive1", {
        action: "save",
        label: "derived",
        nodes: [
          { node_id: "a", task: "Do A" },
          { node_id: "b", task: "Do B", depends_on: ["a"] },
          { node_id: "c", task: "Do C", depends_on: ["a", "b"] },
        ],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams.edges).toEqual([
        { id: "a->b", source: "a", target: "b" },
        { id: "a->c", source: "a", target: "c" },
        { id: "b->c", source: "b", target: "c" },
      ]);
    });

    it("uses explicit edges (not auto-derived) when edges are provided", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-save-derive3", {
        action: "save",
        label: "explicit-edges",
        nodes: [
          { node_id: "a", task: "Do A" },
          { node_id: "b", task: "Do B", depends_on: ["a"] },
        ],
        edges: [{ source: "a", target: "b" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams.edges).toEqual([
        { id: "a->b", source: "a", target: "b" },
      ]);
    });

    it("produces empty edges when nodes have no dependsOn and no explicit edges", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-save-derive4", {
        action: "save",
        label: "no-deps",
        nodes: [
          { node_id: "a", task: "Do A" },
          { node_id: "b", task: "Do B" },
        ],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      expect(calledParams.edges).toEqual([]);
    });

  });

  // -----------------------------------------------------------------------
  // Retries parameter
  // -----------------------------------------------------------------------

  describe("retries parameter", () => {
    it("retries parameter is passed through to RPC", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-retry1", {
        action: "execute",
        nodes: [
          { node_id: "a", task: "Do A", retries: 2 },
          { node_id: "b", task: "Do B", depends_on: ["a"] },
        ],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      const nodes = calledParams.nodes as Record<string, unknown>[];
      expect(nodes[0]).toMatchObject({ nodeId: "a", task: "Do A", retries: 2 });
      expect(nodes[1]).not.toHaveProperty("retries");
    });
  });

  // -----------------------------------------------------------------------
  // type_id / type_config parameters
  // -----------------------------------------------------------------------

  describe("type_id / type_config parameters", () => {
    it("passes type_id and type_config through to RPC", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-typeid1", {
        action: "define",
        nodes: [
          {
            node_id: "discuss",
            task: "Debate the topic",
            type_id: "debate",
            type_config: { agents: ["bull", "bear"], rounds: 2 },
          },
        ],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      const nodes = calledParams.nodes as Record<string, unknown>[];
      expect(nodes[0]).toMatchObject({
        nodeId: "discuss",
        typeId: "debate",
        typeConfig: { agents: ["bull", "bear"], rounds: 2 },
      });
    });

    it("omits type_id and type_config when not provided", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-typeid2", {
        action: "define",
        nodes: [{ node_id: "a", task: "No type" }],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      const nodes = calledParams.nodes as Record<string, unknown>[];
      expect(nodes[0]).not.toHaveProperty("typeId");
      expect(nodes[0]).not.toHaveProperty("typeConfig");
    });

    it("does not pass debate field", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-typeid3", {
        action: "define",
        nodes: [
          {
            node_id: "legacy",
            task: "Legacy node",
            debate: { agents: ["bull", "bear"], rounds: 2 },
          },
        ],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      const nodes = calledParams.nodes as Record<string, unknown>[];
      expect(nodes[0]).not.toHaveProperty("debate");
    });
  });

  // -----------------------------------------------------------------------
  // context_mode parameter
  // -----------------------------------------------------------------------

  describe("context_mode parameter", () => {
    it("passes context_mode through transformNodes as contextMode", async () => {
      const tool = createPipelineTool(rpcCall);

      await tool.execute("tc-ctx1", {
        action: "execute",
        nodes: [
          { node_id: "a", task: "Do A" },
          { node_id: "b", task: "Do B", depends_on: ["a"], context_mode: "none" },
        ],
      } as never);

      const calledParams = rpcCall.mock.calls[0]![1];
      const nodes = calledParams.nodes as Record<string, unknown>[];
      expect(nodes[0]).not.toHaveProperty("contextMode");
      expect(nodes[1]).toMatchObject({ nodeId: "b", contextMode: "none" });
    });
  });

  // -----------------------------------------------------------------------
  // Execute with saved pipeline id
  // -----------------------------------------------------------------------

  describe("execute with saved pipeline id", () => {
    it("loads saved pipeline when id provided without nodes", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValueOnce({
        nodes: [
          { nodeId: "a", task: "Saved A", dependsOn: [] },
          { nodeId: "b", task: "Saved B", dependsOn: ["a"] },
        ],
        label: "saved-pipeline",
        edges: [{ id: "a->b", source: "a", target: "b" }],
        settings: {},
      }); // graph.load
      rpcCall.mockResolvedValueOnce({ graphId: "g1", status: "running" }); // graph.execute

      const result = await tool.execute("tc-saved1", {
        action: "execute",
        id: "my-saved",
      } as never);

      // First call should be graph.load
      expect(rpcCall).toHaveBeenCalledWith("graph.load", { id: "my-saved" });

      // Second call should be graph.execute with the loaded nodes (already camelCase from graph.load, transformNodes handles both)
      expect(rpcCall).toHaveBeenCalledWith("graph.execute", expect.objectContaining({
        label: "saved-pipeline",
        edges: [{ id: "a->b", source: "a", target: "b" }],
      }));
      const executeCallNodes = rpcCall.mock.calls[1]![1].nodes as Record<string, unknown>[];
      expect(executeCallNodes).toHaveLength(2);
      expect(executeCallNodes[0]).toMatchObject({ nodeId: "a", task: "Saved A" });
      expect(executeCallNodes[1]).toMatchObject({ nodeId: "b", task: "Saved B" });

      expect(result.details).toEqual({ graphId: "g1", status: "running" });
    });

    it("uses inline nodes over saved pipeline when both provided", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValue({ graphId: "g2", status: "running" });

      await tool.execute("tc-saved2", {
        action: "execute",
        id: "my-saved",
        nodes: [{ node_id: "x", task: "Inline task" }],
      } as never);

      // graph.load should NOT be called since inline nodes were provided
      expect(rpcCall).not.toHaveBeenCalledWith("graph.load", expect.anything());

      // graph.execute should be called with inline nodes
      expect(rpcCall).toHaveBeenCalledWith("graph.execute", expect.objectContaining({
        nodes: [{ nodeId: "x", task: "Inline task" }],
      }));
    });

    it("throws when neither nodes nor id provided", async () => {
      const tool = createPipelineTool(rpcCall);
      await expect(
        tool.execute("tc-saved3", {
          action: "execute",
        } as never),
      ).rejects.toThrow(/nodes.*provide nodes or id/);
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("uses saved pipeline settings for on_failure and timeout_ms", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValueOnce({
        nodes: [{ nodeId: "a", task: "Task A" }],
        label: "saved-with-settings",
        edges: [],
        settings: { onFailure: "continue", timeoutMs: 60000 },
      }); // graph.load
      rpcCall.mockResolvedValueOnce({ graphId: "g3" }); // graph.execute

      await tool.execute("tc-saved4", {
        action: "execute",
        id: "settings-pipeline",
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.execute", expect.objectContaining({
        onFailure: "continue",
        timeoutMs: 60000,
      }));
    });

    it("overrides saved label with explicitly provided label", async () => {
      const tool = createPipelineTool(rpcCall);
      rpcCall.mockResolvedValueOnce({
        nodes: [{ nodeId: "a", task: "Task A" }],
        label: "saved-label",
        edges: [],
        settings: {},
      }); // graph.load
      rpcCall.mockResolvedValueOnce({ graphId: "g4" }); // graph.execute

      await tool.execute("tc-saved5", {
        action: "execute",
        id: "my-saved",
        label: "override-label",
      } as never);

      expect(rpcCall).toHaveBeenCalledWith("graph.execute", expect.objectContaining({
        label: "override-label",
      }));
    });
  });

  // -----------------------------------------------------------------------
  // Description tests
  // -----------------------------------------------------------------------

  describe("description", () => {
    it("has lean description mentioning key capabilities", () => {
      const tool = createPipelineTool(rpcCall);
      expect(tool.description).toContain("execute");
      expect(tool.description).toContain("DAG");
      expect(tool.description).toContain("pipeline");
      expect(tool.description.length).toBeLessThanOrEqual(300);
    });
  });
});
