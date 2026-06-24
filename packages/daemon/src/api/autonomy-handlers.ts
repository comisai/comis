// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Autonomy RPC handler module (Phase 213-06, REVOKE-01/03) — the operator-facing
 * live-control surface of the bounded-autonomy control plane:
 *
 *   - `lease.revoke {leaseId|rootRunId}` — COOPERATIVE stop. Revoke a single
 *     capability lease by `leaseId`, OR every lease of a spawn tree by
 *     `rootRunId` (cascading each to its descendants). The LeaseManager then
 *     denies the next RPC the bearer makes (REVOKE-01 "external to + non-bypassable
 *     by the agent"). Returns the content-free revoked COUNT.
 *   - `run.kill {rootRunId}` — HARD stop. Kill every run of the spawn tree
 *     (`subAgentRunner.killByRootRun` aborts each SDK session) AND revoke every
 *     lease of the tree (`leaseManager.revokeByRootRun`) so a survivor child can
 *     never keep operating (REVOKE-03). Returns the content-free killed COUNT.
 *
 * DENY-BY-ORIGIN IS AUTOMATIC — there is NO manual agent-origin check here (it
 * would drift, and the single-chokepoint arch gate forbids per-handler scatter).
 * Both methods are `scopes:["admin"]` (Plan 03) → they land in the DERIVED
 * `ADMIN_METHODS` → the dispatch chokepoint's origin guard (rpc-dispatch.ts)
 * denies any agent-origin call BEFORE the handler runs. The autonomy-handlers
 * test proves the deny on the dispatch path.
 *
 * Per-method pipeline mirrors `subagent-handlers.ts`: bespoke pre-Zod guard
 * FIRST (rawParams reads → user-friendly error) → stripInternalFields →
 * request.parse → business logic → dev-mode response.parse. Content-free §2.7
 * logging (count + method only — NEVER the bearer or param bodies).
 *
 * @module
 */

import {
  LeaseRevokeContract,
  RunKillContract,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";
import type { LeaseManager } from "@comis/infra";
import type { ComisLogger } from "@comis/infra";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper (mirrors subagent-handlers.ts)
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is the
 * in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * The narrow deps the autonomy handlers read. `ApiDispatchDeps` (the dispatcher's
 * superset) is assignable to this by structural subtyping — `leaseManager` is
 * threaded onto `OrchestratorApiDeps`, `subAgentRunner` already lives there, and
 * `logger` is required on every slice.
 */
export interface AutonomyHandlerDeps {
  /** The credential-broker lease authority — the revoke fan-outs (Plan 02). */
  leaseManager: LeaseManager;
  /** The sub-agent runner — `killByRootRun` aborts a whole spawn tree (Plan 01). */
  subAgentRunner: { killByRootRun(rootRunId: string): { killed: number } };
  /** Structured logger for the content-free §2.7 instrumentation. */
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the autonomy RPC handlers bound to the given deps. Spread into the
 * dispatcher alongside `...createSubagentHandlers(deps)`.
 */
export function createAutonomyHandlers(deps: AutonomyHandlerDeps): Record<string, RpcHandler> {
  return {
    [LeaseRevokeContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guard FIRST (one-of required; user-friendly message).
      const leaseId = rawParams.leaseId as string | undefined;
      const rootRunId = rawParams.rootRunId as string | undefined;
      if (!leaseId && !rootRunId) {
        throw new Error("Missing required parameter: leaseId or rootRunId");
      }

      const userParams = stripInternalFields(rawParams);
      LeaseRevokeContract.request.parse(userParams);

      let revoked = 0;
      if (rootRunId) {
        // Revoke every lease of the spawn tree (cascading each — Plan 02).
        revoked = deps.leaseManager.revokeByRootRun(rootRunId).revoked;
      } else if (leaseId) {
        // Single-lease cooperative stop — report the HONEST count: 1 if the lease
        // existed (now revoked), 0 for an unknown id (never a phantom revoke:1 —
        // the live VPS finding where a nonexistent leaseId reported revoked:1
        // while the rootRunId path honestly reported 0).
        revoked = deps.leaseManager.revoke(leaseId).revoked;
      }

      // §2.7: content-free completion line — the COUNT + method only, never the
      // bearer or the selector bodies.
      deps.logger.info(
        { method: LeaseRevokeContract.method, revoked, by: rootRunId ? "rootRunId" : "leaseId" },
        "Capability lease(s) revoked",
      );

      const result = { revoked };
      if (IS_DEV) LeaseRevokeContract.response.parse(result);
      return result;
    },

    [RunKillContract.method]: async (rawParams) => {
      // Bespoke pre-Zod guard FIRST.
      const rootRunId = rawParams.rootRunId as string | undefined;
      if (!rootRunId) {
        throw new Error("Missing required parameter: rootRunId");
      }

      const userParams = stripInternalFields(rawParams);
      RunKillContract.request.parse(userParams);

      // HARD stop: kill every run of the tree (abort the SDK sessions) AND revoke
      // every lease of the tree so a survivor child cannot keep operating.
      const { killed } = deps.subAgentRunner.killByRootRun(rootRunId);
      deps.leaseManager.revokeByRootRun(rootRunId);

      // §2.7: content-free completion line — the killed COUNT + method only.
      deps.logger.info(
        { method: RunKillContract.method, killed },
        "Spawn tree killed (hard stop) and its leases revoked",
      );

      const result = { killed };
      if (IS_DEV) RunKillContract.response.parse(result);
      return result;
    },
  };
}
