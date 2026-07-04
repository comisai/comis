// SPDX-License-Identifier: Apache-2.0
/**
 * DurableRunRecord: the Zod-validated checkpoint a long-running agent run
 * persists so a daemon restart can resume it.
 *
 * The record is read back on resume and decides what the rehydrated run may do,
 * so the schema is the trust boundary: `caps` is the closed
 * AgentCapability union (a tampered cap string cannot rehydrate), `status` is a
 * closed four-state set, and `strictObject` rejects any column the store DDL
 * adds without a matching field — so the schema and the SQLite table
 * move in lockstep, exactly like `video-job-row-schema.ts`.
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
  status: z.string(),
  runId: z.string().optional(),
});

/**
 * The durable run checkpoint. `strictObject` (no extra columns) + the closed
 * `caps`/`status` unions make a tampered or column-drifted row unrepresentable.
 */
export const DurableRunRecordSchema = z.strictObject({
  /** The root run id — the idempotency key the store upserts on. */
  rootRunId: z.string(),
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
  budgetConsumed: z.number(),
  /** The cron job id this run was launched from, or null for a user-originated run. */
  cronOrigin: z.string().nullable(),
  /**
   * The outward-send counter — maps to the dedicated
   * `outward_step` DB column. `-1` is the 'no outward send yet'
   * sentinel: the counter seeds at -1 so the first `allocateOutwardStep` yields
   * 0. It MUST parse (`.min(-1)`) or a checkpointed-but-not-yet-sent run
   * is falsely rejected by `parseDurableRunRecord` and orphaned on restart,
   * making the run unresumable.
   */
  stepIndex: z.number().int().min(-1),
  /** The run lifecycle state — the closed running/orphaned/completed/revoked set. */
  status: DurableRunStatusSchema,
  /** The last keep-alive heartbeat write, epoch ms. */
  lastHeartbeatAt: z.number(),
  /**
   * The pinned script path RELATIVE to the run workspace (`<runId>.<language>`)
   * for a RE-RUNNABLE orchestrate row. Its presence is the orchestrate-kind
   * discriminator the boot sweep routes on. Content-free: a path, NOT the script
   * bytes (INV-5). Optional/nullable so EVERY existing row (which has neither
   * this nor `checkpointRef`) still parses — the closed-union resume gate is
   * unweakened.
   */
  scriptRef: z.string().nullable().optional(),
  /**
   * The `ResultRef.ref` id of the last checkpoint blob (a distinguished
   * `kind:"json"` ResultRef). Content-free: an id pointer, NOT the checkpoint
   * body (INV-5) — the bytes live in the capped/TTL'd `results/` store.
   * Optional/nullable for the same reason as `scriptRef`.
   */
  checkpointRef: z.string().nullable().optional(),
});

export type DurableRunRecord = z.infer<typeof DurableRunRecordSchema>;

/**
 * Parse unknown input into a DurableRunRecord, returning Result<T, ZodError>.
 *
 * The AGENTS §6.3 domain-parse contract: wraps `safeParse` so call sites chain
 * by early-return and never touch `.parse()` (throws) or raw `.safeParse()`.
 * A malformed or over-permissive row (unknown column, foreign cap, out-of-set
 * status, stepIndex below the -1 sentinel) returns `err`.
 */
export function parseDurableRunRecord(raw: unknown): Result<DurableRunRecord, z.ZodError> {
  const parsed = DurableRunRecordSchema.safeParse(raw);
  if (parsed.success) {
    return ok(parsed.data);
  }
  return err(parsed.error);
}
