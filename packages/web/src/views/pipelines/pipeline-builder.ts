// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { PipelineNode, PipelineEdge, GraphSettings, ValidationResult } from "../../api/types/index.js";
import "../../components/nav/ic-breadcrumb.js";
import type { BreadcrumbItem } from "../../components/nav/ic-breadcrumb.js";
import {
  createGraphBuilderState,
  type GraphBuilderState,
} from "../../state/graph-builder-state.js";
import type { ViewportTransform } from "../../utils/viewport-transform.js";
import { zoomAtPoint, MIN_SCALE, MAX_SCALE } from "../../utils/viewport-transform.js";
import { screenToGraph } from "../../utils/viewport-transform.js";
import { wouldCreateCycle } from "../../utils/cycle-detection.js";
import { autoLayout, computeFitViewport } from "../../utils/graph-layout.js";
import { NODE_WIDTH, NODE_FIXED_HEIGHT } from "../../utils/edge-geometry.js";
import "../../components/graph/ic-graph-canvas.js";
import type { IcGraphCanvas } from "../../components/graph/ic-graph-canvas.js";
import "../../components/graph/ic-graph-settings.js";
import "../../components/graph/ic-graph-validation.js";
import { validateGraph } from "../../utils/graph-validation.js";
import "../../components/graph/ic-node-editor.js";
import "../../components/feedback/ic-confirm-dialog.js";
import "../../components/graph/ic-template-picker.js";
import "../../components/graph/ic-variable-prompt.js";
import { IcToast } from "../../components/feedback/ic-toast.js";
import "../../components/feedback/ic-toast.js";
import { extractVariables, substituteVariables } from "../../utils/extract-variables.js";

/** Grid size for snap-to-grid and nudge operations (px) */
const GRID_SIZE = 24;

@customElement("ic-pipeline-builder")
export class IcPipelineBuilder extends LitElement {
  static override styles = [sharedStyles, focusStyles, css`
    :host { display: block; height: 100%; }
    .builder-container { display: flex; flex-direction: column; height: calc(100vh - 120px); }
    .toolbar { display: flex; gap: 4px; padding: 4px 0; }
    .toolbar-btn { padding: 4px 12px; background: var(--ic-surface-2); border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-sm); color: var(--ic-text-muted); font-size: var(--ic-text-xs); cursor: pointer; }
    .toolbar-btn:hover { background: var(--ic-accent); color: var(--ic-text); }
    .toolbar-btn--active { background: var(--ic-accent); color: var(--ic-text); border-color: var(--ic-accent); }
    .builder-body { display: flex; flex: 1; overflow: hidden; }
    .canvas-area { flex: 1; position: relative; border: 1px solid var(--ic-border); border-radius: var(--ic-radius-md);
      background: var(--ic-bg); overflow: hidden; }
    .mobile-message { display: none; text-align: center; padding: 3rem 1.5rem; color: var(--ic-text-muted); }
    .mobile-message h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    .mobile-message p { font-size: var(--ic-text-sm); color: var(--ic-text-dim); }
    @media (max-width: 767px) {
      .builder-container { display: none; }
      .mobile-message { display: block; }
    }
  `];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property() graphId = "";

  private _graphState: GraphBuilderState | null = null;
  private _stateUnsub: (() => void) | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;
  private _serverLoadDone = false;
  private _nodeCounter = 0;

  @state() private _viewport: ViewportTransform = { x: 0, y: 0, scale: 1.0 };
  @state() private _nodes: ReadonlyArray<PipelineNode> = [];
  @state() private _edges: ReadonlyArray<PipelineEdge> = [];
  @state() private _selectedNodeIds: ReadonlySet<string> = new Set();
  @state() private _selectedEdgeId: string | null = null;
  @state() private _showDeleteConfirm = false;
  @state() private _deleteMessage = "";
  @state() private _snapToGrid = false;
  @state() private _validationResult: ValidationResult | null = null;
  @state() private _settings: GraphSettings = { label: "Untitled Pipeline", onFailure: "fail-fast" };
  @state() private _highlightNodeIds: string[] = [];
  @state() private _validateResultText = "";
  @state() private _showTemplatePicker = false;
  @state() private _showVariablePrompt = false;
  @state() private _variableNames: string[] = [];
  @state() private _draftId = "";
  @state() private _isDirty = false;
  private _pendingDeleteNodeIds: string[] = [];
  private _pendingDeleteEdgeId: string | null = null;
  private _validationTimer: ReturnType<typeof setTimeout> | null = null;
  private _beforeUnloadHandler = (e: BeforeUnloadEvent): void => {
    if (this._isDirty) { e.preventDefault(); }
  };
  private _hashChangeHandler = (): void => {
    // SPA navigation guard: if dirty, confirm before leaving
    if (this._isDirty && this._builderHash) {
      const leave = window.confirm("You have unsaved changes. Leave anyway?");
      if (!leave) {
        window.location.hash = this._builderHash;
      }
    }
  };
  private _builderHash = "";

