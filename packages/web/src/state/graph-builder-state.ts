/**
 * Reactive state manager for the graph builder with undo/redo support.
 *
 * Follows the same subscribe/getSnapshot pattern as global-state.ts.
 * Graph data mutations (nodes, edges, settings) are tracked in an undo stack.
 * Viewport and selection changes do NOT create undo entries.
 *
 * Uses snapshot-based undo (structuredClone) which is efficient at <=20 nodes.
 */

import type {
  PipelineNode,
  PipelineEdge,
  GraphSettings,
  ValidationResult,
} from "../api/types/index.js";
import {
  DEFAULT_VIEWPORT,
  type ViewportTransform,
} from "../utils/viewport-transform.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Maximum number of undo entries retained */
const MAX_UNDO_DEPTH = 50;

/** Immutable snapshot of the full graph builder state */
export interface GraphBuilderSnapshot {
  readonly nodes: ReadonlyArray<PipelineNode>;
  readonly edges: ReadonlyArray<PipelineEdge>;
  readonly settings: Readonly<GraphSettings>;
  readonly selectedNodeIds: ReadonlySet<string>;
  readonly selectedEdgeId: string | null;
  readonly viewport: Readonly<ViewportTransform>;
  readonly validationResult: Readonly<ValidationResult> | null;
  readonly isDirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** Graph data subset tracked by the undo stack */
interface GraphDataSnapshot {
  readonly nodes: ReadonlyArray<PipelineNode>;
  readonly edges: ReadonlyArray<PipelineEdge>;
  readonly settings: Readonly<GraphSettings>;
}

/** Public interface for the graph builder state manager */
export interface GraphBuilderState {
  /** Subscribe to any state change. Returns an unsubscribe function. */
  subscribe(handler: () => void): () => void;
  /** Return a frozen snapshot of the current state. */
  getSnapshot(): GraphBuilderSnapshot;

  // Graph mutations (push to undo stack)
  addNode(node: PipelineNode): void;
  updateNode(nodeId: string, partial: Partial<PipelineNode>): void;
  removeNode(nodeId: string): void;
  addEdge(source: string, target: string): void;
  removeEdge(edgeId: string): void;
  updateSettings(partial: Partial<GraphSettings>): void;
  moveNodes(updates: Array<{nodeId: string; position: {x: number; y: number}}>): void;

  // Selection (no undo)
  selectNode(nodeId: string, multi?: boolean): void;
  selectAll(): void;
  clearSelection(): void;
  selectEdge(edgeId: string): void;
  clearEdgeSelection(): void;

  // Viewport (no undo, no isDirty)
  setViewport(vt: ViewportTransform): void;

  // Validation (no undo, no isDirty -- derived state)
  setValidation(result: ValidationResult | null): void;

  // Undo/redo
  undo(): void;
  redo(): void;

  // Clean state (after server save -- clears isDirty without resetting undo stack)
  markClean(): void;

