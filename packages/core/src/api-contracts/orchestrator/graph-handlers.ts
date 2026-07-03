// SPDX-License-Identifier: Apache-2.0
/**
 * Graph-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/graph-handlers.ts` (12 methods — graph.*).
 * Spread order in `GRAPH_HANDLERS_CONTRACTS` is determinism-critical for
 * codegen output stability.
 *
 * **Naming clash (benign).** `packages/daemon/src/api/graph-handlers.ts` (the
 * daemon factory) shares a base filename with this contract file. The two are
 * imported by distinct paths (`@comis/core` vs. `@comis/daemon` internals) so
 * the collision is purely cosmetic — keep matching names by convention.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";

// ===========================================================================
// --- graph-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// graph.define
// ---------------------------------------------------------------------------

/**
 * `graph.define` — Validate a graph structure and return node count + execution
 * order WITHOUT executing. Rpc-scoped.
 * Handler path: graph-handlers.ts:397-411.
 *
 * Bespoke pre-Zod validation:
 *   - Missing/empty `nodes[]` → `"Missing required parameter: nodes"`.
 *   - parseExecutionGraph + validateAndSortGraph failure → throws with issue
 *     details from the graph parser.
 *
 * Request: `{ nodes, label?, onFailure?, timeoutMs?, budget?, edges? }`.
 *   - `nodes` is `z.array(z.record(z.string(), z.unknown()))` because the
 *     handler calls `transformNodes` (snake_case → camelCase + agent-node
 *     shape normalization) BEFORE parseExecutionGraph. Inner shape varies per
 *     `typeId`/`typeConfig` driver registry.
 *   - `onFailure` / `timeoutMs` / `budget` flow into the rawGraph build.
 *
 * Response: `{ valid, nodeCount, executionOrder, label?, warnings, errors,
 *   userVariables }`.
 *   - `executionOrder` is array of node id strings.
 *   - `warnings` / `errors` are arrays of `{ nodeId?, type, message, fix }`
 *     ValidationIssue records.
 *   - `userVariables` is `string[]` (extracted variable names).
 */
