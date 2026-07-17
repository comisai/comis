// SPDX-License-Identifier: Apache-2.0
/**
 * DurableRunRecord: the Zod-validated checkpoint a long-running agent run
 * persists so a daemon restart can resume it.
 *
 * The record is read back on resume and decides what the rehydrated run may do,
 * so the schema is the domain boundary: `caps` is the closed
 * AgentCapability union (a tampered cap string cannot rehydrate), `status` is a
 * closed four-state set, and `strictObject` rejects any column the store DDL
 * adds without a matching field. Cross-field validation also binds the
 * canonical session tenant/user to the persisted owner and delivery origin.
 *
 * `caps` reuses the single AGENT_CAPABILITIES tuple from
 * `security/capability.ts` (the SSOT) via `z.enum(...)` — the same construction
 * `config/schema-agent/schema-agent-autonomy.ts` uses — so the persisted caps
 * and the in-memory union can never drift.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";
import { AGENT_CAPABILITIES } from "../security/capability.js";
import { UserTrustLevelSchema } from "../context/context.js";
import { DeliveryOriginSchema } from "./delivery-origin.js";
import {
  ExecutionGraphSchema,
  NodeExecutionStateSchema,
  NodeStatusSchema,
} from "./execution-graph.js";
import { parseFormattedSessionKey } from "./session-key.js";

/**
 * The closed AgentCapability union as a Zod schema, built from the single
 * AGENT_CAPABILITIES tuple (SSOT in security/capability.ts). A persisted cap
 * outside this set fails `parseDurableRunRecord` — a tampered/foreign cap
 * string can never rehydrate into a resumed run's authority.
 */
export const AgentCapabilitySchema = z.enum(AGENT_CAPABILITIES);

/**
 * The closed run-status set. `running` rows are the boot-resume scan
 * (`listResumable`); `revoked` is the terminal state a `invalidateForRevoke`
 * write flips a record to so resume can never re-mint a revoked run.
 */
export const DurableRunStatusSchema = z.enum(["running", "orphaned", "completed", "revoked"]);

export type DurableRunStatus = z.infer<typeof DurableRunStatusSchema>;

/**
 * A single spawn-tree node for a DAG/graph run — the `snapshotToSpawnTree`
 * shape. `status` is a free string here (the graph engine owns the
 * node-status vocabulary); `runId` is present once the node has been minted.
 */
const SpawnTreeNodeSchema = z.strictObject({
  nodeId: z.string(),
  status: NodeStatusSchema,
  runId: z.string().optional(),
});

/** Absolute, tree-wide budget state persisted by every sibling checkpoint. */
export const DurableRootBudgetSchema = z.strictObject({
  /** Original wall-clock anchor for the tree, epoch ms. */
  startedAtMs: z.number().nonnegative().finite(),
  /** Tokens admitted by the per-root meter so far. */
  tokensConsumed: z.number().int().nonnegative(),
  /** Priced USD admitted by the per-root meter so far. */
  usdConsumed: z.number().nonnegative().finite(),
});

export type DurableRootBudget = z.infer<typeof DurableRootBudgetSchema>;

const DurableNodeCacheDataSchema = z.strictObject({
  nodeId: z.string().min(1),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});

const DurableNodeTokenSpendSchema = z.strictObject({
  nodeId: z.string().min(1),
  tokens: z.number().int().nonnegative(),
});

const DurableNodeCostSchema = z.strictObject({
  nodeId: z.string().min(1),
  cost: z.number().nonnegative().finite(),
});