  override connectedCallback(): void {
    super.connectedCallback();
    this._graphState = createGraphBuilderState();
    this._stateUnsub = this._graphState.subscribe(() => {
      const snap = this._graphState!.getSnapshot();
      this._viewport = snap.viewport;
      this._nodes = snap.nodes;
      this._edges = snap.edges;
      this._selectedNodeIds = snap.selectedNodeIds;
      this._selectedEdgeId = snap.selectedEdgeId;
      this._settings = snap.settings;
      this._isDirty = snap.isDirty;

      // Debounced reactive validation (150ms to avoid flash on keystroke)
      if (this._validationTimer) clearTimeout(this._validationTimer);
      this._validationTimer = setTimeout(() => {
        const result = validateGraph(this._nodes, this._edges);
        this._graphState?.setValidation(result);
        this._validationResult = result;
      }, 150);
    });
    // Sync initial values from state
    const snap = this._graphState.getSnapshot();
    this._viewport = snap.viewport;
    this._nodes = snap.nodes;
    this._edges = snap.edges;
    this._selectedNodeIds = snap.selectedNodeIds;
    this._selectedEdgeId = snap.selectedEdgeId;
    this._settings = snap.settings;

    document.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("beforeunload", this._beforeUnloadHandler);

    // Record current hash for SPA navigation guard
    this._builderHash = window.location.hash;
    window.addEventListener("hashchange", this._hashChangeHandler);

    // Graph loading: if editing existing graph, load from server
    if (this.graphId) {
      this._draftId = this.graphId;
      this._loadGraph();
    } else {
      // New pipeline: generate ID and show template picker
      this._draftId = crypto.randomUUID();
      this._showTemplatePicker = true;
    }
  }

