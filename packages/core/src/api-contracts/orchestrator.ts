// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestrator-umbrella RPC contracts. Mirrors the FOUR daemon handler factory
 * files that share the `OrchestratorApiDeps` cluster slice (Phase 34 plan
 * 34-08a):
 *
 *   - `packages/daemon/src/api/cron-handlers.ts`       ( 8 methods — cron.* +
 *                                                        scheduler.wake)
 *   - `packages/daemon/src/api/graph-handlers.ts`      (12 methods — graph.*)
 *   - `packages/daemon/src/api/heartbeat-handlers.ts`  ( 4 methods — heartbeat.*)
 *   - `packages/daemon/src/api/subagent-handlers.ts`   ( 3 methods — subagent.*)
 *
 * Phase 35 Wave C plan 35-18 (Wave C domain #13 — LAST Wave 7 plan before Plan
 * 35-19 closes Wave C with sessions). Per D-08 (one contract file per logical
 * domain mirroring Phase 34's 11 `*ApiDeps` slices), all four handler files map
 * to the SAME ApiDeps slice (`OrchestratorApiDeps`) and so share one contract
 * file. The aggregator below preserves per-handler grouping via
 * `// --- xxx-handlers.ts ---` comment blocks; the order within the array is
 * documentation-only (the bidirectional 1:1 test treats it as an unordered
 * set).
 *
 * **Scope assignments** (mirror `setup-gateway-api.ts` registrations):
 *
 *   cron-handlers.ts (all rpc per setup-gateway-api.ts:130-157):
 *   - `cron.add`                  (rpc — transformer relocated to handler body
 *                                  per PATTERNS OQ-4 option c)
 *   - `cron.list`                 (rpc)
 *   - `cron.update`               (rpc)
 *   - `cron.remove`               (rpc)
 *   - `cron.status`               (rpc)
 *   - `cron.runs`                 (rpc)
 *   - `cron.run`                  (rpc)
 *   - `scheduler.wake`            (rpc — registration-plane-agnostic — see below)
 *
 *   graph-handlers.ts (all rpc per setup-gateway-api.ts:317-321):
 *   - `graph.define`              (rpc)
 *   - `graph.execute`             (rpc — D-05 loose-record request + response)
 *   - `graph.status`              (rpc)
 *   - `graph.cancel`              (rpc)
 *   - `graph.save`                (rpc)
 *   - `graph.load`                (rpc)
 *   - `graph.list`                (rpc)
 *   - `graph.delete`              (rpc)
 *   - `graph.outputs`             (rpc)
 *   - `graph.runs`                (rpc)
 *   - `graph.runDetail`           (rpc)
 *   - `graph.deleteRun`           (rpc)
 *
 *   heartbeat-handlers.ts (all admin per setup-gateway-api.ts:327-329):
 *   - `heartbeat.states`          (admin)
 *   - `heartbeat.get`             (admin — read-only but admin-namespaced)
 *   - `heartbeat.update`          (admin)
 *   - `heartbeat.trigger`         (admin)
 *
 *   subagent-handlers.ts (all admin per setup-gateway-api.ts:207-209):
 *   - `subagent.list`             (admin)
 *   - `subagent.kill`             (admin)
 *   - `subagent.steer`            (admin)
 *
 * **scheduler.wake** is registered intrinsically through normal RPC dispatch
 * — there is NO explicit `setup-gateway-api.ts` entry for it. The dispatcher
 * resolves `scheduler.wake` against the rpcDispatch map (rpc-dispatch.ts);
 * scope is implicit rpc (no admin trust check in the handler body). Same
 * registration-plane-agnostic precedent as Plan 35-17's
 * `delivery.queue.status`.
 *
 * **BLOCKER 8 — single-scope invariant.** Every contract in this file has
 * `scopes: ["X"]` (length-1 tuple). The single-scope invariant is what Plan
 * 35-20's `c.scopes[0]` collapse loop depends on. Verified by
 * `orchestrator.test.ts` (`scopes.length === 1` assertion across the
 * registry).
 *
 * **PATTERNS OQ-4 (cron.add transformer relocation).** Pre-Plan-35-18,
 * `setup-gateway-api.ts` carried an inline transformer that converted the
 * frontend `CronJobInput` payload (`{ name, agentId, message, schedule: {
 * kind, expr?, tz?, everyMs?, at? }, ... }`) into the flat fields the cron
 * handler expects (`schedule_kind`, `schedule_expr`, `timezone`,
 * `schedule_every_ms`, `schedule_at`, `payload_text`, `payload_kind`,
 * `_agentId`). Per OQ-4 option (c) (server-side normalization belongs in the
 * handler, not the dispatcher), the transformer moves into the handler body.
 *
 * `CronAddContract` describes the WEB on-wire shape (nested `schedule` object
 * + `message` field). The handler body accepts BOTH the web shape (nested) and
 * the legacy chat-tool shape (flat `schedule_kind`/`schedule_every_ms`/etc.) —
 * the flat path was exercised by 14+ pre-existing cron-handlers tests that
 * pass the flat fields directly. The handler normalizes either shape into the
 * flat fields before calling `buildCronSchedule`.
 *
 * **D-05 loose-record use** (Pitfall 6 escape hatch). Five contract positions
 * carry loosely-typed payloads:
 *
 *   - `graph.execute.request` — `z.record(z.string(), z.unknown())`. Per D-05,
 *     graph schema authority lives in `@comis/orchestrator` and is not yet
 *     stabilized for contract pinning; tightening deferred to a follow-up
 *     phase. The handler's `parseExecutionGraph` + `validateAndSortGraph` is
 *     the authoritative validator.
 *   - `graph.execute.response` — `z.record(z.string(), z.unknown())`. The
 *     response includes `graphId`, `async`, `nodeCount`, `label`, `hint`, and
 *     optional `warnings` — loose-record because the warnings list shape
 *     mirrors the loose request shape.
 *   - `graph.save.request` — nodes/edges/settings are loose because the
 *     persistence layer accepts the same flexible shape as `graph.define`.
 *   - `graph.load.response` — persisted nodes/edges carry the loose shape.
 *   - `graph.define.request.nodes` — loose-record (same rationale as
 *     `graph.execute`).
 *   - `graph.status.response.nodes` — node-state record keyed by nodeId.
 *   - `graph.outputs.response.outputs` — node-id → output map (loose value).
 *   - `graph.runDetail.response.nodes[].artifacts` — adapter-shaped records.
 *   - `cron.add.request.schedule` — nested `{ kind, expr?, tz?, everyMs?,
 *     at? }` accepted; the handler body normalizes to flat fields.
 *   - `cron.update.request.schedule` — same shape (web UI sends the nested
 *     object on update too).
 *   - `cron.update.request.deliveryTarget` — z.nullable(loose-record) since
 *     `null` clears the field and the structured shape varies by channel.
 *   - `cron.list.response.jobs[]` — each Job carries `schedule`, `payload`,
 *     `deliveryTarget` of varying inner shape.
 *   - `cron.runs.response.runs[]` — execution-history entries (tracker shape).
 *   - `heartbeat.update.request` — patch fields are heterogeneous per the
 *     `PerAgentHeartbeatConfigSchema` (admin patch with deep-merge).
 *   - `heartbeat.get.response.perAgent` + `.effective` — full per-agent
 *     heartbeat config (loose because the schema is large).
 *   - `subagent.list.response.runs[]` — SubAgentRun shape varies (tracker
 *     state + spawn metadata).
 *
 * Modelling these tighter would re-encode the entire orchestrator schema
 * surface in the contract — pinning the wire format across daemon restarts
 * on every minor schema field addition. The authoritative validation is the
 * handler's parseExecutionGraph / PerAgentHeartbeatConfigSchema; the contract
 * is type narrowing + dev-mode shape-regression canary.
 *
 * **Allowlist compliance.** All schemas use the 12-shape allowlist:
 * z.object, z.string (bare `z.string()` everywhere — no `.url()` /
 * `.regex()` refinements), z.number, z.boolean, z.literal, z.enum, z.array,
 * z.nullable, z.optional, z.record (D-05 loose-record value-type),
 * z.union (where the response shape is a discriminated 2-variant).
 *
 * **BLOCKER 1 status (web-SPA only — EXEMPT).** No CLI file imports any
 * `cron.* / graph.* / heartbeat.* / subagent.*` method via `client.call(...)`.
 * Verified by empty grep: `grep -rln 'client\.call("cron\.\|client\.call(
 * "graph\.\|client\.call("heartbeat\.\|client\.call("subagent\.'
 * packages/cli/src/` returns 0 matches. Web SPA consumes its own typed
 * registry (`packages/web/src/api/types/rpc-registry.ts`); Wave D codegen will
 * bridge those types from this contract registry. Same BLOCKER 1 exemption
 * pattern as Plans 35-09/10/12/13/14/15/17.
 *
 * **BLOCKER 6 (Wave C precedent).** Per orchestrator directive ("Additive
 * edits to api-contracts/index.ts are accepted; Plan 35-19 owns final atomic
 * edit"), `index.ts` is updated to register `ORCHESTRATOR_CONTRACTS` (1 import
 * line + 1 spread + 1 re-export).
 *
 * **Plan-vs-reality.** The plan's `<truths>` enumerated `~22 contracts` and
 * the `<interfaces>` listed 26 methods. Reality: 27 contracts (8 cron + 12
 * graph + 4 heartbeat + 3 subagent). The plan over-projected `~22` by 5 (or
 * undercounted scheduler.wake + 4 extras across graph/cron). Acceptance
 * criteria reflect the actual counts.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ===========================================================================
// --- cron-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// cron.add
// ---------------------------------------------------------------------------

/**
 * `cron.add` — Register a new scheduled cron job. Rpc-scoped per
 * setup-gateway-api.ts:130-157. Handler path: cron-handlers.ts:71-133.
 *
 * **PATTERNS OQ-4 transformer relocation.** Pre-Plan-35-18, the dispatcher
 * carried an inline transformer that converted the web `CronJobInput` payload
 * (nested `schedule` + `message`) into the flat fields the handler expects.
 * Per OQ-4 option (c), the transformer moves into the handler body. The
 * contract describes the WEB on-wire shape (nested `schedule.{kind,expr,tz,
 * everyMs,at}` + `message`); the handler body accepts BOTH the web shape
 * (nested) AND the legacy chat-tool shape (flat `schedule_kind` /
 * `schedule_every_ms` / etc.) to preserve the 14+ existing handler-test
 * invocations.
 *
 * Bespoke pre-Zod validation: duplicate job-name guard reads name on
 * rawParams.name BEFORE the schedule normalization (preserves the
 * "A job named X already exists" message-text contract).
 *
 * Request: `{ name, agentId?, schedule, message }` (web web shape) — the
 * handler also accepts `{ name, schedule_kind, schedule_every_ms?,
 * schedule_expr?, timezone?, schedule_at?, payload_kind?, payload_text }`
 * (legacy flat shape). Loose-record on `schedule` per D-05 (variant inner
 * shape per schedule.kind).
 *
 * Response: `{ jobId, name, schedule, model? }`. `schedule` is the normalized
 * CronSchedule shape (`{ kind: "every" | "cron" | "at", ... }`).
 */
export const CronAddContract = defineContract({
  method: "cron.add",
  request: z.object({
    // Web on-wire shape (nested schedule + message + agentId at top level).
    name: z.string(),
    agentId: z.string().optional(),
    schedule: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
    // Optional pass-through fields (preserved by handler normalization).
    sessionTarget: z.string().optional(),
    deliveryTarget: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    // Legacy flat shape (chat-tool path — exercised by 14+ existing tests).
    schedule_kind: z.string().optional(),
    payload_kind: z.string().optional(),
    payload_text: z.string().optional(),
    schedule_expr: z.string().optional(),
    timezone: z.string().optional(),
    schedule_every_ms: z.number().optional(),
    schedule_at: z.string().optional(),
    // Optional model + session strategy + wake mode (read directly by handler).
    model: z.string().optional(),
    session_target: z.string().optional(),
    wake_mode: z.string().optional(),
    forward_to_main: z.boolean().optional(),
    session_strategy: z.string().optional(),
    max_history_turns: z.number().optional(),
  }),
  response: z.object({
    jobId: z.string(),
    name: z.string(),
    schedule: z.record(z.string(), z.unknown()),
    model: z.string().optional(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.list
// ---------------------------------------------------------------------------

/**
 * `cron.list` — List scheduled jobs for the calling agent. Rpc-scoped per
 * setup-gateway-api.ts:130-134. Handler path: cron-handlers.ts:135-155.
 *
 * Request: `{}` (handler reads `_agentId` from rawParams).
 * Response: `{ jobs: Job[] }`. Each Job carries `id`, `name`, `agentId`,
 * `enabled`, `schedule`, `payload`, `sessionTarget`, `nextRunAtMs?`,
 * `lastRunAtMs?`, `consecutiveErrors`, `createdAtMs`, optional
 * `deliveryTarget`. The Job entries are loose-records per D-05 — the schedule
 * + payload + deliveryTarget inner shapes vary by job kind.
 */
export const CronListContract = defineContract({
  method: "cron.list",
  request: z.object({}),
  response: z.object({
    jobs: z.array(z.record(z.string(), z.unknown())),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.update
// ---------------------------------------------------------------------------

/**
 * `cron.update` — Update an existing job's fields. Rpc-scoped per
 * setup-gateway-api.ts:155-157. Handler path: cron-handlers.ts:157-193.
 *
 * Bespoke pre-Zod validation:
 *   - Missing job (by jobId or jobName) → `"Job not found: <id>"`.
 *   - Ambiguous jobName → `"Ambiguous job name <name>: N jobs share this name"`.
 *
 * Request: `{ jobId?, jobName?, enabled?, name?, sessionTarget?, schedule?,
 *   message?, deliveryTarget? | null }`. Either `jobId` (web UI path) OR
 *   `jobName` (chat-tool path) resolves the job. `schedule` is the nested
 *   `{ kind, expr?, tz?, everyMs?, at? }`. `deliveryTarget = null` clears the
 *   field (channel un-binding).
 *
 * Response: `{ jobName, updated }`.
 */
export const CronUpdateContract = defineContract({
  method: "cron.update",
  request: z.object({
    jobId: z.string().optional(),
    jobName: z.string().optional(),
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    sessionTarget: z.string().optional(),
    schedule: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
    deliveryTarget: z.nullable(z.record(z.string(), z.unknown())).optional(),
  }),
  response: z.object({
    jobName: z.string(),
    updated: z.boolean(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.remove
// ---------------------------------------------------------------------------

/**
 * `cron.remove` — Remove a job by name. Rpc-scoped per
 * setup-gateway-api.ts:155-157. Handler path: cron-handlers.ts:195-202.
 *
 * Bespoke pre-Zod validation:
 *   - Unknown jobName → `"Job not found: <name>"`.
 *   - Ambiguous jobName → `"Ambiguous job name <name>: N jobs share this name"`.
 *
 * Request: `{ jobName }`. Resolves by name only (no jobId fallback for remove).
 * Response: `{ jobName, removed }`.
 */
export const CronRemoveContract = defineContract({
  method: "cron.remove",
  request: z.object({
    jobName: z.string(),
  }),
  response: z.object({
    jobName: z.string(),
    removed: z.boolean(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.status
// ---------------------------------------------------------------------------

/**
 * `cron.status` — Report scheduler availability for the calling agent.
 * Rpc-scoped per setup-gateway-api.ts:155-157. Handler path:
 * cron-handlers.ts:204-211.
 *
 * Request: `{}` (handler reads `_agentId` from rawParams).
 * Response: `{ running, jobCount }`. `running: true` only when the scheduler
 * is registered for the resolved agentId.
 */
export const CronStatusContract = defineContract({
  method: "cron.status",
  request: z.object({}),
  response: z.object({
    running: z.boolean(),
    jobCount: z.number(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.runs
// ---------------------------------------------------------------------------

/**
 * `cron.runs` — Return execution-history entries for a job. Rpc-scoped per
 * setup-gateway-api.ts:155-157. Handler path: cron-handlers.ts:213-222.
 *
 * Bespoke pre-Zod validation: missing/unknown jobName falls through to the
 * tracker check (empty runs returned).
 *
 * Request: `{ jobName, limit? }`. `limit` defaults to 20 in the handler.
 * Response: `{ runs: RunEntry[] }`. RunEntry is a loose-record (tracker
 * shape: `{ runId, jobId, startedAt, completedAt, status, ... }`).
 */
export const CronRunsContract = defineContract({
  method: "cron.runs",
  request: z.object({
    jobName: z.string(),
    limit: z.number().optional(),
  }),
  response: z.object({
    runs: z.array(z.record(z.string(), z.unknown())),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// cron.run
// ---------------------------------------------------------------------------

/**
 * `cron.run` — Trigger a job (force) or run all due jobs. Rpc-scoped per
 * setup-gateway-api.ts:155-157. Handler path: cron-handlers.ts:224-239.
 *
 * Bespoke pre-Zod validation:
 *   - Force mode + unknown jobName → `"Job not found: <name>"`.
 *
 * Request: `{ jobName?, mode? }`. `mode` defaults to "force"; "due" runs all
 *   missed jobs (no jobName required for "due").
 * Response: `{ triggered, mode, jobName? }`.
 */
export const CronRunContract = defineContract({
  method: "cron.run",
  request: z.object({
    jobName: z.string().optional(),
    mode: z.string().optional(),
  }),
  response: z.object({
    triggered: z.boolean(),
    mode: z.string(),
    jobName: z.string().optional(),
  }),
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// scheduler.wake
// ---------------------------------------------------------------------------

/**
 * `scheduler.wake` — Request an immediate heartbeat tick (debounced via
 * wakeCoalescer). Registration-plane-agnostic — there is NO explicit
 * setup-gateway-api.ts entry for `scheduler.wake`; the dispatcher resolves it
 * intrinsically through the rpcDispatch map. Scope is implicit rpc (no admin
 * trust check in handler body). Handler path: cron-handlers.ts:241-245.
 *
 * Request: `{ source? }`. `source` defaults to "agent" if not provided.
 * Response: `{ woke, source }`.
 */
export const SchedulerWakeContract = defineContract({
  method: "scheduler.wake",
  request: z.object({
    source: z.string().optional(),
  }),
  response: z.object({
    woke: z.boolean(),
    source: z.string(),
  }),
  scopes: ["rpc"] as const,
});

// ===========================================================================
// --- graph-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// graph.define
// ---------------------------------------------------------------------------

/**
 * `graph.define` — Validate a graph structure and return node count + execution
 * order WITHOUT executing. Rpc-scoped per setup-gateway-api.ts:317-321.
 * Handler path: graph-handlers.ts:397-411.
 *
 * Bespoke pre-Zod validation:
 *   - Missing/empty `nodes[]` → `"Missing required parameter: nodes"`.
 *   - parseExecutionGraph + validateAndSortGraph failure → throws with issue
 *     details from the graph parser.
 *
 * Request: `{ nodes, label?, onFailure?, timeoutMs?, budget?, edges? }`.
 *   - `nodes` is `z.array(z.record(z.string(), z.unknown()))` because the
 *     handler calls `transformNodes` (snake_case → camelCase + legacy debate
 *     migration) BEFORE parseExecutionGraph. Inner shape varies per
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
 * `graph.execute` — Validate + start a GraphCoordinator run. Rpc-scoped per
 * setup-gateway-api.ts:317-321. Handler path: graph-handlers.ts:413-492.
 *
 * **D-05 loose-record (request + response).** Graph schema authority lives in
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
 * Rpc-scoped per setup-gateway-api.ts:317-321. Handler path:
 * graph-handlers.ts:494-562.
 *
 * Bespoke pre-Zod validation:
 *   - graphId provided but no snapshot → `"Graph not found"`.
 *
 * Request: `{ graphId?, graph_id?, recentMinutes? }`. When neither graphId
 *   nor graph_id is provided, the handler returns a list-recent + concurrency
 *   stats variant.
 *
 * Response is a discriminated 2-variant via D-05 loose-record (the per-graph
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
 * `graph.cancel` — Cancel a running graph. Rpc-scoped per
 * setup-gateway-api.ts:317-321. Handler path: graph-handlers.ts:564-585.
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
 * `graph.save` — Persist a named graph to the namedGraphStore. Rpc-scoped per
 * setup-gateway-api.ts:317-321. Handler path: graph-handlers.ts:591-620.
 *
 * Bespoke pre-Zod validation:
 *   - `!deps.namedGraphStore` → `"Named graph storage not available"`.
 *   - Missing/empty label → `"Missing required parameter: label (non-empty string)"`.
 *   - parseExecutionGraph + validateTypeConfigs runs (same as graph.define).
 *
 * Request: `{ label, id?, agentId?, nodes, edges?, settings? }`. Settings is
 *   a loose-record per D-05 (varies per saved graph).
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
 * `graph.load` — Load a persisted named graph by id. Rpc-scoped per
 * setup-gateway-api.ts:317-321. Handler path: graph-handlers.ts:622-648.
 *
 * Bespoke pre-Zod validation:
 *   - `!deps.namedGraphStore` → `"Named graph storage not available"`.
 *   - Missing id → `"Missing required parameter: id"`.
 *   - Unknown id → `"Named graph not found"`.
 *
 * Request: `{ id }`.
 *
 * Response: `{ ...entry, nodes, edges }` where entry contains tenantId,
 *   agentId, label, settings, createdAtMs, etc. Loose-record per D-05.
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
 * `graph.list` — List persisted named graphs. Rpc-scoped per
 * setup-gateway-api.ts:317-321. Handler path: graph-handlers.ts:650-662.
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
 * `graph.delete` — Soft-delete a persisted named graph. Rpc-scoped per
 * setup-gateway-api.ts:317-321. Handler path: graph-handlers.ts:664-681.
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
 * `graph.outputs` — Per-node outputs (in-memory or disk fallback). Rpc-scoped
 * per setup-gateway-api.ts:317-321. Handler path: graph-handlers.ts:687-753.
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
 * `graph.runs` — List graph run history from disk. Rpc-scoped per
 * setup-gateway-api.ts:317-321. Handler path: graph-handlers.ts:759-820.
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
 * disk. Rpc-scoped per setup-gateway-api.ts:317-321. Handler path:
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
 * Rpc-scoped per setup-gateway-api.ts:317-321. Handler path:
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

// ===========================================================================
// --- heartbeat-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// heartbeat.states
// ---------------------------------------------------------------------------

/**
 * `heartbeat.states` — Read-only DTO array of per-agent heartbeat states.
 * Admin-scoped per setup-gateway-api.ts:327-329. Handler path:
 * heartbeat-handlers.ts:42-77.
 *
 * Request: `{}` (no params consumed).
 * Response: `{ agents: AgentHeartbeatState[] }`. Each entry: `{ agentId,
 *   enabled, intervalMs, lastRunMs, nextDueMs, consecutiveErrors,
 *   backoffUntilMs, tickStartedAtMs, lastAlertMs, lastErrorKind }`.
 *   `lastErrorKind` is `"transient" | "permanent" | null`.
 */
export const HeartbeatStatesContract = defineContract({
  method: "heartbeat.states",
  request: z.object({}),
  response: z.object({
    agents: z.array(z.object({
      agentId: z.string(),
      enabled: z.boolean(),
      intervalMs: z.number(),
      lastRunMs: z.number(),
      nextDueMs: z.number(),
      consecutiveErrors: z.number(),
      backoffUntilMs: z.number(),
      tickStartedAtMs: z.number(),
      lastAlertMs: z.number(),
      lastErrorKind: z.nullable(z.enum(["transient", "permanent"])),
    })),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// heartbeat.get
// ---------------------------------------------------------------------------

/**
 * `heartbeat.get` — Read per-agent + effective heartbeat config. Admin-scoped
 * per setup-gateway-api.ts:327-329. Handler path: heartbeat-handlers.ts:82-110.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `agentId` (or `_agentId`) → `"Missing required parameter: agentId"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *
 * Request: `{ agentId? }` (handler reads `_agentId` from rawParams as a
 *   fallback).
 * Response: `{ agentId, perAgent, effective? }`. `perAgent` is the loose-record
 *   per-agent heartbeat config (or `{}` for unconfigured agents). `effective`
 *   is the loose-record full resolved config (only present when global config
 *   is well-formed).
 */
export const HeartbeatGetContract = defineContract({
  method: "heartbeat.get",
  request: z.object({
    agentId: z.string().optional(),
  }),
  response: z.object({
    agentId: z.string(),
    perAgent: z.record(z.string(), z.unknown()),
    effective: z.record(z.string(), z.unknown()).optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// heartbeat.update
// ---------------------------------------------------------------------------

/**
 * `heartbeat.update` — Patch per-agent heartbeat config with deep-merge +
 * YAML persistence. Admin-scoped per setup-gateway-api.ts:327-329 AND
 * in-handler `_trustLevel === "admin"` gate. Handler path:
 * heartbeat-handlers.ts:115-206.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for heartbeat
 *     configuration"`.
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - Unknown agentId → `"Agent not found: <id>"`.
 *
 * Request: `{ agentId?, ...patchFields }`. Patch fields include `enabled`,
 *   `intervalMs`, `showOk`, `showAlerts`, `prompt`, `model`, `session`,
 *   `allowDm`, `lightContext`, `ackMaxChars`, `responsePrefix`,
 *   `skipHeartbeatOnlyDelivery`, `alertThreshold`, `alertCooldownMs`,
 *   `staleMs`, plus optional `targetChannelType`/`targetChannelId`/
 *   `targetChatId`/`targetIsDm` (build target sub-object). The merged config
 *   is validated via `PerAgentHeartbeatConfigSchema.parse(merged)` in the
 *   handler.
 *
 * Response: `{ agentId, config, updated }`. `config` is the loose-record
 *   full PerAgentHeartbeatConfig.
 */
export const HeartbeatUpdateContract = defineContract({
  method: "heartbeat.update",
  request: z.object({
    agentId: z.string().optional(),
    enabled: z.boolean().optional(),
    intervalMs: z.number().optional(),
    showOk: z.boolean().optional(),
    showAlerts: z.boolean().optional(),
    prompt: z.string().optional(),
    model: z.string().optional(),
    session: z.string().optional(),
    allowDm: z.boolean().optional(),
    lightContext: z.boolean().optional(),
    ackMaxChars: z.number().optional(),
    responsePrefix: z.string().optional(),
    skipHeartbeatOnlyDelivery: z.boolean().optional(),
    alertThreshold: z.number().optional(),
    alertCooldownMs: z.number().optional(),
    staleMs: z.number().optional(),
    targetChannelType: z.string().optional(),
    targetChannelId: z.string().optional(),
    targetChatId: z.string().optional(),
    targetIsDm: z.boolean().optional(),
  }),
  response: z.object({
    agentId: z.string(),
    config: z.record(z.string(), z.unknown()),
    updated: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// heartbeat.trigger
// ---------------------------------------------------------------------------

/**
 * `heartbeat.trigger` — Immediate per-agent heartbeat execution. Admin-scoped
 * per setup-gateway-api.ts:327-329 AND in-handler `_trustLevel === "admin"`
 * gate. Handler path: heartbeat-handlers.ts:211-230.
 *
 * Bespoke pre-Zod validation:
 *   - `_trustLevel !== "admin"` → `"Admin access required for heartbeat trigger"`.
 *   - Missing `agentId` → `"Missing required parameter: agentId"`.
 *   - `!deps.perAgentRunner` → `"Heartbeat runner not available"`.
 *
 * Request: `{ agentId? }` (handler reads `_agentId` from rawParams as a
 *   fallback).
 * Response: `{ agentId, triggered }`.
 */
export const HeartbeatTriggerContract = defineContract({
  method: "heartbeat.trigger",
  request: z.object({
    agentId: z.string().optional(),
  }),
  response: z.object({
    agentId: z.string(),
    triggered: z.boolean(),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- subagent-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// subagent.list
// ---------------------------------------------------------------------------

/**
 * `subagent.list` — List sub-agent runs (filtered by recentMinutes). Admin-
 * scoped per setup-gateway-api.ts:207-209. Handler path:
 * subagent-handlers.ts:40-44.
 *
 * Request: `{ recentMinutes? }`. Defaults to 30.
 * Response: `{ runs, total }`. Each run is a loose-record (SubAgentRun shape
 *   varies — carries runId, agentId, task, state, spawn metadata).
 */
export const SubagentListContract = defineContract({
  method: "subagent.list",
  request: z.object({
    recentMinutes: z.number().optional(),
  }),
  response: z.object({
    runs: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// subagent.kill
// ---------------------------------------------------------------------------

/**
 * `subagent.kill` — Mark a running sub-agent run as failed. Admin-scoped per
 * setup-gateway-api.ts:207-209. Handler path: subagent-handlers.ts:46-55.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `target` → `"Missing required parameter: target"`.
 *   - killRun returns !killed → throws with the result's error message.
 *
 * Request: `{ target }`. `target` is the runId.
 * Response: `{ killed, runId }`.
 */
export const SubagentKillContract = defineContract({
  method: "subagent.kill",
  request: z.object({
    target: z.string(),
  }),
  response: z.object({
    killed: z.boolean(),
    runId: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// subagent.steer
// ---------------------------------------------------------------------------

/**
 * `subagent.steer` — Kill current run and respawn with a new task.
 * Rate-limited at 2s per target. Admin-scoped per setup-gateway-api.ts:207-209.
 * Handler path: subagent-handlers.ts:57-105.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `target` → `"Missing required parameter: target"`.
 *   - Missing `message` → `"Missing required parameter: message"`.
 *   - Rate-limit (< 2s since last steer to same target) → `"Rate limited: wait
 *     2s between steers to same target"`.
 *   - killRun !killed → throws.
 *   - getRunStatus undefined after kill → `"Run details not found after kill: <id>"`.
 *
 * Request: `{ target, message }`.
 * Response: `{ status, oldRunId, newRunId }`. `status` is literal "steered".
 */
export const SubagentSteerContract = defineContract({
  method: "subagent.steer",
  request: z.object({
    target: z.string(),
    message: z.string(),
  }),
  response: z.object({
    status: z.literal("steered"),
    oldRunId: z.string(),
    newRunId: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// Aggregator
// ===========================================================================

/**
 * Tuple of every contract for the orchestrator umbrella. The bidirectional
 * 1:1 architecture test treats this as an unordered set; the per-handler
 * grouping below is documentation-only.
 *
 * Order:
 *   1. cron-handlers.ts        (8 entries — cron.* + scheduler.wake)
 *   2. graph-handlers.ts       (12 entries — graph.*)
 *   3. heartbeat-handlers.ts   (4 entries — heartbeat.*)
 *   4. subagent-handlers.ts    (3 entries — subagent.*)
 *
 * Total: 27 contracts.
 */
export const ORCHESTRATOR_CONTRACTS = [
  // cron-handlers.ts
  CronAddContract,
  CronListContract,
  CronUpdateContract,
  CronRemoveContract,
  CronStatusContract,
  CronRunsContract,
  CronRunContract,
  SchedulerWakeContract,
  // graph-handlers.ts
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
  // heartbeat-handlers.ts
  HeartbeatStatesContract,
  HeartbeatGetContract,
  HeartbeatUpdateContract,
  HeartbeatTriggerContract,
  // subagent-handlers.ts
  SubagentListContract,
  SubagentKillContract,
  SubagentSteerContract,
] as const;
