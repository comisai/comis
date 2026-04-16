/**
 * Graph/Pipeline domain types.
 *
 * Interfaces for pipeline nodes, edges, settings, validation,
 * graph listing, saved graphs, execution monitoring, and
 * run history used across the pipeline builder, monitor,
 * and history views.
 */

// ---------------------------------------------------------------------------
// Graph Builder types
// ---------------------------------------------------------------------------

/** Node position in graph space (builder-only, not sent to server) */
export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

/** Canonical node type identifiers matching @comis/core NodeTypeIdSchema */
export type NodeTypeId = "agent" | "debate" | "vote" | "refine" | "collaborate" | "approval-gate" | "map-reduce";

/** Pipeline node definition for the builder */
export interface PipelineNode {
  readonly id: string;
  readonly task: string;
  readonly agentId?: string;
  readonly dependsOn: string[];
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly barrierMode?: "all" | "majority" | "best-effort";
  readonly modelId?: string;
  readonly retries?: number;               // 0-3, automatic retry with exponential backoff
  readonly contextMode?: "full" | "summary" | "none";  // upstream context verbosity
  readonly typeId?: NodeTypeId;
  readonly typeConfig?: Record<string, unknown>;
  readonly position: NodePosition;
}

/** Pipeline edge (derived from node.dependsOn) */
export interface PipelineEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

/** Graph-level settings */
export interface GraphSettings {
  readonly label: string;
  readonly onFailure: "fail-fast" | "continue";
  readonly timeoutMs?: number;
  readonly budget?: {
    readonly maxTokens?: number;
    readonly maxCost?: number;
  };
}

/** Validation result from graph validation */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<ValidationMessage>;
  readonly warnings: ReadonlyArray<ValidationMessage>;
}

/** Individual validation message */
export interface ValidationMessage {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly nodeIds?: string[];
}

// ---------------------------------------------------------------------------
// Pipeline List types
// ---------------------------------------------------------------------------

/** Unified pipeline entry for the list view (merges drafts + saved + executed graphs) */
export interface PipelineListEntry {
  readonly id: string;           // Draft UUID, saved graph ID, or graphId
  readonly label: string;
  readonly source: "draft" | "saved" | "executed";
  readonly nodeCount: number;
  readonly agentCount: number;
  readonly lastRun?: number;     // epoch ms, undefined for never-run drafts
  readonly savedAt?: number;     // epoch ms, for drafts and saved entries
  readonly status?: "draft" | "running" | "completed" | "failed" | "cancelled";
  readonly graphId?: string;     // only for executed pipelines
}

/** Summary of a server-saved named graph (from graph.list RPC) */
export interface SavedGraphSummary {
  readonly id: string;
  readonly label: string;
  readonly nodeCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Full server-saved named graph (from graph.load RPC) */
export interface SavedGraphDetail {
  readonly id: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly label: string;
  readonly nodes: PipelineNode[];
  readonly edges: PipelineEdge[];
  readonly settings: GraphSettings;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Monitor types
// ---------------------------------------------------------------------------

/** Runtime node state for the execution monitor */
export interface MonitorNodeState {
  readonly id: string;
  readonly task: string;
  readonly agentId?: string;
  readonly modelId?: string;
  readonly status: "pending" | "ready" | "running" | "completed" | "failed" | "skipped";
  readonly runId?: string;
  readonly output?: string;
  readonly error?: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
  readonly retryAttempt?: number;       // 0 = first run, 1+ = retry number
  readonly retriesRemaining?: number;   // retries left before permanent failure
  readonly dependsOn: string[];
  readonly position: { x: number; y: number };
}

/** Immutable snapshot of monitor state for Lit component rendering */
export interface MonitorSnapshot {
  readonly graphId: string;
  readonly graphStatus: "running" | "completed" | "failed" | "cancelled";
  readonly isTerminal: boolean;
  readonly nodes: ReadonlyArray<MonitorNodeState>;
  readonly edges: ReadonlyArray<PipelineEdge>;
  readonly executionOrder: string[];
  readonly stats: {
    readonly total: number;
    readonly completed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly running: number;
    readonly pending: number;
  };
  readonly elapsedMs: number;
  readonly selectedNodeId: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Pipeline Run History types
// ---------------------------------------------------------------------------

/** Summary of a pipeline graph run for the history list */
export interface GraphRunSummary {
  readonly graphId: string;
  readonly name: string;
  readonly status: "completed" | "failed";
  readonly nodeCount: number;
  readonly date: string;
  readonly fileCount: number;
}

/** Node detail within a graph run */
export interface GraphRunNode {
  readonly nodeId: string;
  readonly output: string | null;
  readonly artifacts: ReadonlyArray<{ filename: string; content: string }>;
}

/** Full detail of a pipeline graph run */
export interface GraphRunDetail {
  readonly graphId: string;
  readonly name: string;
  readonly status: "completed" | "failed";
  readonly date: string;
  readonly nodes: ReadonlyArray<GraphRunNode>;
}