  override disconnectedCallback(): void {
    document.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("beforeunload", this._beforeUnloadHandler);
    window.removeEventListener("hashchange", this._hashChangeHandler);
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
    if (this._validationTimer) {
      clearTimeout(this._validationTimer);
      this._validationTimer = null;
    }
    if (this._stateUnsub) {
      this._stateUnsub();
      this._stateUnsub = null;
    }
    this._graphState = null;
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient && this.graphId && !this._serverLoadDone) {
      this._rpcStatusUnsub?.();
      if (this.rpcClient.status === "connected") {
        this._loadGraph();
      } else {
        this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
          if (status === "connected" && !this._serverLoadDone) {
            this._rpcStatusUnsub = null;
            this._loadGraph();
          }
        });
      }
    }
  }

  private get _breadcrumbs(): BreadcrumbItem[] {
    const items: BreadcrumbItem[] = [{ label: "Pipelines", route: "pipelines" }];
    if (this.graphId) {
      items.push({ label: this.graphId });
      items.push({ label: "Edit" });
    } else {
      items.push({ label: "New Pipeline" });
    }
    return items;
  }

  // -- Event handlers -------------------------------------------------------

  /** Handle node selection (click or Shift+click for multi-select). */
  private _onNodeSelect(e: CustomEvent<{ nodeId: string; multi: boolean }>): void {
    const { nodeId, multi } = e.detail;
    this._graphState?.selectNode(nodeId, multi);
  }

  /** Handle batch node position update after drag completes. */
  private _onNodeDragEnd(
    e: CustomEvent<{ moves: Array<{ nodeId: string; position: { x: number; y: number } }> }>,
  ): void {
    this._graphState?.moveNodes(e.detail.moves);
  }

  /** Handle edge creation with cycle detection, duplicate, and self-loop guards. */
  private _onEdgeCreate(e: CustomEvent<{ source: string; target: string }>): void {
    const { source, target } = e.detail;
    const snap = this._graphState?.getSnapshot();
    if (!snap) return;

    // Guard: no self-loops
    if (source === target) return;

    // Guard: no duplicate edges
    if (snap.edges.some((edge) => edge.source === source && edge.target === target)) return;

    // Guard: no cycles
    if (wouldCreateCycle(snap.edges, source, target)) return;

    this._graphState?.addEdge(source, target);

    // Sync dependsOn on the target node
    const targetNode = snap.nodes.find((n) => n.id === target);
    if (targetNode && !targetNode.dependsOn.includes(source)) {
      this._graphState?.updateNode(target, {
        dependsOn: [...targetNode.dependsOn, source],
      });
    }
  }

  /** Handle canvas click (deselect all). */
  private _onCanvasClick(): void {
    this._graphState?.clearSelection();
  }

  /** Handle highlight-nodes event from validation bar. */
  private _onHighlightNodes(e: CustomEvent<{ nodeIds: string[] }>): void {
    this._highlightNodeIds = e.detail.nodeIds;
    // Auto-clear after 3 seconds
    setTimeout(() => { this._highlightNodeIds = []; }, 3000);
  }

  // -- Node editor panel event handlers --------------------------------------

  /** Handle node-update event from the editor panel. */
  private _onNodeUpdate(e: CustomEvent<{ nodeId: string; partial: Partial<PipelineNode> }>): void {
    this._graphState?.updateNode(e.detail.nodeId, e.detail.partial);
  }

  /** Handle node-delete event from the editor panel. */
  private _onNodeDelete(e: CustomEvent<{ nodeId: string }>): void {
    // Reuse existing delete logic -- select the node then call _deleteSelected
    this._graphState?.selectNode(e.detail.nodeId);
    this._deleteSelected();
  }

  /** Handle node-duplicate event from the editor panel. */
  private _onNodeDuplicate(e: CustomEvent<{ nodeId: string }>): void {
    // Reuse existing duplicate logic -- select the node then call _duplicateSelected
    this._graphState?.selectNode(e.detail.nodeId);
    this._duplicateSelected();
  }

  /** Handle edge-add event from the editor panel (dependency checkbox). */
  private _onEditorEdgeAdd(e: CustomEvent<{ source: string; target: string }>): void {
    const { source, target } = e.detail;
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();

    // Guard: self-loop
    if (source === target) return;

    // Guard: duplicate edge
    if (snap.edges.some((edge) => edge.source === source && edge.target === target)) return;

    // Guard: cycle detection
    if (wouldCreateCycle(snap.edges, source, target)) return;

    // Add edge
    this._graphState.addEdge(source, target);

    // Sync dependsOn on the target node (add source to dependsOn if not present)
    const targetNode = snap.nodes.find((n) => n.id === target);
    if (targetNode && !targetNode.dependsOn.includes(source)) {
      this._graphState.updateNode(target, {
        dependsOn: [...targetNode.dependsOn, source],
      });
    }
  }

  /** Handle edge-remove event from the editor panel (dependency uncheck). */
  private _onEditorEdgeRemove(e: CustomEvent<{ source: string; target: string }>): void {
    const { source, target } = e.detail;
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();

    // Find and remove the edge
    const edgeId = `${source}->${target}`;
    const edge = snap.edges.find((e) => e.id === edgeId);
    if (edge) {
      this._graphState.removeEdge(edgeId);
    }

    // Sync dependsOn on the target node (remove source from dependsOn)
    const targetNode = snap.nodes.find((n) => n.id === target);
    if (targetNode) {
      const newDeps = targetNode.dependsOn.filter((d) => d !== source);
      this._graphState.updateNode(target, {
        dependsOn: newDeps,
      });
    }
  }

  /** Handle Validate button -- call graph.define RPC. */
  private async _onValidate(): Promise<void> {
    if (!this.rpcClient || !this._graphState) return;
    const snap = this._graphState.getSnapshot();

    // Build RPC payload: map PipelineNode.id -> nodeId, derive dependsOn from edges
    const payload = {
      nodes: snap.nodes.map((n) => {
        // Derive dependsOn from edges (edges are source of truth)
        const deps = snap.edges.filter((e) => e.target === n.id).map((e) => e.source);
        return {
          nodeId: n.id,
          task: n.task,
          agentId: n.agentId,
          dependsOn: deps,
          maxSteps: n.maxSteps,
          timeoutMs: n.timeoutMs,
          barrierMode: n.barrierMode,
          model: n.modelId,
          retries: n.retries,
          type_id: n.typeId,
          type_config: n.typeConfig,
          context_mode: n.contextMode,
        };
      }),
      label: snap.settings.label || undefined,
      onFailure: snap.settings.onFailure,
      timeoutMs: snap.settings.timeoutMs,
      budget: snap.settings.budget,
    };

    try {
      const result = await this.rpcClient.call("graph.define", payload);
      const r = result as Record<string, unknown>;
      this._validateResultText = `Valid: ${r.nodeCount ?? snap.nodes.length} nodes${
        Array.isArray(r.executionOrder) ? `, order: ${(r.executionOrder as string[]).join(" -> ")}` : ""
      }`;
    } catch (err: unknown) {
      this._validateResultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // -- Keyboard shortcuts ---------------------------------------------------

  /** Global keyboard shortcut handler (arrow function for auto-bound this). */
  private _onKeyDown = (e: KeyboardEvent): void => {
    // Guard: do not intercept shortcuts when typing in form elements.
    // Use composedPath()[0] to see through shadow DOM boundaries --
    // e.target is retargeted to the host element, but the real target
    // (inside ic-node-editor's shadow DOM) is a form field.
    const deepTarget = e.composedPath()[0];
    if (
      deepTarget instanceof HTMLInputElement ||
      deepTarget instanceof HTMLTextAreaElement ||
      deepTarget instanceof HTMLSelectElement
    ) {
      return;
    }
    if (deepTarget instanceof Element && deepTarget.closest("[contenteditable]")) {
      return;
    }

    const isMeta = e.metaKey || e.ctrlKey;

    // 1. Cmd+Shift+Z -- redo (check before Cmd+Z)
    if (isMeta && e.shiftKey && e.key === "z") {
      e.preventDefault();
      this._graphState?.redo();
      return;
    }

    // 2. Cmd+Z -- undo
    if (isMeta && !e.shiftKey && e.key === "z") {
      e.preventDefault();
      this._graphState?.undo();
      return;
    }

    // 3. Cmd+A -- select all
    if (isMeta && e.key === "a") {
      e.preventDefault();
      this._graphState?.selectAll();
      return;
    }

    // 4. Cmd+D -- duplicate selected
    if (isMeta && e.key === "d") {
      e.preventDefault();
      this._duplicateSelected();
      return;
    }

    // Skip remaining shortcuts if meta/ctrl is held (avoid interfering with browser shortcuts)
    if (isMeta) return;

    // 5. Backspace/Delete -- delete selected
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      this._deleteSelected();
      return;
    }

    // 6. Escape -- clear selection and cancel in-progress interactions
    if (e.key === "Escape") {
      this._graphState?.clearSelection();
      const canvas = this.renderRoot.querySelector("ic-graph-canvas") as IcGraphCanvas | null;
      canvas?.cancelInteraction();
      return;
    }

    // 7. N -- add node at viewport center
    if (e.key === "n" || e.key === "N") {
      this._addNodeAtViewportCenter();
      return;
    }

    // 8. F -- fit view
    if (e.key === "f" || e.key === "F") {
      this._fitView();
      return;
    }

    // 9. L -- auto-layout
    if (e.key === "l" || e.key === "L") {
      this._autoLayout();
      return;
    }

    // 10. + or = -- zoom in
    if (e.key === "+" || e.key === "=") {
      this._zoomStep(1);
      return;
    }

    // 11. - -- zoom out
    if (e.key === "-") {
      this._zoomStep(-1);
      return;
    }

    // 12. 0 -- reset zoom
    if (e.key === "0") {
      this._graphState?.setViewport({ x: 0, y: 0, scale: 1.0 });
      return;
    }

    // 13. Tab -- cycle node selection
    if (e.key === "Tab") {
      e.preventDefault();
      this._cycleNodeSelection(e.shiftKey ? -1 : 1);
      return;
    }

    // 14. Arrow keys -- nudge selected nodes
    if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      this._nudgeSelected(e.key);
      return;
    }
  };

  // -- Shortcut helper methods ----------------------------------------------

  /** Add a new node at the current viewport center. */
  private _addNodeAtViewportCenter(): void {
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();

    // Generate a unique node ID
    this._nodeCounter = Math.max(this._nodeCounter, snap.nodes.length);
    let nodeId: string;
    do {
      this._nodeCounter++;
      nodeId = `node-${this._nodeCounter}`;
    } while (snap.nodes.some((n) => n.id === nodeId));

    // Calculate viewport center in graph space
    const canvasArea = this.renderRoot.querySelector(".canvas-area");
    const rect = canvasArea?.getBoundingClientRect();
    let cx = 200;
    let cy = 200;
    if (rect) {
      const graphCenter = screenToGraph(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        rect as DOMRect,
        this._viewport,
      );
      cx = graphCenter.x - NODE_WIDTH / 2;
      cy = graphCenter.y - NODE_FIXED_HEIGHT / 2;
    }

    this._graphState.addNode({
      id: nodeId,
      task: "",
      dependsOn: [],
      position: { x: cx, y: cy },
    });
  }

  /** Duplicate all selected nodes (offset +60x +40y, no edges copied). */
  private _duplicateSelected(): void {
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();
    if (snap.selectedNodeIds.size === 0) return;

    for (const selectedId of snap.selectedNodeIds) {
      const node = snap.nodes.find((n) => n.id === selectedId);
      if (!node) continue;

      // Generate unique copy ID
      let copyId = `${node.id}-copy`;
      let suffix = 1;
      const allIds = new Set(snap.nodes.map((n) => n.id));
      while (allIds.has(copyId)) {
        suffix++;
        copyId = `${node.id}-copy-${suffix}`;
      }
      allIds.add(copyId);

      this._graphState.addNode({
        id: copyId,
        task: node.task,
        agentId: node.agentId,
        dependsOn: [],
        maxSteps: node.maxSteps,
        timeoutMs: node.timeoutMs,
        barrierMode: node.barrierMode,
        modelId: node.modelId,
        retries: node.retries,
        typeId: node.typeId,
        typeConfig: node.typeConfig ? { ...node.typeConfig } : undefined,
        contextMode: node.contextMode,
        position: { x: node.position.x + 60, y: node.position.y + 40 },
      });
    }
  }

  /** Delete selected nodes/edges, showing confirmation if dependents exist. */
  private _deleteSelected(): void {
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();

    // Check for selected edge
    if (snap.selectedEdgeId && snap.selectedNodeIds.size === 0) {
      this._graphState.removeEdge(snap.selectedEdgeId);
      return;
    }

    if (snap.selectedNodeIds.size === 0) return;

    // Check if any selected node has downstream dependents (edges where source = selected)
    const selectedIds = [...snap.selectedNodeIds];
    const dependentNames: string[] = [];

    for (const nodeId of selectedIds) {
      for (const edge of snap.edges) {
        if (edge.source === nodeId && !snap.selectedNodeIds.has(edge.target)) {
          dependentNames.push(`"${edge.target}" depends on "${nodeId}"`);
        }
      }
    }

    if (dependentNames.length > 0) {
      // Show confirmation dialog
      this._deleteMessage = `Deleting will break dependencies:\n${dependentNames.join("\n")}`;
      this._pendingDeleteNodeIds = selectedIds;
      this._showDeleteConfirm = true;
    } else {
      // No dependents -- delete immediately
      for (const nodeId of selectedIds) {
        this._graphState.removeNode(nodeId);
      }
    }
  }

  /** Execute pending deletion after user confirms. */
  private _confirmDelete(): void {
    if (!this._graphState) return;

    for (const nodeId of this._pendingDeleteNodeIds) {
      this._graphState.removeNode(nodeId);
    }
    if (this._pendingDeleteEdgeId) {
      this._graphState.removeEdge(this._pendingDeleteEdgeId);
    }

    this._showDeleteConfirm = false;
    this._pendingDeleteNodeIds = [];
    this._pendingDeleteEdgeId = null;
  }

  /** Fit all nodes in the viewport. */
  private _fitView(): void {
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();
    if (snap.nodes.length === 0) return;

    const canvasArea = this.renderRoot.querySelector(".canvas-area");
    const rect = canvasArea?.getBoundingClientRect();
    if (!rect) return;

    const result = computeFitViewport(snap.nodes, rect.width, rect.height);
    this._graphState.setViewport(result);
  }

  /** Apply dagre auto-layout to all nodes. */
  private _autoLayout(): void {
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();
    if (snap.nodes.length === 0) return;

    const result = autoLayout(snap.nodes, snap.edges);
    const updates: Array<{ nodeId: string; position: { x: number; y: number } }> = [];

    for (const [nodeId, position] of result.positions) {
      updates.push({ nodeId, position });
    }

    this._graphState.moveNodes(updates);
  }

  /** Zoom in (+1) or out (-1) centered on canvas center. */
  private _zoomStep(direction: number): void {
    if (!this._graphState) return;

    const canvasArea = this.renderRoot.querySelector(".canvas-area");
    const rect = canvasArea?.getBoundingClientRect();
    if (!rect) return;

    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    // Positive delta = zoom out, negative = zoom in (per zoomAtPoint convention)
    const delta = direction > 0 ? -100 : 100;
    const result = zoomAtPoint(this._viewport, centerX, centerY, delta, MIN_SCALE, MAX_SCALE);
    this._graphState.setViewport(result);
  }

  /** Cycle Tab selection through nodes sorted by visual position. */
  private _cycleNodeSelection(direction: number): void {
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();
    if (snap.nodes.length === 0) return;

    // Sort by y ascending, then x ascending
    const sorted = [...snap.nodes].sort((a, b) => {
      if (a.position.y !== b.position.y) return a.position.y - b.position.y;
      return a.position.x - b.position.x;
    });

    // Find current selection index
    let currentIndex = -1;
    if (snap.selectedNodeIds.size === 1) {
      const selectedId = [...snap.selectedNodeIds][0];
      currentIndex = sorted.findIndex((n) => n.id === selectedId);
    }

    // Move by direction, wrapping around
    let nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = sorted.length - 1;
    if (nextIndex >= sorted.length) nextIndex = 0;

    this._graphState.selectNode(sorted[nextIndex].id);
  }

  /** Nudge all selected nodes by one grid step in the arrow direction. */
  private _nudgeSelected(key: string): void {
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();
    if (snap.selectedNodeIds.size === 0) return;

    let dx = 0;
    let dy = 0;
    switch (key) {
      case "ArrowUp":    dy = -GRID_SIZE; break;
      case "ArrowDown":  dy =  GRID_SIZE; break;
      case "ArrowLeft":  dx = -GRID_SIZE; break;
      case "ArrowRight": dx =  GRID_SIZE; break;
    }

    const updates: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    for (const nodeId of snap.selectedNodeIds) {
      const node = snap.nodes.find((n) => n.id === nodeId);
      if (!node) continue;

      let newX = node.position.x + dx;
      let newY = node.position.y + dy;

      if (this._snapToGrid) {
        newX = Math.round(newX / GRID_SIZE) * GRID_SIZE;
        newY = Math.round(newY / GRID_SIZE) * GRID_SIZE;
      }

      updates.push({ nodeId, position: { x: newX, y: newY } });
    }

    this._graphState.moveNodes(updates);
  }

  // -- Graph loading, template picker, draft persistence, run execution -----

  /** Load graph data from server. If server load fails, graph will show empty canvas. */
  private async _loadGraph(): Promise<void> {
    if (!this._graphState || !this.graphId) return;

    if (this.rpcClient) {
      try {
        const serverGraph = (await this.rpcClient.call("graph.load", { id: this.graphId })) as {
          label?: string;
          nodes: Array<Record<string, unknown>>;
          edges: PipelineEdge[];
          settings: GraphSettings;
        };
        if (serverGraph && this._graphState) {
          this._graphState.reset();

          // Server nodes may be in execution format (nodeId, agent, dependsOn)
          // rather than canvas format (id, agentId, position). Transform them.
          const canvasNodes: PipelineNode[] = [];
          const canvasEdges: PipelineEdge[] = [];

          for (const raw of serverGraph.nodes) {
            const id = (raw.id ?? raw.nodeId) as string;
            const node: PipelineNode = {
              id,
              task: (raw.task as string) ?? "",
              agentId: (raw.agentId ?? raw.agent) as string | undefined,
              dependsOn: (raw.dependsOn as string[]) ?? [],
              maxSteps: raw.maxSteps as number | undefined,
              timeoutMs: raw.timeoutMs as number | undefined,
              barrierMode: raw.barrierMode as PipelineNode["barrierMode"],
              modelId: (raw.modelId ?? raw.model) as string | undefined,
              retries: typeof raw.retries === "number" ? raw.retries : undefined,
              contextMode: (raw.contextMode === "full" || raw.contextMode === "summary" || raw.contextMode === "none") ? raw.contextMode : (raw.context_mode === "full" || raw.context_mode === "summary" || raw.context_mode === "none") ? raw.context_mode as PipelineNode["contextMode"] : undefined,
              typeId: raw.typeId as PipelineNode["typeId"],
              typeConfig: raw.typeConfig && typeof raw.typeConfig === "object" ? raw.typeConfig as Record<string, unknown> : undefined,
              position: (raw.position as PipelineNode["position"]) ?? { x: 0, y: 0 },
            };
            canvasNodes.push(node);
          }

          // Derive edges from node.dependsOn (execution format stores deps on nodes)
          if (serverGraph.edges && serverGraph.edges.length > 0) {
            for (const edge of serverGraph.edges) {
              canvasEdges.push(edge);
            }
          } else {
            for (const node of canvasNodes) {
              for (const dep of node.dependsOn) {
                canvasEdges.push({
                  id: `${dep}->${node.id}`,
                  source: dep,
                  target: node.id,
                });
              }
            }
          }

          // Auto-layout nodes that lack real positions (all at 0,0)
          const needsLayout = canvasNodes.length > 0 &&
            canvasNodes.every((n) => n.position.x === 0 && n.position.y === 0);
          if (needsLayout) {
            const layout = autoLayout(canvasNodes, canvasEdges);
            for (const node of canvasNodes) {
              const pos = layout.positions.get(node.id);
              if (pos) {
                (node as { position: { x: number; y: number } }).position = pos;
              }
            }
          }

          for (const node of canvasNodes) {
            this._graphState.addNode(node);
          }
          for (const edge of canvasEdges) {
            this._graphState.addEdge(edge.source, edge.target);
          }

          // Apply label and settings from server
          const settings: Partial<GraphSettings> = {
            ...serverGraph.settings,
            ...(serverGraph.label ? { label: serverGraph.label } : {}),
          };
          if (Object.keys(settings).length > 0) {
            this._graphState.updateSettings(settings);
          }

          this._serverLoadDone = true;
        }
      } catch {
        // Server unavailable -- graph will show empty canvas
      }
    }
  }

  /** Handle template selection from the picker modal. */
  private _onTemplateSelect(e: CustomEvent<{ nodes: PipelineNode[]; edges: PipelineEdge[]; settings: Partial<GraphSettings> }>): void {
    if (!this._graphState) return;
    const { nodes, edges, settings } = e.detail;
    this._graphState.reset();
    for (const node of nodes) { this._graphState.addNode(node); }
    for (const edge of edges) { this._graphState.addEdge(edge.source, edge.target); }
    if (settings.label || settings.onFailure) { this._graphState.updateSettings(settings); }
    this._showTemplatePicker = false;
  }

  /** Handle save-draft event from settings bar -- saves to server only. */
  private async _onSaveDraft(): Promise<void> {
    if (!this._graphState) return;
    const snap = this._graphState.getSnapshot();

    if (!this.rpcClient) {
      IcToast.show("Cannot save: not connected to daemon", "error");
      return;
    }

    try {
      await this.rpcClient.call("graph.save", {
        id: this._draftId,
        label: snap.settings.label,
        nodes: snap.nodes,
        edges: snap.edges,
        settings: snap.settings,
      });
      this._graphState.markClean();
      IcToast.show("Pipeline saved", "success");
    } catch (err: unknown) {
      IcToast.show(
        `Save failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
    }
  }

  /** Handle run event from settings bar -- call graph.execute RPC. */
  private async _onRun(): Promise<void> {
    if (!this.rpcClient || !this._graphState) return;
    const snap = this._graphState.getSnapshot();

    // Check for ${VAR} user-variable placeholders before executing
    const taskTexts = snap.nodes.map((n) => n.task);
    const vars = extractVariables(taskTexts);
    if (vars.length > 0) {
      this._variableNames = vars;
      this._showVariablePrompt = true;
      return;
    }

    // No variables -- execute directly
    await this._executeGraph(snap.nodes.map((n) => n.task));
  }

  /** Handle variable prompt confirmation -- substitute and execute. */
  private async _onVariableConfirm(
    e: CustomEvent<{ values: Record<string, string> }>,
  ): Promise<void> {
    this._showVariablePrompt = false;
    if (!this.rpcClient || !this._graphState) return;
    const snap = this._graphState.getSnapshot();

    // Substitute variables in each node's task text
    const substitutedTasks = snap.nodes.map((n) =>
      substituteVariables(n.task, e.detail.values),
    );

    await this._executeGraph(substitutedTasks);
  }

  /** Build payload and call graph.execute RPC with the given task texts. */
  private async _executeGraph(taskTexts: string[]): Promise<void> {
    if (!this.rpcClient || !this._graphState) return;
    const snap = this._graphState.getSnapshot();

    const payload = {
      nodes: snap.nodes.map((n, i) => {
        const deps = snap.edges.filter((e) => e.target === n.id).map((e) => e.source);
        return {
          nodeId: n.id,
          task: taskTexts[i],
          agentId: n.agentId,
          dependsOn: deps,
          maxSteps: n.maxSteps,
          timeoutMs: n.timeoutMs,
          barrierMode: n.barrierMode,
          model: n.modelId,
          retries: n.retries,
          type_id: n.typeId,
          type_config: n.typeConfig,
          context_mode: n.contextMode,
        };
      }),
      label: snap.settings.label || undefined,
      onFailure: snap.settings.onFailure,
      timeoutMs: snap.settings.timeoutMs,
      budget: snap.settings.budget,
    };

    try {
      const result = await this.rpcClient.call("graph.execute", payload) as { graphId: string };
      // Navigate to monitor view
      this.dispatchEvent(new CustomEvent("navigate", {
        detail: `pipelines/${result.graphId}`,
        bubbles: true,
        composed: true,
      }));
    } catch (err: unknown) {
      IcToast.show(`Run failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  override render() {
    // Compute selected node for editor panel (only when exactly 1 node selected)
    const snap = this._graphState?.getSnapshot();
    const selectedNode = (snap && snap.selectedNodeIds.size === 1)
      ? snap.nodes.find((n) => snap.selectedNodeIds.has(n.id)) ?? null
      : null;

    return html`
      <ic-breadcrumb .items=${this._breadcrumbs}
        @navigate=${(e: CustomEvent<string>) => this.dispatchEvent(new CustomEvent("navigate", { detail: e.detail, bubbles: true, composed: true }))}
      ></ic-breadcrumb>
      <div class="mobile-message">
        <h2>Desktop Required</h2>
        <p>The pipeline builder requires a desktop browser. Please use a screen wider than 768px.</p>
      </div>
      <div class="builder-container">
        <ic-graph-settings
          .settings=${this._settings}
          .hasErrors=${(this._validationResult?.errors.length ?? 0) > 0}
          .isDirty=${this._isDirty}
          .validateResult=${this._validateResultText}
          @settings-change=${(e: CustomEvent<Partial<GraphSettings>>) => this._graphState?.updateSettings(e.detail)}
          @validate=${this._onValidate}
          @save-draft=${this._onSaveDraft}
          @run=${this._onRun}
        ></ic-graph-settings>
        <div class="toolbar">
          <button class="toolbar-btn ${this._snapToGrid ? "toolbar-btn--active" : ""}"
            @click=${() => { this._snapToGrid = !this._snapToGrid; }}
            title="Snap to grid (24px)">Grid</button>
          <button class="toolbar-btn"
            @click=${() => { this._showTemplatePicker = true; }}
            title="Choose a template">Templates</button>
        </div>
        <div class="builder-body">
          <div class="canvas-area">
            <ic-graph-canvas
              .viewport=${this._viewport}
              .nodes=${this._nodes}
              .edges=${this._edges}
              .selectedNodeIds=${this._selectedNodeIds}
              .selectedEdgeId=${this._selectedEdgeId}
              .snapToGrid=${this._snapToGrid}
              .highlightNodeIds=${this._highlightNodeIds}
              @viewport-change=${(e: CustomEvent<ViewportTransform>) => {
                this._graphState?.setViewport(e.detail);
              }}
              @edge-select=${(e: CustomEvent<string>) => {
                this._graphState?.selectEdge(e.detail);
              }}
              @node-select=${this._onNodeSelect}
              @node-drag-end=${this._onNodeDragEnd}
              @edge-create=${this._onEdgeCreate}
              @canvas-click=${this._onCanvasClick}
            ></ic-graph-canvas>
            <ic-graph-validation
              .validationResult=${this._validationResult}
              @highlight-nodes=${this._onHighlightNodes}
            ></ic-graph-validation>
          </div>
          ${selectedNode ? html`
            <ic-node-editor
              .node=${selectedNode}
              .allNodes=${this._nodes}
              .allEdges=${this._edges}
              .rpcClient=${this.rpcClient}
              @node-update=${this._onNodeUpdate}
              @node-delete=${this._onNodeDelete}
              @node-duplicate=${this._onNodeDuplicate}
              @edge-add=${this._onEditorEdgeAdd}
              @edge-remove=${this._onEditorEdgeRemove}
            ></ic-node-editor>
          ` : nothing}
        </div>
      </div>
      <ic-confirm-dialog
        ?open=${this._showDeleteConfirm}
        title="Delete Node"
        .message=${this._deleteMessage}
        variant="danger"
        confirmLabel="Delete"
        @confirm=${this._confirmDelete}
        @cancel=${() => { this._showDeleteConfirm = false; this._pendingDeleteNodeIds = []; this._pendingDeleteEdgeId = null; }}
      ></ic-confirm-dialog>
      <ic-template-picker
        ?open=${this._showTemplatePicker}
        @template-select=${this._onTemplateSelect}
        @cancel=${() => { this._showTemplatePicker = false; }}
      ></ic-template-picker>
      <ic-variable-prompt
        ?open=${this._showVariablePrompt}
        .variables=${this._variableNames}
        .pipelineLabel=${this._settings.label}
        @confirm=${this._onVariableConfirm}
        @cancel=${() => { this._showVariablePrompt = false; }}
      ></ic-variable-prompt>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "ic-pipeline-builder": IcPipelineBuilder; } }