export const GraphDefineContract = defineContract({
  method: "graph.define",
  request: z.object({
    nodes: z.array(z.record(z.string(), z.unknown())),
    label: z.string().optional(),
    onFailure: z.string().optional(),
    on_failure: z.string().optional(),
    timeoutMs: z.number().optional(),
    timeout_ms: z.number().optional(),
    budget: z.record(z.string(), z.unknown()).optional(),
    edges: z.array(z.record(z.string(), z.unknown())).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }),
  response: z.object({
    valid: z.boolean(),
    nodeCount: z.number(),
    executionOrder: z.array(z.string()),
    label: z.string().optional(),
    warnings: z.array(z.record(z.string(), z.unknown())),
    errors: z.array(z.record(z.string(), z.unknown())),
    userVariables: z.array(z.string()),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.execute
// ---------------------------------------------------------------------------

/**
 * `graph.execute` — Validate + start a GraphCoordinator run. Rpc-scoped. Handler path: graph-handlers.ts:413-492.
 *
 * **Loose-record (request + response).** Graph schema authority lives in
 * `@comis/orchestrator` and is not yet stabilized for contract pinning.
 * Request + response BOTH modelled as `z.record(z.string(), z.unknown())`.
 * The handler's parseExecutionGraph + validateAndSortGraph is the
 * authoritative validator; the contract is type narrowing + dev-mode
 * shape-regression canary only.
 *
 * Bespoke pre-Zod validation:
 *   - Agent-to-agent messaging disabled by securityConfig → throws.
 *   - Missing nodes → `"Missing required parameter: nodes"`.
 *   - Approval-gate nodes without `_callerChannelType`/`_callerChannelId` →
 *     throws (announcement channel required).
 *
 * Request: loose-record (carries `nodes`, `variables?`, plus per-call hints).
 * Response: loose-record (carries `graphId`, `async`, `nodeCount`, `label?`,
 *   `hint`, optional `warnings`).
 */
export const GraphExecuteContract = defineContract({
  method: "graph.execute",
  request: z.record(z.string(), z.unknown()),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.status
// ---------------------------------------------------------------------------

/**
 * `graph.status` — Per-graph status snapshot OR list-recent fallback.
 * Rpc-scoped. Handler path:
 * graph-handlers.ts:494-562.
 *
 * Bespoke pre-Zod validation:
 *   - graphId provided but no snapshot → `"Graph not found"`.
 *
 * Request: `{ graphId?, graph_id?, recentMinutes? }`. When neither graphId
 *   nor graph_id is provided, the handler returns a list-recent + concurrency
 *   stats variant.
 *
 * Response is a discriminated 2-variant via loose-record (the per-graph
 * variant carries `{ graphId, status, isTerminal, executionOrder, nodes,
 * stats }`; the list variant carries `{ graphs, concurrency }`). Loose-record
 * because the inner shapes differ significantly.
 */
export const GraphStatusContract = defineContract({
  method: "graph.status",
  request: z.object({
    graphId: z.string().optional(),
    graph_id: z.string().optional(),
    recentMinutes: z.number().optional(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.cancel
// ---------------------------------------------------------------------------

/**
 * `graph.cancel` — Cancel a running graph. Rpc-scoped. Handler path: graph-handlers.ts:564-585.
 *
 * Bespoke pre-Zod validation:
 *   - Agent-to-agent messaging disabled → throws.
 *   - Missing graphId → `"Missing required parameter: graphId"`.
 *   - Unknown graphId or terminal → `"Graph not found or already terminal"`.
 *
 * Request: `{ graphId?, graph_id? }`. Either form accepted.
 * Response: `{ cancelled, graphId }`.
 */
export const GraphCancelContract = defineContract({
  method: "graph.cancel",
  request: z.object({
    graphId: z.string().optional(),
    graph_id: z.string().optional(),
  }),
  response: z.object({
    cancelled: z.boolean(),
    graphId: z.string(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.save
// ---------------------------------------------------------------------------

/**
 * `graph.save` — Persist a named graph to the namedGraphStore. Rpc-scoped. Handler path: graph-handlers.ts:591-620.
 *
 * Bespoke pre-Zod validation:
 *   - `!deps.namedGraphStore` → `"Named graph storage not available"`.
 *   - Missing/empty label → `"Missing required parameter: label (non-empty string)"`.
 *   - parseExecutionGraph + validateTypeConfigs runs (same as graph.define).
 *
 * Request: `{ label, id?, agentId?, nodes, edges?, settings? }`. Settings is
 *   a loose-record (varies per saved graph).
 *
 * Response: `{ id, saved }`.
 */
export const GraphSaveContract = defineContract({
  method: "graph.save",
  request: z.object({
    label: z.string(),
    id: z.string().optional(),
    agentId: z.string().optional(),
    nodes: z.array(z.record(z.string(), z.unknown())),
    edges: z.array(z.record(z.string(), z.unknown())).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }),
  response: z.object({
    id: z.string(),
    saved: z.boolean(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.load
// ---------------------------------------------------------------------------

/**
 * `graph.load` — Load a persisted named graph by id. Rpc-scoped. Handler path: graph-handlers.ts:622-648.
 *
 * Bespoke pre-Zod validation:
 *   - `!deps.namedGraphStore` → `"Named graph storage not available"`.
 *   - Missing id → `"Missing required parameter: id"`.
 *   - Unknown id → `"Named graph not found"`.
 *
 * Request: `{ id }`.
 *
 * Response: `{ ...entry, nodes, edges }` where entry contains tenantId,
 *   agentId, label, settings, createdAtMs, etc. Loose-record.
 */
export const GraphLoadContract = defineContract({
  method: "graph.load",
  request: z.object({
    id: z.string(),
  }),
  response: z.record(z.string(), z.unknown()),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.list
// ---------------------------------------------------------------------------

/**
 * `graph.list` — List persisted named graphs. Rpc-scoped. Handler path: graph-handlers.ts:650-662.
 *
 * Bespoke pre-Zod validation:
 *   - `!deps.namedGraphStore` → `"Named graph storage not available"`.
 *
 * Request: `{ limit?, offset? }`.
 * Response: `{ entries, total }`. Entries are loose-records (full
 *   namedGraphStore.list shape).
 */
export const GraphListContract = defineContract({
  method: "graph.list",
  request: z.object({
    limit: z.number().optional(),
    offset: z.number().optional(),
  }),
  response: z.object({
    entries: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.delete
// ---------------------------------------------------------------------------

/**
 * `graph.delete` — Soft-delete a persisted named graph. Rpc-scoped. Handler path: graph-handlers.ts:664-681.
 *
 * Bespoke pre-Zod validation:
 *   - `!deps.namedGraphStore` → `"Named graph storage not available"`.
 *   - Missing id → `"Missing required parameter: id"`.
 *   - Unknown id → `"Named graph not found"`.
 *
 * Request: `{ id }`.
 * Response: `{ id, deleted }`.
 */
export const GraphDeleteContract = defineContract({
  method: "graph.delete",
  request: z.object({
    id: z.string(),
  }),
  response: z.object({
    id: z.string(),
    deleted: z.boolean(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.outputs
// ---------------------------------------------------------------------------

/**
 * `graph.outputs` — Per-node outputs (in-memory or disk fallback). Rpc-scoped. Handler path: graph-handlers.ts:687-753.
 *
 * Bespoke pre-Zod validation:
 *   - Missing graphId or non-string → `"Missing required parameter: graphId"`.
 *   - No in-memory snapshot + no dataDir + no label match → `"Graph not found"`.
 *
 * Request: `{ graphId?, graph_id? }`. Either form accepted.
 * Response: `{ graphId, outputs, source }`. `outputs` is a nodeId → string|null
 *   record. `source` is "memory" or "disk".
 */
export const GraphOutputsContract = defineContract({
  method: "graph.outputs",
  request: z.object({
    graphId: z.string().optional(),
    graph_id: z.string().optional(),
  }),
  response: z.object({
    graphId: z.string(),
    outputs: z.record(z.string(), z.nullable(z.string())),
    source: z.string(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.runs
// ---------------------------------------------------------------------------

/**
 * `graph.runs` — List graph run history from disk. Rpc-scoped. Handler path: graph-handlers.ts:759-820.
 *
 * Bespoke pre-Zod validation:
 *   - `!deps.dataDir` → `"dataDir not configured — cannot read graph runs"`.
 *
 * Request: `{}`.
 * Response: `{ runs: RunEntry[] }`. Each RunEntry: `{ graphId, name, status,
 *   nodeCount, date, fileCount }`. Status is "completed" | "failed".
 */
export const GraphRunsContract = defineContract({
  method: "graph.runs",
  request: z.object({}),
  response: z.object({
    runs: z.array(z.object({
      graphId: z.string(),
      name: z.string(),
      status: z.enum(["completed", "failed"]),
      nodeCount: z.number(),
      date: z.string(),
      fileCount: z.number(),
    })),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.runDetail
// ---------------------------------------------------------------------------

/**
 * `graph.runDetail` — Per-graph run detail (node outputs + artifacts) from
 * disk. Rpc-scoped. Handler path:
 * graph-handlers.ts:822-910.
 *
 * Bespoke pre-Zod validation:
 *   - Missing graphId or non-string → `"Missing required parameter: graphId"`.
 *   - `!deps.dataDir` → `"dataDir not configured — cannot read graph run detail"`.
 *   - Unknown graphId on disk → `"Graph run not found"`.
 *
 * Request: `{ graphId?, graph_id? }`.
 * Response: `{ graphId, name, status, date, nodes }`. `nodes` is an array of
 *   `{ nodeId, output, artifacts: { filename, content }[] }`.
 */
export const GraphRunDetailContract = defineContract({
  method: "graph.runDetail",
  request: z.object({
    graphId: z.string().optional(),
    graph_id: z.string().optional(),
  }),
  response: z.object({
    graphId: z.string(),
    name: z.string(),
    status: z.enum(["completed", "failed"]),
    date: z.string(),
    nodes: z.array(z.object({
      nodeId: z.string(),
      output: z.nullable(z.string()),
      artifacts: z.array(z.object({
        filename: z.string(),
        content: z.string(),
      })),
    })),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// graph.deleteRun
// ---------------------------------------------------------------------------

/**
 * `graph.deleteRun` — Delete a graph run directory (irrecoverable).
 * Rpc-scoped. Handler path:
 * graph-handlers.ts:912-930.
 *
 * Bespoke pre-Zod validation:
 *   - Missing graphId or non-string → `"Missing required parameter: graphId"`.
 *   - `!deps.dataDir` → `"dataDir not configured — cannot delete graph run"`.
 *   - Unknown graphId on disk → `"Graph run not found"`.
 *
 * Request: `{ graphId?, graph_id? }`.
 * Response: `{ graphId, deleted }`.
 */
export const GraphDeleteRunContract = defineContract({
  method: "graph.deleteRun",
  request: z.object({
    graphId: z.string().optional(),
    graph_id: z.string().optional(),
  }),
  response: z.object({
    graphId: z.string(),
    deleted: z.boolean(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * graph-handlers slice (12 contracts — graph.*). Spread order is
 * determinism-critical for codegen output stability.
 */
export const GRAPH_HANDLERS_CONTRACTS = [
  GraphDefineContract,
  GraphExecuteContract,
  GraphStatusContract,
  GraphCancelContract,
  GraphSaveContract,
  GraphLoadContract,
  GraphListContract,
  GraphDeleteContract,
  GraphOutputsContract,
  GraphRunsContract,
  GraphRunDetailContract,
  GraphDeleteRunContract,
] as const;