  // Reset
  reset(): void;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: GraphSettings = {
  label: "Untitled Pipeline",
  onFailure: "fail-fast",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a reactive graph builder state store with undo/redo support.
 *
 * @returns A GraphBuilderState instance with empty initial state
 */
export function createGraphBuilderState(): GraphBuilderState {
  // Mutable internal state
  let nodes: PipelineNode[] = [];
  let edges: PipelineEdge[] = [];
  let settings: GraphSettings = { ...DEFAULT_SETTINGS };
  let selectedNodeIds = new Set<string>();
  let selectedEdgeId: string | null = null;
  let viewport: ViewportTransform = { ...DEFAULT_VIEWPORT };
  let validationResult: ValidationResult | null = null;
  let isDirty = false;

  // Undo/redo stacks
  let undoStack: GraphDataSnapshot[] = [];
  let redoStack: GraphDataSnapshot[] = [];

  // Subscribers
  const subscribers = new Set<() => void>();

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function notifyAll(): void {
    for (const handler of subscribers) {
      handler();
    }
  }

  /** Snapshot current graph data for undo stack */
  function currentGraphData(): GraphDataSnapshot {
    return structuredClone({ nodes, edges, settings });
  }

  /** Push current state to undo stack before a mutation */
  function pushUndo(): void {
    undoStack.push(currentGraphData());
    if (undoStack.length > MAX_UNDO_DEPTH) {
      undoStack.shift();
    }
    redoStack = [];
  }

  /** Restore graph data from a snapshot */
  function restoreGraphData(snap: GraphDataSnapshot): void {
    nodes = structuredClone(snap.nodes) as PipelineNode[];
    edges = structuredClone(snap.edges) as PipelineEdge[];
    settings = structuredClone(snap.settings) as GraphSettings;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    subscribe(handler: () => void): () => void {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    getSnapshot(): GraphBuilderSnapshot {
      return Object.freeze({
        nodes: [...nodes],
        edges: [...edges],
        settings: { ...settings },
        selectedNodeIds: new Set(selectedNodeIds),
        selectedEdgeId,
        viewport: { ...viewport },
        validationResult,
        isDirty,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
      });
    },

    // -- Graph mutations (push undo) ----------------------------------------

    addNode(node: PipelineNode): void {
      pushUndo();
      nodes.push(node);
      isDirty = true;
      notifyAll();
    },

    updateNode(nodeId: string, partial: Partial<PipelineNode>): void {
      pushUndo();
      nodes = nodes.map((n) =>
        n.id === nodeId ? { ...n, ...partial, id: n.id } : n,
      );
      isDirty = true;
      notifyAll();
    },

    removeNode(nodeId: string): void {
      pushUndo();
      nodes = nodes.filter((n) => n.id !== nodeId);
      edges = edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
      isDirty = true;
      notifyAll();
    },

    addEdge(source: string, target: string): void {
      pushUndo();
      const edge: PipelineEdge = { id: `${source}->${target}`, source, target };
      edges.push(edge);
      isDirty = true;
      notifyAll();
    },

    removeEdge(edgeId: string): void {
      pushUndo();
      edges = edges.filter((e) => e.id !== edgeId);
      isDirty = true;
      notifyAll();
    },

    updateSettings(partial: Partial<GraphSettings>): void {
      pushUndo();
      settings = { ...settings, ...partial };
      isDirty = true;
      notifyAll();
    },

    moveNodes(updates: Array<{nodeId: string; position: {x: number; y: number}}>): void {
      pushUndo();
      for (const { nodeId, position } of updates) {
        nodes = nodes.map(n => n.id === nodeId ? { ...n, position } : n);
      }
      isDirty = true;
      notifyAll();
    },

    // -- Selection (no undo) ------------------------------------------------

    selectNode(nodeId: string, multi = false): void {
      selectedEdgeId = null;
      if (multi) {
        selectedNodeIds = new Set(selectedNodeIds);
        selectedNodeIds.add(nodeId);
      } else {
        selectedNodeIds = new Set([nodeId]);
      }
      notifyAll();
    },

    selectAll(): void {
      selectedNodeIds = new Set(nodes.map((n) => n.id));
      notifyAll();
    },

    clearSelection(): void {
      selectedNodeIds = new Set();
      selectedEdgeId = null;
      notifyAll();
    },

    selectEdge(edgeId: string): void {
      selectedEdgeId = edgeId;
      selectedNodeIds = new Set();
      notifyAll();
    },

    clearEdgeSelection(): void {
      selectedEdgeId = null;
      notifyAll();
    },

    // -- Viewport (no undo, no isDirty) ------------------------------------

    setViewport(vt: ViewportTransform): void {
      viewport = { ...vt };
      notifyAll();
    },

    // -- Validation (no undo, no isDirty) ----------------------------------

    setValidation(result: ValidationResult | null): void {
      validationResult = result;
      notifyAll();
    },

    // -- Undo/redo ---------------------------------------------------------

    undo(): void {
      if (undoStack.length === 0) return;
      redoStack.push(currentGraphData());
      const prev = undoStack.pop()!;
      restoreGraphData(prev);
      isDirty = true;
      notifyAll();
    },

    redo(): void {
      if (redoStack.length === 0) return;
      undoStack.push(currentGraphData());
      const next = redoStack.pop()!;
      restoreGraphData(next);
      isDirty = true;
      notifyAll();
    },

    // -- Clean state (after server save) ------------------------------------

    markClean(): void {
      isDirty = false;
      notifyAll();
    },

    // -- Reset -------------------------------------------------------------

    reset(): void {
      nodes = [];
      edges = [];
      settings = { ...DEFAULT_SETTINGS };
      selectedNodeIds = new Set();
      selectedEdgeId = null;
      viewport = { ...DEFAULT_VIEWPORT };
      validationResult = null;
      isDirty = false;
      undoStack = [];
      redoStack = [];
      notifyAll();
    },
  };
}
