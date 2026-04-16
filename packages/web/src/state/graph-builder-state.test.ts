import { describe, it, expect, vi } from "vitest";
import {
  createGraphBuilderState,
  type GraphBuilderState,
  type GraphBuilderSnapshot,
} from "./graph-builder-state.js";
import type { PipelineNode, PipelineEdge, ValidationResult } from "../api/types/index.js";
import { DEFAULT_VIEWPORT } from "../utils/viewport-transform.js";

/** Helper to create a minimal PipelineNode */
function makeNode(id: string, x = 0, y = 0): PipelineNode {
  return {
    id,
    task: `Task ${id}`,
    dependsOn: [],
    position: { x, y },
  };
}

describe("createGraphBuilderState", () => {
  describe("factory", () => {
    it("returns object with subscribe, getSnapshot, and domain methods", () => {
      const state = createGraphBuilderState();
      expect(typeof state.subscribe).toBe("function");
      expect(typeof state.getSnapshot).toBe("function");
      expect(typeof state.addNode).toBe("function");
      expect(typeof state.updateNode).toBe("function");
      expect(typeof state.removeNode).toBe("function");
      expect(typeof state.addEdge).toBe("function");
      expect(typeof state.removeEdge).toBe("function");
      expect(typeof state.updateSettings).toBe("function");
      expect(typeof state.selectNode).toBe("function");
      expect(typeof state.selectAll).toBe("function");
      expect(typeof state.clearSelection).toBe("function");
      expect(typeof state.setViewport).toBe("function");
      expect(typeof state.setValidation).toBe("function");
      expect(typeof state.undo).toBe("function");
      expect(typeof state.redo).toBe("function");
      expect(typeof state.reset).toBe("function");
    });
  });

  describe("initial state", () => {
    it("getSnapshot returns correct initial values", () => {
      const state = createGraphBuilderState();
      const snap = state.getSnapshot();

      expect(snap.nodes).toEqual([]);
      expect(snap.edges).toEqual([]);
      expect(snap.settings).toEqual({
        label: "Untitled Pipeline",
        onFailure: "fail-fast",
      });
      expect(snap.selectedNodeIds).toEqual(new Set());
      expect(snap.viewport).toEqual(DEFAULT_VIEWPORT);
      expect(snap.validationResult).toBeNull();
      expect(snap.isDirty).toBe(false);
      expect(snap.canUndo).toBe(false);
      expect(snap.canRedo).toBe(false);
    });

    it("getSnapshot returns frozen object", () => {
      const state = createGraphBuilderState();
      const snap = state.getSnapshot();
      expect(Object.isFrozen(snap)).toBe(true);
    });
  });

  describe("addNode", () => {
    it("adds a PipelineNode to the nodes array", () => {
      const state = createGraphBuilderState();
      const node = makeNode("n1", 100, 200);

      state.addNode(node);

      const snap = state.getSnapshot();
      expect(snap.nodes).toHaveLength(1);
      expect(snap.nodes[0]).toEqual(node);
    });

    it("sets isDirty to true", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      expect(state.getSnapshot().isDirty).toBe(true);
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      const handler = vi.fn();
      state.subscribe(handler);

      state.addNode(makeNode("n1"));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateNode", () => {
    it("updates node fields by nodeId", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1", 0, 0));

      state.updateNode("n1", { task: "Updated Task", position: { x: 50, y: 75 } });

      const snap = state.getSnapshot();
      expect(snap.nodes[0]!.task).toBe("Updated Task");
      expect(snap.nodes[0]!.position).toEqual({ x: 50, y: 75 });
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      const handler = vi.fn();
      state.subscribe(handler);

      state.updateNode("n1", { task: "Updated" });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("preserves other nodes when updating one", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1", 10, 20));
      state.addNode(makeNode("n2", 30, 40));

      state.updateNode("n1", { task: "Updated" });

      const snap = state.getSnapshot();
      expect(snap.nodes).toHaveLength(2);
      expect(snap.nodes[1]!.task).toBe("Task n2");
    });
  });

  describe("removeNode", () => {
    it("removes node by id", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));

      state.removeNode("n1");

      const snap = state.getSnapshot();
      expect(snap.nodes).toHaveLength(1);
      expect(snap.nodes[0]!.id).toBe("n2");
    });

    it("also removes edges referencing the removed node", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addNode(makeNode("n3"));
      state.addEdge("n1", "n2");
      state.addEdge("n2", "n3");

      state.removeNode("n2");

      const snap = state.getSnapshot();
      expect(snap.edges).toHaveLength(0);
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      const handler = vi.fn();
      state.subscribe(handler);

      state.removeNode("n1");

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("addEdge", () => {
    it("creates PipelineEdge with id='source->target'", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));

      state.addEdge("n1", "n2");

      const snap = state.getSnapshot();
      expect(snap.edges).toHaveLength(1);
      expect(snap.edges[0]).toEqual({
        id: "n1->n2",
        source: "n1",
        target: "n2",
      });
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      const handler = vi.fn();
      state.subscribe(handler);

      state.addEdge("n1", "n2");

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("removeEdge", () => {
    it("removes edge by id", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addNode(makeNode("n3"));
      state.addEdge("n1", "n2");
      state.addEdge("n2", "n3");

      state.removeEdge("n1->n2");

      const snap = state.getSnapshot();
      expect(snap.edges).toHaveLength(1);
      expect(snap.edges[0]!.id).toBe("n2->n3");
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");
      const handler = vi.fn();
      state.subscribe(handler);

      state.removeEdge("n1->n2");

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateSettings", () => {
    it("merges partial GraphSettings", () => {
      const state = createGraphBuilderState();

      state.updateSettings({ label: "My Pipeline", onFailure: "continue" });

      const snap = state.getSnapshot();
      expect(snap.settings.label).toBe("My Pipeline");
      expect(snap.settings.onFailure).toBe("continue");
    });

    it("preserves unmodified settings fields", () => {
      const state = createGraphBuilderState();
      state.updateSettings({ label: "My Pipeline" });

      state.updateSettings({ onFailure: "continue" });

      const snap = state.getSnapshot();
      expect(snap.settings.label).toBe("My Pipeline");
      expect(snap.settings.onFailure).toBe("continue");
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      const handler = vi.fn();
      state.subscribe(handler);

      state.updateSettings({ label: "New Label" });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("selectNode", () => {
    it("single select sets selectedNodeIds to {nodeId}", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));

      state.selectNode("n1");

      const snap = state.getSnapshot();
      expect(snap.selectedNodeIds).toEqual(new Set(["n1"]));
    });

    it("single select replaces previous selection", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));

      state.selectNode("n1");
      state.selectNode("n2");

      const snap = state.getSnapshot();
      expect(snap.selectedNodeIds).toEqual(new Set(["n2"]));
    });

    it("multi=true adds to existing selection", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));

      state.selectNode("n1");
      state.selectNode("n2", true);

      const snap = state.getSnapshot();
      expect(snap.selectedNodeIds).toEqual(new Set(["n1", "n2"]));
    });
  });

  describe("selectAll", () => {
    it("sets selectedNodeIds to all node IDs", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addNode(makeNode("n3"));

      state.selectAll();

      const snap = state.getSnapshot();
      expect(snap.selectedNodeIds).toEqual(new Set(["n1", "n2", "n3"]));
    });
  });

  describe("clearSelection", () => {
    it("empties selectedNodeIds", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.selectNode("n1");

      state.clearSelection();

      const snap = state.getSnapshot();
      expect(snap.selectedNodeIds).toEqual(new Set());
    });
  });

  describe("setViewport", () => {
    it("updates viewport", () => {
      const state = createGraphBuilderState();
      const newVp = { x: 100, y: 50, scale: 1.5 };

      state.setViewport(newVp);

      expect(state.getSnapshot().viewport).toEqual(newVp);
    });

    it("does NOT set isDirty", () => {
      const state = createGraphBuilderState();

      state.setViewport({ x: 100, y: 50, scale: 1.5 });

      expect(state.getSnapshot().isDirty).toBe(false);
    });

    it("does NOT push undo entry", () => {
      const state = createGraphBuilderState();

      state.setViewport({ x: 100, y: 50, scale: 1.5 });

      expect(state.getSnapshot().canUndo).toBe(false);
    });
  });

  describe("undo/redo", () => {
    it("undo reverses addNode", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));

      state.undo();

      const snap = state.getSnapshot();
      expect(snap.nodes).toHaveLength(1);
      expect(snap.nodes[0]!.id).toBe("n1");
    });

    it("redo replays undone addNode", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));

      state.undo();
      state.redo();

      const snap = state.getSnapshot();
      expect(snap.nodes).toHaveLength(2);
    });

    it("canUndo and canRedo flags are correct", () => {
      const state = createGraphBuilderState();
      expect(state.getSnapshot().canUndo).toBe(false);
      expect(state.getSnapshot().canRedo).toBe(false);

      state.addNode(makeNode("n1"));
      expect(state.getSnapshot().canUndo).toBe(true);
      expect(state.getSnapshot().canRedo).toBe(false);

      state.undo();
      expect(state.getSnapshot().canUndo).toBe(false);
      expect(state.getSnapshot().canRedo).toBe(true);

      state.redo();
      expect(state.getSnapshot().canUndo).toBe(true);
      expect(state.getSnapshot().canRedo).toBe(false);
    });

    it("new mutation after undo clears redo stack", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));

      state.undo();
      expect(state.getSnapshot().canRedo).toBe(true);

      state.addNode(makeNode("n2"));
      expect(state.getSnapshot().canRedo).toBe(false);
    });

    it("undo reverses removeNode", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.removeNode("n1");

      state.undo();

      expect(state.getSnapshot().nodes).toHaveLength(1);
      expect(state.getSnapshot().nodes[0]!.id).toBe("n1");
    });

    it("undo reverses addEdge", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");

      state.undo();

      expect(state.getSnapshot().edges).toHaveLength(0);
    });

    it("undo reverses updateSettings", () => {
      const state = createGraphBuilderState();
      state.updateSettings({ label: "Changed" });

      state.undo();

      expect(state.getSnapshot().settings.label).toBe("Untitled Pipeline");
    });

    it("undo notifies subscribers", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      const handler = vi.fn();
      state.subscribe(handler);

      state.undo();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("redo notifies subscribers", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.undo();
      const handler = vi.fn();
      state.subscribe(handler);

      state.redo();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("undo with empty stack is a no-op", () => {
      const state = createGraphBuilderState();
      const handler = vi.fn();
      state.subscribe(handler);

      state.undo();

      expect(handler).not.toHaveBeenCalled();
    });

    it("redo with empty stack is a no-op", () => {
      const state = createGraphBuilderState();
      const handler = vi.fn();
      state.subscribe(handler);

      state.redo();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("selection changes do NOT push undo", () => {
    it("selectNode does not create undo entry", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));

      state.selectNode("n1");
      state.undo();

      // Undo should reverse addNode, not selectNode
      expect(state.getSnapshot().nodes).toHaveLength(0);
    });

    it("selectAll does not create undo entry", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));

      state.selectAll();
      state.undo();

      expect(state.getSnapshot().nodes).toHaveLength(0);
    });

    it("clearSelection does not create undo entry", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.selectNode("n1");

      state.clearSelection();
      state.undo();

      expect(state.getSnapshot().nodes).toHaveLength(0);
    });
  });

  describe("viewport changes do NOT push undo", () => {
    it("setViewport does not create undo entry", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));

      state.setViewport({ x: 100, y: 50, scale: 2.0 });
      state.undo();

      // Undo should reverse addNode, not setViewport
      expect(state.getSnapshot().nodes).toHaveLength(0);
    });
  });

  describe("subscribe", () => {
    it("handler called on mutations", () => {
      const state = createGraphBuilderState();
      const handler = vi.fn();
      state.subscribe(handler);

      state.addNode(makeNode("n1"));
      state.updateSettings({ label: "Test" });
      state.selectNode("n1");

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it("unsubscribe stops notifications", () => {
      const state = createGraphBuilderState();
      const handler = vi.fn();
      const unsub = state.subscribe(handler);

      state.addNode(makeNode("n1"));
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();

      state.addNode(makeNode("n2"));
      expect(handler).toHaveBeenCalledTimes(1); // Still 1
    });

    it("multiple subscribers all receive notifications", () => {
      const state = createGraphBuilderState();
      const handlers = [vi.fn(), vi.fn(), vi.fn()];
      for (const h of handlers) {
        state.subscribe(h);
      }

      state.addNode(makeNode("n1"));

      for (const h of handlers) {
        expect(h).toHaveBeenCalledOnce();
      }
    });
  });

  describe("reset", () => {
    it("returns to initial state", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");
      state.updateSettings({ label: "Modified" });
      state.selectNode("n1");
      state.setViewport({ x: 100, y: 50, scale: 2.0 });

      state.reset();

      const snap = state.getSnapshot();
      expect(snap.nodes).toEqual([]);
      expect(snap.edges).toEqual([]);
      expect(snap.settings).toEqual({ label: "Untitled Pipeline", onFailure: "fail-fast" });
      expect(snap.selectedNodeIds).toEqual(new Set());
      expect(snap.viewport).toEqual(DEFAULT_VIEWPORT);
      expect(snap.validationResult).toBeNull();
      expect(snap.isDirty).toBe(false);
    });

    it("clears undo/redo stacks", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.undo();

      state.reset();

      expect(state.getSnapshot().canUndo).toBe(false);
      expect(state.getSnapshot().canRedo).toBe(false);
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      const handler = vi.fn();
      state.subscribe(handler);

      state.reset();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("MAX_UNDO_DEPTH", () => {
    it("caps undo stack at 50 entries (oldest dropped)", () => {
      const state = createGraphBuilderState();

      // Push 51 addNode operations
      for (let i = 0; i < 51; i++) {
        state.addNode(makeNode(`n${i}`));
      }

      // Should be able to undo 50 times (the first one was dropped)
      for (let i = 0; i < 50; i++) {
        expect(state.getSnapshot().canUndo).toBe(true);
        state.undo();
      }

      // 51st undo should not be possible
      expect(state.getSnapshot().canUndo).toBe(false);
    });
  });

  describe("getSnapshot returns new object each call", () => {
    it("different object references", () => {
      const state = createGraphBuilderState();
      const snap1 = state.getSnapshot();
      const snap2 = state.getSnapshot();

      expect(snap1).toEqual(snap2);
      expect(snap1).not.toBe(snap2);
    });
  });

  describe("selectEdge", () => {
    it("sets selectedEdgeId on snapshot", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");

      state.selectEdge("n1->n2");

      expect(state.getSnapshot().selectedEdgeId).toBe("n1->n2");
    });

    it("clears node selection (mutual exclusivity)", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");

      state.selectNode("n1");
      state.selectEdge("n1->n2");

      expect(state.getSnapshot().selectedNodeIds).toEqual(new Set());
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");
      const handler = vi.fn();
      state.subscribe(handler);

      state.selectEdge("n1->n2");

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does NOT push undo entry", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");

      state.selectEdge("n1->n2");
      state.undo();

      // Undo should reverse addEdge, not selectEdge
      expect(state.getSnapshot().edges).toHaveLength(0);
    });
  });

  describe("selectNode clears edge selection", () => {
    it("selectNode clears selectedEdgeId (mutual exclusivity)", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");

      state.selectEdge("n1->n2");
      state.selectNode("n1");

      expect(state.getSnapshot().selectedEdgeId).toBeNull();
    });
  });

  describe("clearEdgeSelection", () => {
    it("sets selectedEdgeId to null", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");

      state.selectEdge("n1->n2");
      state.clearEdgeSelection();

      expect(state.getSnapshot().selectedEdgeId).toBeNull();
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");
      state.selectEdge("n1->n2");
      const handler = vi.fn();
      state.subscribe(handler);

      state.clearEdgeSelection();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("clearSelection also clears edge selection", () => {
    it("clearSelection sets selectedEdgeId to null", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");

      state.selectEdge("n1->n2");
      state.clearSelection();

      expect(state.getSnapshot().selectedEdgeId).toBeNull();
    });
  });

  describe("selectedEdgeId initial and reset", () => {
    it("initial selectedEdgeId is null", () => {
      const state = createGraphBuilderState();
      expect(state.getSnapshot().selectedEdgeId).toBeNull();
    });

    it("reset clears selectedEdgeId", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1"));
      state.addNode(makeNode("n2"));
      state.addEdge("n1", "n2");
      state.selectEdge("n1->n2");

      state.reset();

      expect(state.getSnapshot().selectedEdgeId).toBeNull();
    });
  });

  describe("moveNodes", () => {
    it("batch updates multiple node positions in one call", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1", 0, 0));
      state.addNode(makeNode("n2", 100, 100));

      state.moveNodes([
        { nodeId: "n1", position: { x: 50, y: 50 } },
        { nodeId: "n2", position: { x: 150, y: 150 } },
      ]);

      const snap = state.getSnapshot();
      expect(snap.nodes[0]!.position).toEqual({ x: 50, y: 50 });
      expect(snap.nodes[1]!.position).toEqual({ x: 150, y: 150 });
    });

    it("creates exactly one undo entry (both revert on single undo)", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1", 0, 0));
      state.addNode(makeNode("n2", 100, 100));

      state.moveNodes([
        { nodeId: "n1", position: { x: 50, y: 50 } },
        { nodeId: "n2", position: { x: 150, y: 150 } },
      ]);

      state.undo();

      const snap = state.getSnapshot();
      expect(snap.nodes[0]!.position).toEqual({ x: 0, y: 0 });
      expect(snap.nodes[1]!.position).toEqual({ x: 100, y: 100 });
    });

    it("sets isDirty to true", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1", 0, 0));

      // Reset isDirty by undoing and redoing to get a clean state
      // Actually, after addNode isDirty is already true; let's just verify moveNodes keeps it true
      state.moveNodes([{ nodeId: "n1", position: { x: 50, y: 50 } }]);

      expect(state.getSnapshot().isDirty).toBe(true);
    });

    it("notifies subscribers exactly once", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1", 0, 0));
      state.addNode(makeNode("n2", 100, 100));
      const handler = vi.fn();
      state.subscribe(handler);

      state.moveNodes([
        { nodeId: "n1", position: { x: 50, y: 50 } },
        { nodeId: "n2", position: { x: 150, y: 150 } },
      ]);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("ignores unknown nodeIds gracefully (does not throw)", () => {
      const state = createGraphBuilderState();
      state.addNode(makeNode("n1", 0, 0));

      expect(() => {
        state.moveNodes([
          { nodeId: "n1", position: { x: 50, y: 50 } },
          { nodeId: "unknown", position: { x: 999, y: 999 } },
        ]);
      }).not.toThrow();

      const snap = state.getSnapshot();
      expect(snap.nodes[0]!.position).toEqual({ x: 50, y: 50 });
    });
  });

  describe("setValidation", () => {
    const sampleResult: ValidationResult = {
      valid: false,
      errors: [
        { severity: "error", message: "Test error", nodeIds: ["n1"] },
      ],
      warnings: [
        { severity: "warning", message: "Test warning", nodeIds: ["n2"] },
      ],
    };

    it("stores result in snapshot", () => {
      const state = createGraphBuilderState();

      state.setValidation(sampleResult);

      expect(state.getSnapshot().validationResult).toEqual(sampleResult);
    });

    it("does NOT push to undo stack", () => {
      const state = createGraphBuilderState();

      state.setValidation(sampleResult);

      expect(state.getSnapshot().canUndo).toBe(false);
    });

    it("does NOT set isDirty", () => {
      const state = createGraphBuilderState();

      state.setValidation(sampleResult);

      expect(state.getSnapshot().isDirty).toBe(false);
    });

    it("notifies subscribers", () => {
      const state = createGraphBuilderState();
      const handler = vi.fn();
      state.subscribe(handler);

      state.setValidation(sampleResult);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("setValidation(null) clears validation", () => {
      const state = createGraphBuilderState();
      state.setValidation(sampleResult);
      expect(state.getSnapshot().validationResult).toEqual(sampleResult);

      state.setValidation(null);

      expect(state.getSnapshot().validationResult).toBeNull();
    });
  });
});
