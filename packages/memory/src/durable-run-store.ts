// SPDX-License-Identifier: Apache-2.0
/** SQLite persistence for resumable execution checkpoints. */

import type Database from "better-sqlite3";
import { z } from "zod";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import {
  AgentCapabilitySchema,
  DurableRootBudgetSchema,
  DeliveryOriginSchema,
  UserTrustLevelSchema,
  parseDurableRunRecord,
  systemNowMs,
  type DurableRunPort,
  type DurableRunRecord,
  type DurableRootBudget,
  type DurableRunResumeClaim,
  type DurableRunResumeClaimOutcome,
  type DurableRunResumeScan,
  type InvalidDurableRunCheckpoint,
} from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import { DurableRunDbRowSchema, type DurableRunDbRow } from "./durable-run-row-schema.js";

export interface DurableRunStoreOptions {
  readonly nowMs?: () => number;
}

const durableRunMapper = createRowMapper(DurableRunDbRowSchema);
const statusCountMapper = createRowMapper(
  z.strictObject({ status: z.string(), c: z.number() }),
);
const durableRunIdentitySchema = z.object({
  checkpoint_id: z.string(),
  root_run_id: z.string(),
});
const durableRootMapper = createRowMapper(
  z.strictObject({ revoked_at_ms: z.number().nullable() }),
);
const durableCheckpointPayloadSchema = z.strictObject({
  spawnTree: z.unknown(),
  rootBudget: DurableRootBudgetSchema,
});
const resumeClaimSchema = z.strictObject({
  checkpointId: z.string().min(1),
  replacementCheckpointId: z.string().min(1),
  claimedAtMs: z.number().nonnegative().finite(),
  principal: z.strictObject({
    agentId: z.string().min(1),
    sessionKey: z.string().min(1),
    ownerTenantId: z.string().min(1),
    ownerUserId: z.string().min(1),
    deliveryOrigin: DeliveryOriginSchema.nullable(),
    trustLevel: UserTrustLevelSchema,
    caps: z.array(AgentCapabilitySchema),
  }),
}).refine((claim) => claim.checkpointId !== claim.replacementCheckpointId, {
  message: "replacementCheckpointId must differ from checkpointId",
});

