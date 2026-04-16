/**
 * Full pipeline execution monitor view.
 *
 * Orchestrates all monitor sub-components (read-only canvas, status bar,
 * node detail panel, Gantt timeline, minimap) through the MonitorState
 * manager and RPC client.
 *
 * Responsibilities:
 * - Creates MonitorState on connect
 * - Resolves node positions from server-saved graph (graph.load) or autoLayout fallback
 * - Starts polling and subscribes to reactive state changes
 * - Routes events between sub-components
 * - Handles cancel (graph.cancel) and steer (subagent.steer) RPCs
 * - Provides ARIA live region for screen reader announcements (A11Y-03)
 * - Cleans up all timers and subscriptions on disconnect
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { MonitorSnapshot, MonitorNodeState, PipelineNode, PipelineEdge } from "../../api/types/index.js";
import type { EventDispatcher } from "../../state/event-dispatcher.js";
import type { ViewportTransform } from "../../utils/viewport-transform.js";
import { createMonitorState, type MonitorState } from "../../state/monitor-state.js";
import { autoLayout, computeFitViewport } from "../../utils/graph-layout.js";
import { IcToast } from "../../components/feedback/ic-toast.js";
import "../../components/nav/ic-breadcrumb.js";
import type { BreadcrumbItem } from "../../components/nav/ic-breadcrumb.js";
import "../../components/graph/ic-graph-canvas.js";
import "../../components/monitor/ic-monitor-status-bar.js";
import "../../components/monitor/ic-node-detail-panel.js";
import "../../components/monitor/ic-execution-timeline.js";
import "../../components/graph/ic-graph-minimap.js";
import "../../components/feedback/ic-toast.js";
import "../../components/feedback/ic-confirm-dialog.js";

// ---------------------------------------------------------------------------
// GraphStatusResponse shape (from graph.status RPC)
// ---------------------------------------------------------------------------

interface GraphStatusResponse {
  readonly graphId: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly isTerminal: boolean;
  readonly executionOrder: string[];
  readonly nodes: Record<
    string,
    {
      readonly status: string;
      readonly runId?: string;
      readonly output?: string;
      readonly error?: string;
      readonly startedAt?: number;
      readonly completedAt?: number;
      readonly durationMs?: number;
      readonly retryAttempt?: number;
      readonly retriesRemaining?: number;
    }
  >;
  readonly stats: {
    readonly total: number;
    readonly completed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly running: number;
    readonly pending: number;
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("ic-pipeline-monitor")
export class IcPipelineMonitor extends LitElement {
  static override styles = [sharedStyles, focusStyles, css`
    :host { display: block; height: 100%; }

    .monitor-container {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 120px);
    }

    .monitor-body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .canvas-area {
      flex: 1;
      position: relative;
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-md);
      overflow: hidden;
    }

    .minimap-container {
      position: absolute;
      bottom: 12px;
      right: 12px;
      z-index: 10;
    }

    .loading-container {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: var(--ic-text-muted);
      font-size: var(--ic-text-sm);
    }

    .error-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--ic-space-sm) var(--ic-space-md);
      background: color-mix(in srgb, var(--ic-error) 15%, transparent);
      border: 1px solid var(--ic-error);
      border-radius: var(--ic-radius-sm);
      color: var(--ic-error);
      font-size: var(--ic-text-sm);
      margin-bottom: var(--ic-space-sm);
    }

    .error-banner button {
      padding: 4px 12px;
      background: var(--ic-surface-2);
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-sm);
      color: var(--ic-text);
      font-size: var(--ic-text-xs);
      cursor: pointer;
    }
    .error-banner button:hover {
      background: var(--ic-border);
    }

    /* Screen-reader-only text for ARIA live region */
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    /* Graph outputs modal */
    .outputs-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .outputs-modal {
      background: var(--ic-surface);
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-md);
      width: 600px;
      max-width: 90vw;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
    }

    .outputs-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--ic-border);
    }

    .outputs-header h3 {
      margin: 0;
      font-size: var(--ic-text-base);
    }

    .outputs-close {
      border: none;
      background: none;
      color: var(--ic-text-muted);
      cursor: pointer;
      font-size: var(--ic-text-base);
      padding: 4px 8px;
    }
    .outputs-close:hover {
      color: var(--ic-text);
    }

    .outputs-body {
      padding: 16px;
      overflow-y: auto;
      flex: 1;
    }

    .output-entry {
      margin-bottom: 16px;
    }
    .output-entry:last-child {
      margin-bottom: 0;
    }

    .output-node-id {
      font-weight: 600;
      font-size: var(--ic-text-sm);
      color: var(--ic-accent);
      margin-bottom: 4px;
    }

    .output-text {
      margin: 0;
      padding: 8px;
      background: var(--ic-bg);
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-sm);
      font-size: var(--ic-text-xs);
      font-family: var(--ic-font-mono);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
    }

    .outputs-empty {
      text-align: center;
      color: var(--ic-text-muted);
      padding: 24px;
      font-size: var(--ic-text-sm);
    }

    /* Mobile responsive: show summary instead of canvas */
    .mobile-summary { display: none; }

    @media (max-width: 767px) {
      .monitor-container { display: none; }
      .mobile-summary {
        display: block;
        padding: 1.5rem;
        color: var(--ic-text-muted);
        text-align: center;
      }
      .mobile-summary h2 {
        font-size: 1.25rem;
        font-weight: 600;
        margin-bottom: 0.5rem;
      }
      .mobile-summary .node-list {
        text-align: left;
        font-size: var(--ic-text-sm);
        margin-top: 1rem;
      }
      .mobile-summary .node-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
      }
      .mobile-summary .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
    }
  `];

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property() graphId = "";
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  // ---------------------------------------------------------------------------
  // Reactive state (updated from MonitorSnapshot)
  // ---------------------------------------------------------------------------

  @state() private _snapshot: MonitorSnapshot | null = null;
  @state() private _viewport: ViewportTransform = { x: 0, y: 0, scale: 1 };
  @state() private _showCancelConfirm = false;
  @state() private _liveAnnouncement = "";

  // ---------------------------------------------------------------------------
  // Private fields
  // ---------------------------------------------------------------------------

  private _monitorState: MonitorState | null = null;
  private _stateUnsub: (() => void) | null = null;
  private _sseUnsubs: Array<() => void> = [];
  private _previousNodeStatuses: Map<string, string> = new Map();
  private _containerWidth = 800;
  private _containerHeight = 600;
  private _resizeObserver: ResizeObserver | null = null;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();

    // Create monitor state
    this._monitorState = createMonitorState();

    // Subscribe to state changes
    this._stateUnsub = this._monitorState.subscribe(() => {
      const snap = this._monitorState!.getSnapshot();
      this._snapshot = snap;

      // A11Y-03: Detect node status changes for ARIA live announcements
      this._announceNodeChanges(snap.nodes);
    });

    // Resolve positions and start polling
    this._initMonitor();
  }

  override firstUpdated(): void {
    // Set up ResizeObserver on the canvas area for container sizing
    const canvasArea = this.renderRoot.querySelector(".canvas-area");
    if (canvasArea) {
      this._resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          this._containerWidth = entry.contentRect.width;
          this._containerHeight = entry.contentRect.height;
        }
      });
      this._resizeObserver.observe(canvasArea);
    }
  }

  override disconnectedCallback(): void {
    // Clean up SSE subscriptions
    for (const unsub of this._sseUnsubs) unsub();
    this._sseUnsubs = [];
    this._monitorState?.destroy();
    this._monitorState = null;
    this._stateUnsub?.();
    this._stateUnsub = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._previousNodeStatuses.clear();
    super.disconnectedCallback();
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  private async _initMonitor(): Promise<void> {
    if (!this.rpcClient || !this.graphId || !this._monitorState) return;

    let nodeDefinitions: PipelineNode[] = [];
    let edges: PipelineEdge[] = [];

    // Try loading saved graph from server to get nodes with positions
    try {
      const saved = (await this.rpcClient.call("graph.load", { id: this.graphId })) as {
        nodes: Array<Record<string, unknown>>;
        edges?: PipelineEdge[];
        settings?: Record<string, unknown>;
      };

      if (saved?.nodes?.length) {
        // Transform server nodes to canvas format (handle nodeId->id, agent->agentId)
        const canvasNodes: PipelineNode[] = saved.nodes.map((raw) => {
          const id = (raw.id ?? raw.nodeId) as string;
          return {
            id,
            task: (raw.task as string) ?? "",
            agentId: (raw.agentId ?? raw.agent) as string | undefined,
            dependsOn: (raw.dependsOn as string[]) ?? [],
            maxSteps: raw.maxSteps as number | undefined,
            timeoutMs: raw.timeoutMs as number | undefined,
            barrierMode: raw.barrierMode as PipelineNode["barrierMode"],
            modelId: (raw.modelId ?? raw.model) as string | undefined,
            position: (raw.position as PipelineNode["position"]) ?? { x: 0, y: 0 },
          };
        });

        // Derive edges from node.dependsOn if no explicit edges
        const canvasEdges: PipelineEdge[] = saved.edges && saved.edges.length > 0
          ? saved.edges
          : canvasNodes.flatMap((node) =>
              node.dependsOn.map((dep) => ({
                id: `${dep}->${node.id}`,
                source: dep,
                target: node.id,
              })),
            );

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

        nodeDefinitions = canvasNodes;
        edges = canvasEdges;
      }
    } catch {
      // graph.load failed (404 or server unavailable) -- fall through to graph.status path
    }

    // Fallback: fetch graph.status to get execution order, build stubs with autoLayout
    // This handles graphs executed via CLI/API without ever being saved through the GUI.
    if (nodeDefinitions.length === 0) {
      try {
        const response = await this.rpcClient.call<GraphStatusResponse>(
          "graph.status",
          { graphId: this.graphId },
        );

        // Build minimal PipelineNode stubs
        const stubNodes: PipelineNode[] = response.executionOrder.map((nodeId) => ({
          id: nodeId,
          task: nodeId,
          dependsOn: [],
          position: { x: 0, y: 0 },
        }));

        // Build sequential edges for basic layout
        const derivedEdges: PipelineEdge[] = [];
        if (stubNodes.length > 1) {
          for (let i = 1; i < response.executionOrder.length; i++) {
            derivedEdges.push({
              id: `${response.executionOrder[i - 1]}->${response.executionOrder[i]}`,
              source: response.executionOrder[i - 1],
              target: response.executionOrder[i],
            });
          }
        }

        // Run autoLayout for positions
        const layoutResult = autoLayout(stubNodes, derivedEdges);
        nodeDefinitions = stubNodes.map((node) => {
          const pos = layoutResult.positions.get(node.id);
          return pos ? { ...node, position: pos } : node;
        });
        edges = derivedEdges;
      } catch {
        // If graph.status also fails, polling will retry -- leave empty nodes
        nodeDefinitions = [];
        edges = [];
      }
    }

    // Start polling
    if (nodeDefinitions.length > 0) {
      this._monitorState.startPolling(this.rpcClient, this.graphId, nodeDefinitions, edges);

      // Compute fit viewport after a short delay to let first poll complete
      setTimeout(() => {
        if (nodeDefinitions.length > 0) {
          this._viewport = computeFitViewport(
            nodeDefinitions,
            this._containerWidth || 800,
            this._containerHeight || 600,
          );
        }
      }, 200);

      // Wire SSE events for real-time updates (after polling is started)
      this._wireSSE();
    }
  }

  // ---------------------------------------------------------------------------
  // SSE event wiring
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to graph SSE events via EventDispatcher for real-time
   * node status updates. Polling is suspended while SSE is connected
   * and resumes on disconnect (with immediate recovery poll).
   */
  private _wireSSE(): void {
    // Clean up any previous SSE subscriptions
    for (const unsub of this._sseUnsubs) unsub();
    this._sseUnsubs = [];

    if (!this.eventDispatcher || !this._monitorState) return;

    const graphEvents = ["graph:started", "graph:node_updated", "graph:completed"] as const;
    for (const eventType of graphEvents) {
      this._sseUnsubs.push(
        this.eventDispatcher.addEventListener(eventType, (data) => {
          const payload = data as { graphId: string };
          // Filter to only this graph's events
          if (payload.graphId === this.graphId) {
            this._monitorState?.applyEvent(eventType, data);
          }
        }),
      );
    }

    // Suspend polling when SSE is connected (SSE-primary mode)
    if (this.eventDispatcher.connected) {
      this._monitorState.suspendPolling();
    }

    // Track SSE connection state changes for polling control.
    // Periodically check eventDispatcher.connected and toggle polling mode.
    let wasSseConnected = this.eventDispatcher.connected;
    const connectionCheckInterval = setInterval(() => {
      if (!this.eventDispatcher || !this._monitorState) return;
      const isNowConnected = this.eventDispatcher.connected;

      if (isNowConnected && !wasSseConnected) {
        // SSE reconnected: do recovery poll then suspend
        this._monitorState.resumePolling();
        // Give the recovery poll a moment, then suspend
        setTimeout(() => {
          this._monitorState?.suspendPolling();
        }, 500);
      } else if (!isNowConnected && wasSseConnected) {
        // SSE disconnected: resume polling
        this._monitorState.resumePolling();
      }
      wasSseConnected = isNowConnected;
    }, 3000);

    // Store the interval cleanup
    this._sseUnsubs.push(() => clearInterval(connectionCheckInterval));
  }

  // ---------------------------------------------------------------------------
  // Computed properties
  // ---------------------------------------------------------------------------

  private get _breadcrumbs(): BreadcrumbItem[] {
    return [
      { label: "Pipelines", route: "pipelines" },
      { label: this.graphId || "Monitor" },
    ];
  }

  private get _nodeStatuses(): Map<string, string> {
    const map = new Map<string, string>();
    if (!this._snapshot) return map;
    for (const node of this._snapshot.nodes) {
      map.set(node.id, node.status);
    }
    return map;
  }

  private get _edgeStatuses(): Map<string, string> {
    const map = new Map<string, string>();
    if (!this._snapshot) return map;
    const nodeStatusMap = this._nodeStatuses;

    for (const edge of this._snapshot.edges) {
      const srcStatus = nodeStatusMap.get(edge.source) ?? "";
      const tgtStatus = nodeStatusMap.get(edge.target) ?? "";

      if (srcStatus === "completed" && tgtStatus === "completed") {
        map.set(edge.id, "completed");
      } else if (srcStatus === "running" || tgtStatus === "running") {
        map.set(edge.id, "running");
      } else if (srcStatus === "failed" || tgtStatus === "failed") {
        map.set(edge.id, "failed");
      } else if (srcStatus === "skipped" || tgtStatus === "skipped") {
        map.set(edge.id, "skipped");
      }
      // else: default (no class)
    }
    return map;
  }

  private get _selectedNode(): MonitorNodeState | null {
    if (!this._snapshot?.selectedNodeId) return null;
    return this._snapshot.nodes.find((n) => n.id === this._snapshot!.selectedNodeId) ?? null;
  }

  private get _canvasNodes(): PipelineNode[] {
    if (!this._snapshot) return [];
    return this._snapshot.nodes.map((n) => ({
      id: n.id,
      task: n.task,
      agentId: n.agentId,
      dependsOn: n.dependsOn,
      position: n.position,
    }));
  }

  // ---------------------------------------------------------------------------
  // A11Y-03: Screen reader announcements
  // ---------------------------------------------------------------------------

  private _announceNodeChanges(nodes: ReadonlyArray<MonitorNodeState>): void {
    const announcements: string[] = [];

    for (const node of nodes) {
      const prev = this._previousNodeStatuses.get(node.id);
      if (prev !== node.status) {
        switch (node.status) {
          case "running":
            announcements.push(`Node ${node.id} started executing`);
            break;
          case "completed":
            announcements.push(`Node ${node.id} completed successfully`);
            break;
          case "failed":
            announcements.push(`Node ${node.id} failed`);
            break;
        }
      }
    }

    // Update the previous statuses map
    this._previousNodeStatuses.clear();
    for (const node of nodes) {
      this._previousNodeStatuses.set(node.id, node.status);
    }

    if (announcements.length > 0) {
      this._liveAnnouncement = announcements.join(". ");
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private _onNodeInspect(e: CustomEvent<{ nodeId: string }>): void {
    this._monitorState?.selectNode(e.detail.nodeId);
  }

  private _onCanvasClick(): void {
    this._monitorState?.selectNode(null);
  }

  private _onViewportChange(e: CustomEvent<ViewportTransform>): void {
    this._viewport = e.detail;
  }

  private _onMinimapViewportChange(e: CustomEvent<ViewportTransform>): void {
    this._viewport = e.detail;
  }

  private _onCancelRequest(): void {
    this._showCancelConfirm = true;
  }

  private async _onCancelConfirm(): Promise<void> {
    this._showCancelConfirm = false;
    if (!this.rpcClient) return;

    try {
      await this.rpcClient.call("graph.cancel", { graphId: this.graphId });
      IcToast.show("Pipeline cancelled", "warning");
    } catch (err: unknown) {
      IcToast.show(
        `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  private async _onSteer(e: CustomEvent<{ runId: string; message: string }>): Promise<void> {
    if (!this.rpcClient) return;

    try {
      await this.rpcClient.call("subagent.steer", {
        target: e.detail.runId,
        message: e.detail.message,
      });
      IcToast.show("Steer message sent", "success");
    } catch (err: unknown) {
      IcToast.show(
        `Steer failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  private _onDetailClose(): void {
    this._monitorState?.selectNode(null);
  }

  private _onViewOutputs(): void {
    if (!this.graphId) return;
    window.location.hash = `#/pipelines/history/${this.graphId}`;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    const snap = this._snapshot;

    return html`
      <ic-breadcrumb .items=${this._breadcrumbs}
        @navigate=${(e: CustomEvent<string>) => this.dispatchEvent(
          new CustomEvent("navigate", { detail: e.detail, bubbles: true, composed: true }),
        )}
      ></ic-breadcrumb>

      ${this._renderMobileSummary(snap)}

      <div class="monitor-container">
        ${snap?.error && !snap.loading
          ? html`
              <div class="error-banner">
                <span>${snap.error}</span>
                <button @click=${() => this._initMonitor()}>Retry</button>
              </div>
            `
          : nothing}

        ${!snap || snap.loading
          ? html`<div class="loading-container">Loading execution data...</div>`
          : html`
              <ic-monitor-status-bar
                .graphStatus=${snap.graphStatus}
                ?isTerminal=${snap.isTerminal}
                .elapsedMs=${snap.elapsedMs}
                .stats=${snap.stats}
                @cancel=${this._onCancelRequest}
                @view-outputs=${this._onViewOutputs}
              ></ic-monitor-status-bar>

              <div class="monitor-body">
                <div class="canvas-area">
                  <ic-graph-canvas
                    read-only
                    .viewport=${this._viewport}
                    .nodes=${this._canvasNodes}
                    .edges=${snap.edges}
                    .selectedNodeIds=${new Set<string>()}
                    .selectedEdgeId=${null}
                    .nodeStatuses=${this._nodeStatuses}
                    .edgeStatuses=${this._edgeStatuses}
                    .highlightNodeIds=${[]}
                    @viewport-change=${this._onViewportChange}
                    @node-inspect=${this._onNodeInspect}
                    @canvas-click=${this._onCanvasClick}
                  ></ic-graph-canvas>

                  <div class="minimap-container">
                    <ic-graph-minimap
                      .nodes=${this._canvasNodes.map((n) => ({
                        id: n.id,
                        position: n.position,
                        status: this._nodeStatuses.get(n.id),
                      }))}
                      .viewport=${this._viewport}
                      .containerWidth=${this._containerWidth}
                      .containerHeight=${this._containerHeight}
                      @viewport-change=${this._onMinimapViewportChange}
                    ></ic-graph-minimap>
                  </div>
                </div>

                ${this._selectedNode
                  ? html`
                      <ic-node-detail-panel
                        .node=${this._selectedNode}
                        .allNodes=${snap.nodes}
                        @close=${this._onDetailClose}
                        @steer=${this._onSteer}
                      ></ic-node-detail-panel>
                    `
                  : nothing}
              </div>

              <ic-execution-timeline
                .nodes=${snap.nodes}
                .executionOrder=${snap.executionOrder}
                .elapsedMs=${snap.elapsedMs}
                .selectedNodeId=${snap.selectedNodeId}
                @node-inspect=${this._onNodeInspect}
              ></ic-execution-timeline>
            `}
      </div>

      <!-- A11Y-03: ARIA live region for execution event announcements -->
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        ${this._liveAnnouncement}
      </div>

      <!-- Cancel confirmation dialog -->
      <ic-confirm-dialog
        ?open=${this._showCancelConfirm}
        title="Cancel Pipeline"
        message="Are you sure you want to cancel this pipeline execution? Running nodes will be terminated."
        variant="danger"
        confirmLabel="Cancel Pipeline"
        @confirm=${this._onCancelConfirm}
        @cancel=${() => { this._showCancelConfirm = false; }}
      ></ic-confirm-dialog>

      <!-- View Outputs navigates to history detail page -->
    `;
  }

  // ---------------------------------------------------------------------------
  // Mobile responsive summary
  // ---------------------------------------------------------------------------

  private _renderMobileSummary(snap: MonitorSnapshot | null) {
    if (!snap) {
      return html`
        <div class="mobile-summary">
          <h2>Pipeline Monitor</h2>
          <p>Loading...</p>
        </div>
      `;
    }

    const statusColors: Record<string, string> = {
      pending: "#6b7280",
      ready: "#a78bfa",
      running: "#06b6d4",
      completed: "#22c55e",
      failed: "#ef4444",
      skipped: "#9ca3af",
    };

    return html`
      <div class="mobile-summary">
        <h2>Pipeline: ${snap.graphId}</h2>
        <p>Status: ${snap.graphStatus} | ${snap.stats.completed}/${snap.stats.total} complete</p>
        <div class="node-list">
          ${snap.nodes.map((n) => html`
            <div class="node-item">
              <span class="status-dot" style="background: ${statusColors[n.status] ?? "#6b7280"}"></span>
              <span>${n.id}: ${n.status}</span>
            </div>
          `)}
        </div>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "ic-pipeline-monitor": IcPipelineMonitor; } }
