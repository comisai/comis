// SPDX-License-Identifier: Apache-2.0
// PRE-PATCH (RED). Deliberately incomplete: the read drops the (tenant, agent)
// filter (Tests 3/4 leak cross-scope) and returns a zero-vector on absent (Test 2
// expects undefined). Task 2 GREEN replaces this with the scoped, undefined-on-
// absent implementation.

import type Database from "better-sqlite3";
import type { TunedAlphaStore, TunedAlphaScope, TunedAlphaVector } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";

interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface MemoryTunedAlphaStoreDeps {
  db: Database.Database;
  logger?: MemoryLogger;
}

export function createSqliteTunedAlphaStore(
  deps: MemoryTunedAlphaStoreDeps,
): TunedAlphaStore {
  const { db, logger } = deps;

  const insertVec = db.prepare(
    "INSERT INTO tuned_alpha " +
      "(tenant_id, agent_id, recency_alpha, temporal_alpha, proof_alpha, usefulness_alpha, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(tenant_id, agent_id) DO UPDATE SET " +
      "recency_alpha=excluded.recency_alpha, temporal_alpha=excluded.temporal_alpha, " +
      "proof_alpha=excluded.proof_alpha, usefulness_alpha=excluded.usefulness_alpha, " +
      "updated_at=excluded.updated_at",
  );
  // PRE-PATCH BUG: no scope filter (leaks across tenant/agent).
  const readAny = db.prepare(
    "SELECT recency_alpha, temporal_alpha, proof_alpha, usefulness_alpha, updated_at FROM tuned_alpha",
  );

  return {
    async upsert(
      vector: TunedAlphaVector,
      scope: TunedAlphaScope,
    ): Promise<Result<void, Error>> {
      const { tenantId, agentId, now } = scope;
      try {
        insertVec.run(
          tenantId,
          agentId,
          vector.recencyAlpha,
          vector.temporalAlpha,
          vector.proofAlpha,
          vector.usefulnessAlpha,
          now,
        );
        logger?.debug(
          { step: "tuned-alpha-upsert", tenantId, agentId },
          "Tuned alpha upsert complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          { step: "tuned-alpha-upsert", err: error, errorKind: "internal" as const },
          "Tuned alpha upsert failed",
        );
        return err(error);
      }
    },

    async read(): Promise<Result<TunedAlphaVector | undefined, Error>> {
      try {
        const row = readAny.get() as
          | {
              recency_alpha: number;
              temporal_alpha: number;
              proof_alpha: number;
              usefulness_alpha: number;
              updated_at: number;
            }
          | undefined;
        // PRE-PATCH BUG: a zero-vector on absent (Test 2 expects undefined).
        if (row === undefined) {
          return ok({ recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, usefulnessAlpha: 0 });
        }
        return ok({
          recencyAlpha: row.recency_alpha,
          temporalAlpha: row.temporal_alpha,
          proofAlpha: row.proof_alpha,
          usefulnessAlpha: row.usefulness_alpha,
        });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        return err(error);
      }
    },
  };
}