function rowToRecord(row: DurableRunDbRow): Result<DurableRunRecord, Error> {
  let spawnTree: unknown;
  let caps: unknown;
  let leaseIds: unknown;
  let deliveryOrigin: unknown;
  let rootBudget: unknown;
  try {
    const payload = durableCheckpointPayloadSchema.safeParse(JSON.parse(row.spawn_tree));
    if (!payload.success) {
      return err(new Error(`durable_run_checkpoints row ${row.checkpoint_id} has an invalid checkpoint payload`));
    }
    spawnTree = payload.data.spawnTree;
    rootBudget = payload.data.rootBudget;
    caps = JSON.parse(row.caps);
    leaseIds = JSON.parse(row.lease_ids);
    deliveryOrigin = row.delivery_origin === null ? null : JSON.parse(row.delivery_origin);
  } catch (cause) {
    return err(
      new Error(
        `durable_run_checkpoints row ${row.checkpoint_id} has a corrupt JSON column: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      ),
    );
  }

  const parsed = parseDurableRunRecord({
    checkpointId: row.checkpoint_id,
    rootRunId: row.root_run_id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    ownerTenantId: row.owner_tenant_id,
    ownerUserId: row.owner_user_id,
    deliveryOrigin,
    spawnTree,
    caps,
    leaseIds,
    budgetConsumed: row.budget_consumed,
    rootBudget,
    cronOrigin: row.cron_origin,
    trustLevel: row.trust_level,
    status: row.status,
    lastHeartbeatAt: row.last_heartbeat_at,
    scriptRef: row.script_ref,
    checkpointRef: row.checkpoint_ref,
  });
  if (!parsed.ok) {
    return err(new Error(`durable checkpoint validation failed: ${parsed.error.message}`));
  }
  return ok(parsed.value);
}

export function createSqliteDurableRunStore(
  db: Database.Database,
  opts: DurableRunStoreOptions = {},
): DurableRunPort {
  const nowMs = opts.nowMs ?? systemNowMs;

  const upsertStmt = db.prepare(`
    INSERT INTO durable_run_checkpoints (
      checkpoint_id, root_run_id, agent_id, session_key, owner_tenant_id,
      owner_user_id, delivery_origin, spawn_tree, caps, lease_ids,
      budget_consumed, cron_origin, trust_level, status, last_heartbeat_at,
      created_at_ms, updated_at_ms, script_ref, checkpoint_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(checkpoint_id) DO UPDATE SET
      spawn_tree = excluded.spawn_tree,
      caps = excluded.caps,
      lease_ids = excluded.lease_ids,
      budget_consumed = excluded.budget_consumed,
      cron_origin = excluded.cron_origin,
      status = CASE
        WHEN durable_run_checkpoints.status IN ('revoked', 'completed', 'orphaned')
          THEN durable_run_checkpoints.status
        ELSE excluded.status
      END,
      last_heartbeat_at = excluded.last_heartbeat_at,
      updated_at_ms = excluded.updated_at_ms,
      script_ref = COALESCE(excluded.script_ref, script_ref),
      checkpoint_ref = COALESCE(excluded.checkpoint_ref, checkpoint_ref)
    WHERE durable_run_checkpoints.root_run_id = excluded.root_run_id
      AND durable_run_checkpoints.agent_id = excluded.agent_id
      AND durable_run_checkpoints.session_key = excluded.session_key
      AND durable_run_checkpoints.owner_tenant_id = excluded.owner_tenant_id
      AND durable_run_checkpoints.owner_user_id = excluded.owner_user_id
      AND durable_run_checkpoints.delivery_origin IS excluded.delivery_origin
      AND durable_run_checkpoints.trust_level = excluded.trust_level
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(excluded.caps) AS requested_cap
        WHERE NOT EXISTS (
          SELECT 1
          FROM json_each(durable_run_checkpoints.caps) AS held_cap
          WHERE held_cap.value = requested_cap.value
        )
      )
  `);
  const insertCheckpointStmt = db.prepare(`
    INSERT INTO durable_run_checkpoints (
      checkpoint_id, root_run_id, agent_id, session_key, owner_tenant_id,
      owner_user_id, delivery_origin, spawn_tree, caps, lease_ids,
      budget_consumed, cron_origin, trust_level, status, last_heartbeat_at,
      created_at_ms, updated_at_ms, script_ref, checkpoint_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getStmt = db.prepare(
    `SELECT * FROM durable_run_checkpoints WHERE checkpoint_id = ?`,
  );
  const listByRootStmt = db.prepare(
    `SELECT * FROM durable_run_checkpoints WHERE root_run_id = ?`,
  );
  const ensureRootStmt = db.prepare(`
    INSERT OR IGNORE INTO durable_run_roots (root_run_id, revoked_at_ms)
    VALUES (?, NULL)
  `);
  const getRootStmt = db.prepare(`
    SELECT revoked_at_ms FROM durable_run_roots WHERE root_run_id = ?
  `);
  const tombstoneRootStmt = db.prepare(`
    INSERT INTO durable_run_roots (root_run_id, revoked_at_ms)
    VALUES (?, ?)
    ON CONFLICT(root_run_id) DO UPDATE SET
      revoked_at_ms = COALESCE(durable_run_roots.revoked_at_ms, excluded.revoked_at_ms)
  `);
  const listResumableStmt = db.prepare(`
    SELECT * FROM durable_run_checkpoints
    WHERE status = 'running'
    ORDER BY last_heartbeat_at ASC
  `);
  const markOrphanedStmt = db.prepare(`
    UPDATE durable_run_checkpoints
    SET status = 'orphaned', orphan_reason = ?, updated_at_ms = ?
    WHERE checkpoint_id = ? AND status = 'running'
  `);
  const markCompletedStmt = db.prepare(`
    UPDATE durable_run_checkpoints
    SET status = 'completed', updated_at_ms = ?
    WHERE checkpoint_id = ? AND status = 'running'
  `);
  const touchHeartbeatStmt = db.prepare(`
    UPDATE durable_run_checkpoints
    SET last_heartbeat_at = ?, updated_at_ms = ?
    WHERE checkpoint_id = ? AND status = 'running'
  `);
  const invalidateForRevokeStmt = db.prepare(`
    UPDATE durable_run_checkpoints
    SET status = 'revoked', orphan_reason = 'revoked', updated_at_ms = ?
    WHERE root_run_id = ?
  `);
  const countByStatusStmt = db.prepare(`
    SELECT status, COUNT(*) AS c
    FROM durable_run_checkpoints
    WHERE updated_at_ms >= ?
    GROUP BY status
  `);

  function checkpointArgs(record: DurableRunRecord, t: number): unknown[] {
    return [
      record.checkpointId,
      record.rootRunId,
      record.agentId,
      record.sessionKey,
      record.ownerTenantId,
      record.ownerUserId,
      record.deliveryOrigin === null ? null : JSON.stringify(record.deliveryOrigin),
      JSON.stringify({
        spawnTree: record.spawnTree,
        rootBudget: record.rootBudget,
      }),
      JSON.stringify(record.caps),
      JSON.stringify(record.leaseIds),
      record.budgetConsumed,
      record.cronOrigin,
      record.trustLevel,
      record.status,
      record.lastHeartbeatAt,
      t,
      t,
      record.scriptRef ?? null,
      record.checkpointRef ?? null,
    ];
  }

  function rootIsRevoked(rootRunId: string): Result<boolean, Error> {
    const root = durableRootMapper.parseOptionalRow(getRootStmt.get(rootRunId));
    if (!root.ok) return err(new Error(`Durable root validation failed: ${root.error.message}`));
    if (root.value === undefined) return err(new Error(`Durable root ${rootRunId} was not initialized`));
    return ok(root.value.revoked_at_ms !== null);
  }

  function readRootBudgetAuthority(rootRunId: string): Result<DurableRootBudget | undefined, Error> {
    const rows = durableRunMapper.parseRows(listByRootStmt.all(rootRunId));
    if (!rows.ok) {
      return err(new Error(`Durable root checkpoint validation failed: ${rows.error.message}`));
    }
    let authority: DurableRootBudget | undefined;
    for (const row of rows.value) {
      const existing = rowToRecord(row);
      if (!existing.ok) return err(existing.error);
      const budget = existing.value.rootBudget;
      authority = authority === undefined
        ? budget
        : {
            startedAtMs: Math.min(authority.startedAtMs, budget.startedAtMs),
            tokensConsumed: Math.max(authority.tokensConsumed, budget.tokensConsumed),
            usdConsumed: Math.max(authority.usdConsumed, budget.usdConsumed),
          };
    }
    return ok(authority);
  }

  function validateRootBudgetFloor(checkpoint: DurableRunRecord): Result<void, Error> {
    const authority = readRootBudgetAuthority(checkpoint.rootRunId);
    if (!authority.ok) return authority;
    if (
      authority.value !== undefined
      && (
        checkpoint.rootBudget.startedAtMs > authority.value.startedAtMs
        || checkpoint.rootBudget.tokensConsumed < authority.value.tokensConsumed
        || checkpoint.rootBudget.usdConsumed < authority.value.usdConsumed
      )
    ) {
      return err(new Error(`durable checkpoint would reset budget authority for ${checkpoint.rootRunId}`));
    }

    const existingRow = durableRunMapper.parseOptionalRow(getStmt.get(checkpoint.checkpointId));
    if (!existingRow.ok) {
      return err(new Error(`Durable checkpoint validation failed: ${existingRow.error.message}`));
    }
    if (existingRow.value !== undefined) {
      const existing = rowToRecord(existingRow.value);
      if (!existing.ok) return err(existing.error);
      if (
        checkpoint.lastHeartbeatAt < existing.value.lastHeartbeatAt
      ) {
        return err(new Error(`durable checkpoint would move its heartbeat backward for ${checkpoint.checkpointId}`));
      }
    }
    return ok(undefined);
  }

  const upsertTransaction = db.transaction(
    (checkpoint: DurableRunRecord, t: number): Result<void, Error> => {
      if (checkpoint.status === "revoked") {
        tombstoneRootStmt.run(checkpoint.rootRunId, t);
      } else {
        const budgetFloor = validateRootBudgetFloor(checkpoint);
        if (!budgetFloor.ok) return budgetFloor;
        ensureRootStmt.run(checkpoint.rootRunId);
        const revoked = rootIsRevoked(checkpoint.rootRunId);
        if (!revoked.ok) return revoked;
        if (revoked.value) {
          return err(new Error(`durable root ${checkpoint.rootRunId} is revoked`));
        }
      }
      const written = upsertStmt.run(...checkpointArgs(checkpoint, t));
      if (written.changes !== 1) {
        return err(new Error(`durable checkpoint identity mismatch for ${checkpoint.checkpointId}`));
      }
      if (checkpoint.status === "revoked") {
        invalidateForRevokeStmt.run(t, checkpoint.rootRunId);
      }
      return ok(undefined);
    },
  );

  const claimTransaction = db.transaction(
    (claim: DurableRunResumeClaim): Result<DurableRunResumeClaimOutcome, Error> => {
      const rawSource = durableRunMapper.parseOptionalRow(getStmt.get(claim.checkpointId));
      if (!rawSource.ok) {
        return err(new Error(`Row validation failed: ${rawSource.error.message}`));
      }
      if (rawSource.value === undefined) return ok({ kind: "not_found" });
      const source = rowToRecord(rawSource.value);
      if (!source.ok) return err(source.error);
      const record = source.value;

      // The root comes from the validated persisted record, never from caller
      // input. Its authority row must already exist from the source write;
      // absence is corruption and fails closed rather than recreating authority.
      const revoked = rootIsRevoked(record.rootRunId);
      if (!revoked.ok) return revoked;
      if (revoked.value || record.status !== "running") {
        return ok({ kind: "not_resumable" });
      }
      if (claim.claimedAtMs < record.lastHeartbeatAt) {
        return err(new Error(`durable resume claim would move the heartbeat backward for ${record.checkpointId}`));
      }

      const principal = claim.principal;
      if (
        record.agentId !== principal.agentId
        || record.sessionKey !== principal.sessionKey
        || record.ownerTenantId !== principal.ownerTenantId
        || record.ownerUserId !== principal.ownerUserId
        || !sameDeliveryOrigin(record.deliveryOrigin, principal.deliveryOrigin)
        || trustRank(principal.trustLevel) < trustRank(record.trustLevel)
      ) {
        return ok({ kind: "authorization_denied" });
      }

      const target = durableRunMapper.parseOptionalRow(getStmt.get(claim.replacementCheckpointId));
      if (!target.ok) return err(new Error(`Row validation failed: ${target.error.message}`));
      if (target.value !== undefined) return ok({ kind: "not_resumable" });

      const rootBudget = readRootBudgetAuthority(record.rootRunId);
      if (!rootBudget.ok) return rootBudget;
      if (rootBudget.value === undefined) {
        return err(new Error(`Durable root ${record.rootRunId} has no checkpoint budget authority`));
      }
      const authoritativeRecordResult = parseDurableRunRecord({
        ...record,
        budgetConsumed: rootBudget.value.usdConsumed,
        rootBudget: rootBudget.value,
      });
      if (!authoritativeRecordResult.ok) {
        return err(new Error(`durable budget authority validation failed: ${authoritativeRecordResult.error.message}`));
      }
      const authoritativeRecord = authoritativeRecordResult.value;
      const currentCaps = new Set(principal.caps);
      const replacementResult = parseDurableRunRecord({
        ...authoritativeRecord,
        checkpointId: claim.replacementCheckpointId,
        caps: authoritativeRecord.caps.filter((capability) => currentCaps.has(capability)),
        leaseIds: [],
        status: "running",
        // Claim time is authority-row metadata, not execution progress. Keep
        // the source heartbeat until resumed execution writes a real
        // checkpoint/touch; otherwise every watchdog claim fabricates progress
        // and the no-progress cap can never fire.
        lastHeartbeatAt: authoritativeRecord.lastHeartbeatAt,
      });
      if (!replacementResult.ok) {
        return err(new Error(`durable replacement validation failed: ${replacementResult.error.message}`));
      }

      const completed = markCompletedStmt.run(claim.claimedAtMs, record.checkpointId);
      if (completed.changes !== 1) return ok({ kind: "not_resumable" });
      // A constraint failure here throws at the SQLite boundary and rolls the
      // transaction back, including the source completion.
      insertCheckpointStmt.run(...checkpointArgs(replacementResult.value, claim.claimedAtMs));
      return ok({ kind: "claimed", record: replacementResult.value });
    },
  );

  const revokeTransaction = db.transaction((rootRunId: string, t: number): void => {
    tombstoneRootStmt.run(rootRunId, t);
    invalidateForRevokeStmt.run(t, rootRunId);
  });

  const store: DurableRunPort = {
    upsertCheckpoint(record): Promise<Result<void, Error>> {
      try {
        const parsedRecord = parseDurableRunRecord(record);
        if (!parsedRecord.ok) {
          return Promise.resolve(
            err(new Error(`durable checkpoint validation failed: ${parsedRecord.error.message}`)),
          );
        }
        const checkpoint = parsedRecord.value;
        return Promise.resolve(upsertTransaction.immediate(checkpoint, nowMs()));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    listResumable(): Promise<Result<DurableRunResumeScan, Error>> {
      try {
        const rawRows = listResumableStmt.all();
        const records: DurableRunRecord[] = [];
        const invalid: InvalidDurableRunCheckpoint[] = [];
        for (const rawRow of rawRows) {
          const identity = durableRunIdentitySchema.safeParse(rawRow);
          if (!identity.success) {
            return Promise.resolve(
              err(new Error("A resumable durable row has no stable checkpoint identity")),
            );
          }
          const parsedRow = durableRunMapper.parseOptionalRow(rawRow);
          if (!parsedRow.ok || parsedRow.value === undefined) {
            invalid.push({
              checkpointId: identity.data.checkpoint_id,
              rootRunId: identity.data.root_run_id,
              reason: "record_validation_failed",
            });
            continue;
          }
          const row = parsedRow.value;
          const record = rowToRecord(row);
          if (!record.ok) {
            invalid.push({
              checkpointId: identity.data.checkpoint_id,
              rootRunId: identity.data.root_run_id,
              reason: "record_validation_failed",
            });
            continue;
          }
          records.push(record.value);
        }
        return Promise.resolve(ok({ records, invalid }));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    getByCheckpoint(checkpointId): Promise<Result<DurableRunRecord | undefined, Error>> {
      try {
        const row = durableRunMapper.parseOptionalRow(getStmt.get(checkpointId));
        if (!row.ok) return Promise.resolve(err(new Error(`Row validation failed: ${row.error.message}`)));
        if (row.value === undefined) return Promise.resolve(ok(undefined));
        const record = rowToRecord(row.value);
        return Promise.resolve(record.ok ? ok(record.value) : err(record.error));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    claimForResume(claim): Promise<Result<DurableRunResumeClaimOutcome, Error>> {
      try {
        const parsedClaim = resumeClaimSchema.safeParse(claim);
        if (!parsedClaim.success) {
          return Promise.resolve(
            err(new Error(`durable resume claim validation failed: ${parsedClaim.error.message}`)),
          );
        }
        return Promise.resolve(claimTransaction.immediate(parsedClaim.data));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    markOrphaned(checkpointId, reason): Promise<Result<void, Error>> {
      try {
        markOrphanedStmt.run(reason, nowMs(), checkpointId);
        return Promise.resolve(ok(undefined));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    markCompleted(checkpointId): Promise<Result<void, Error>> {
      try {
        markCompletedStmt.run(nowMs(), checkpointId);
        return Promise.resolve(ok(undefined));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    touchHeartbeat(checkpointId, atMs): Promise<Result<void, Error>> {
      try {
        const touched = touchHeartbeatStmt.run(atMs, nowMs(), checkpointId);
        if (touched.changes !== 1) {
          return Promise.resolve(err(new Error(`durable checkpoint ${checkpointId} is not running`)));
        }
        return Promise.resolve(ok(undefined));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    invalidateForRevoke(rootRunId): Promise<Result<void, Error>> {
      try {
        revokeTransaction.immediate(rootRunId, nowMs());
        return Promise.resolve(ok(undefined));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },

    countByStatus(sinceMs): Promise<
      Result<{ orphaned: number; revoked: number; running: number; completed: number }, Error>
    > {
      try {
        const rows = statusCountMapper.parseRows(countByStatusStmt.all(sinceMs));
        if (!rows.ok) return Promise.resolve(err(new Error(`Row validation failed: ${rows.error.message}`)));
        const counts = { orphaned: 0, revoked: 0, running: 0, completed: 0 };
        for (const row of rows.value) {
          if (row.status === "orphaned") counts.orphaned = row.c;
          else if (row.status === "revoked") counts.revoked = row.c;
          else if (row.status === "running") counts.running = row.c;
          else if (row.status === "completed") counts.completed = row.c;
        }
        return Promise.resolve(ok(counts));
      } catch (cause) {
        return Promise.resolve(err(cause instanceof Error ? cause : new Error(String(cause))));
      }
    },
  };

  return Object.freeze(store);
}

function trustRank(trustLevel: "guest" | "user" | "admin"): number {
  switch (trustLevel) {
    case "guest": return 0;
    case "user": return 1;
    case "admin": return 2;
    default: {
      const _exhaustive: never = trustLevel;
      return _exhaustive;
    }
  }
}

function sameDeliveryOrigin(
  first: DurableRunRecord["deliveryOrigin"],
  second: DurableRunRecord["deliveryOrigin"],
): boolean {
  if (first === null || second === null) return first === second;
  return first.channelType === second.channelType
    && first.channelId === second.channelId
    && first.userId === second.userId
    && first.tenantId === second.tenantId
    && first.threadId === second.threadId;
}