/** Authoritative graph state needed to continue the exact submitted DAG. */
const DurableGraphCheckpointSchema = z.strictObject({
  graph: ExecutionGraphSchema,
  executionOrder: z.array(z.string().min(1)).min(1),
  nodes: z.array(NodeExecutionStateSchema).min(1),
  startedAtMs: z.number().nonnegative().finite(),
  cumulativeTokens: z.number().int().nonnegative(),
  cumulativeCost: z.number().nonnegative().finite(),
  nodeCacheData: z.array(DurableNodeCacheDataSchema),
  nodeTokenSpend: z.array(DurableNodeTokenSpendSchema),
  nodeCost: z.array(DurableNodeCostSchema),
  skippedNodesEmitted: z.array(z.string().min(1)),
}).superRefine((checkpoint, ctx) => {
  const graphIds = checkpoint.graph.nodes.map((node) => node.nodeId);
  const graphIdSet = new Set(graphIds);
  const stateIds = checkpoint.nodes.map((node) => node.nodeId);
  if (
    graphIdSet.size !== graphIds.length
    || stateIds.length !== graphIds.length
    || new Set(stateIds).size !== stateIds.length
    || stateIds.some((nodeId) => !graphIdSet.has(nodeId))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["nodes"],
      message: "graph checkpoint node states must match the graph node set exactly",
    });
  }
  if (
    checkpoint.executionOrder.length !== graphIds.length
    || new Set(checkpoint.executionOrder).size !== checkpoint.executionOrder.length
    || checkpoint.executionOrder.some((nodeId) => !graphIdSet.has(nodeId))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["executionOrder"],
      message: "graph checkpoint executionOrder must match the graph node set exactly",
    });
  }
  for (const [field, entries] of [
    ["nodeCacheData", checkpoint.nodeCacheData],
    ["nodeTokenSpend", checkpoint.nodeTokenSpend],
    ["nodeCost", checkpoint.nodeCost],
  ] as const) {
    const ids = entries.map((entry) => entry.nodeId);
    if (new Set(ids).size !== ids.length || ids.some((nodeId) => !graphIdSet.has(nodeId))) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${field} entries must be unique members of the graph node set`,
      });
    }
  }
  if (checkpoint.skippedNodesEmitted.some((nodeId) => !graphIdSet.has(nodeId))) {
    ctx.addIssue({
      code: "custom",
      path: ["skippedNodesEmitted"],
      message: "skippedNodesEmitted must contain graph node ids only",
    });
  }
});

export type DurableGraphCheckpoint = z.infer<typeof DurableGraphCheckpointSchema>;

export function parseDurableGraphCheckpoint(
  raw: unknown,
): Result<DurableGraphCheckpoint, z.ZodError> {
  const parsed = DurableGraphCheckpointSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}

/**
 * The durable run checkpoint. `strictObject` (no extra columns) + the closed
 * `caps`/`status` unions make a tampered or column-drifted row unrepresentable.
 */
export const DurableRunRecordSchema = z.strictObject({
  /** Unique identity of this execution checkpoint. */
  checkpointId: z.string().min(1),
  /** Tree identity shared by descendants for budgets and revocation. */
  rootRunId: z.string().min(1),
  /** Authenticated agent that owns this execution. */
  agentId: z.string().min(1),
  /** Canonically formatted session identity. */
  sessionKey: z.string().min(1),
  /** Authenticated tenant owner. */
  ownerTenantId: z.string().min(1),
  /** Authenticated user owner. */
  ownerUserId: z.string().min(1),
  /** Exact channel origin inherited by a resumed execution, when present. */
  deliveryOrigin: DeliveryOriginSchema.nullable(),
  /**
   * The spawn-tree union and the DAG-vs-flat discriminator:
   *   - a FLAT run's spawn tree is `string[]` of leaseId/sessionKey node ids;
   *   - a DAG/graph run's is `{nodeId,status,runId?}[]`.
   * Both shapes MUST parse so a DAG checkpoint passes `parseDurableRunRecord`.
   * On resume, string entries ⇒ flat (resume the run); object-entries-with-
   * `status` ⇒ DAG (resumeGraph).
   */
  spawnTree: z.union([z.array(z.string()), z.array(SpawnTreeNodeSchema)]),
  /** The caps the resumed run may hold — the closed AgentCapability union. */
  caps: z.array(AgentCapabilitySchema),
  /** The leases held by this run; rehydrated on resume. */
  leaseIds: z.array(z.string()),
  /** Budget (USD) consumed so far; the resumed run continues against the remainder. */
  budgetConsumed: z.number().nonnegative().finite(),
  /** Authoritative absolute tree-wide meter state shared by sibling rows. */
  rootBudget: DurableRootBudgetSchema,
  /** The cron job id this run was launched from, or null for a user-originated run. */
  cronOrigin: z.string().nullable(),
  /** Exact authenticated trust ceiling inherited by a resumed execution. */
  trustLevel: UserTrustLevelSchema,
  /** The run lifecycle state — the closed running/orphaned/completed/revoked set. */
  status: DurableRunStatusSchema,
  /** The last keep-alive heartbeat write, epoch ms. */
  lastHeartbeatAt: z.number(),
  /**
   * The pinned script path RELATIVE to the run workspace (`<runId>.<language>`)
   * for a RE-RUNNABLE orchestrate row. Its presence is the orchestrate-kind
   * discriminator the boot sweep routes on. Content-free: a path, not the script
   * bytes. Nullable because only orchestrate checkpoints carry a pinned script.
   */
  scriptRef: z.string().nullable(),
  /**
   * The `ResultRef.ref` id of the last checkpoint blob (a distinguished
   * `kind:"json"` ResultRef). Content-free: an id pointer, NOT the checkpoint
   * body — the bytes live in the capped/TTL'd `results/` store. Nullable because
   * checkpoints without a result blob do not have a pointer.
   */
  checkpointRef: z.string().nullable(),
}).superRefine((record, ctx) => {
  if (record.budgetConsumed !== record.rootBudget.usdConsumed) {
    ctx.addIssue({
      code: "custom",
      path: ["rootBudget", "usdConsumed"],
      message: "rootBudget.usdConsumed must match budgetConsumed",
    });
  }
  if (record.rootBudget.startedAtMs > record.lastHeartbeatAt) {
    ctx.addIssue({
      code: "custom",
      path: ["rootBudget", "startedAtMs"],
      message: "rootBudget.startedAtMs cannot be later than lastHeartbeatAt",
    });
  }
  const isDag = record.spawnTree.length > 0 && typeof record.spawnTree[0] === "object";
  if (isDag && record.checkpointRef === null) {
    ctx.addIssue({
      code: "custom",
      path: ["checkpointRef"],
      message: "graph checkpoints require a protected checkpointRef artifact",
    });
  }
  const session = parseFormattedSessionKey(record.sessionKey);
  if (session === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["sessionKey"],
      message: "sessionKey must be a canonical formatted session identity",
    });
    return;
  }
  if (session.tenantId !== record.ownerTenantId) {
    ctx.addIssue({
      code: "custom",
      path: ["ownerTenantId"],
      message: "ownerTenantId must match the canonical session tenant",
    });
  }
  if (session.userId !== record.ownerUserId) {
    ctx.addIssue({
      code: "custom",
      path: ["ownerUserId"],
      message: "ownerUserId must match the canonical session user",
    });
  }
  if (
    record.deliveryOrigin !== null
    && record.deliveryOrigin.tenantId !== record.ownerTenantId
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["deliveryOrigin", "tenantId"],
      message: "delivery origin tenant must match the checkpoint owner",
    });
  }
  if (
    record.deliveryOrigin !== null
    && record.deliveryOrigin.userId !== record.ownerUserId
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["deliveryOrigin", "userId"],
      message: "delivery origin user must match the checkpoint owner",
    });
  }
});

export type DurableRunRecord = z.infer<typeof DurableRunRecordSchema>;

/**
 * Parse unknown input into a DurableRunRecord, returning Result<T, ZodError>.
 *
 * Wraps `safeParse` so call sites chain by early return without throwing.
 * A malformed or over-permissive row (unknown column, foreign cap, out-of-set
 * status) returns `err`.
 */
export function parseDurableRunRecord(raw: unknown): Result<DurableRunRecord, z.ZodError> {
  const parsed = DurableRunRecordSchema.safeParse(raw);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err(parsed.error);
}
