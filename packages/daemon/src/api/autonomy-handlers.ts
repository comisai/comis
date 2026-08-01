// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Autonomy RPC handler module — the operator-facing
 * live-control surface of the bounded-autonomy control plane:
 *
 *   - `lease.revoke {leaseId|rootRunId}` — COOPERATIVE stop. Revoke a single
 *     capability lease by `leaseId`, OR every lease of a spawn tree by
 *     `rootRunId` (cascading each to its descendants). The LeaseManager then
 *     denies the next RPC the bearer makes — the revoke is external to, and
 *     non-bypassable by, the agent. Returns the content-free revoked COUNT.
 *   - `run.kill {rootRunId}` — HARD stop. Kill every run of the spawn tree
 *     (`subAgentRunner.killByRootRun` aborts each SDK session) AND revoke every
 *     lease of the tree (`leaseManager.revokeByRootRun`) so a survivor child can
 *     never keep operating. Returns the content-free killed COUNT.
 *   - `autonomy.evict {rootRunId}` — DEMOTE. Marks the
 *     `rootRunId` in the daemon-wide evicted-set (`evictRegistry.mark`); the
 *     bounded-autonomy chokepoint consults it at the NEXT gate decision
 *     (mid-run) to resolve the run's effective profile to `default`. UNLIKE
 *     revoke/kill, evict does NOT abort — the run CONTINUES under `default` (which
 *     still escalates outward, never auto-sends). Returns the content-free
 *     `{ evicted }` boolean. Registered ONLY when the OPTIONAL `evictRegistry`
 *     dep is wired (the composition root supplies it).
 *
 * DENY-BY-ORIGIN IS AUTOMATIC — there is NO manual agent-origin check here (it
 * would drift, and the single-chokepoint arch gate forbids per-handler scatter).
 * All three methods are `scopes:["admin"]` → they land in the
 * DERIVED `ADMIN_METHODS` → the dispatch chokepoint's origin guard
 * (rpc-dispatch.ts) denies any agent-origin call BEFORE the handler runs (an agent
 * cannot self-un-evict). The autonomy-handlers test proves the deny on
 * the dispatch path.
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
  AutonomyEvictContract,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";

import type { EvictRegistry } from "../autonomy/evict-registry.js";
import {
  invalidateSpawnTreeState,
  killSpawnTree,
  type SpawnTreeControlDeps,
} from "./shared/spawn-tree-control.js";
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
export interface AutonomyHandlerDeps extends SpawnTreeControlDeps {
  /**
   * The daemon-wide evicted-`rootRunId` set. OPTIONAL —
   * the composition root constructs `createEvictRegistry` and threads it
   * onto `deps`. CRITICAL: it MUST stay OPTIONAL so a partially-wired
   * build compiles with a call site that does not supply it; the `autonomy.evict`
   * handler is registered ONLY when this is present (mirrors how `leaseManager`/
   * `boundedAutonomy` gate whole handler families). **Absent ⇒ the autonomy.evict
   * method is simply not registered** (a stray call hits the dispatcher's
   * unknown-method path) — no build break, no half-wired handler.
   */
  evictRegistry?: EvictRegistry;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the autonomy RPC handlers bound to the given deps. Spread into the
 * dispatcher alongside `...createSubagentHandlers(deps)`.
 */
export function createAutonomyHandlers(deps: AutonomyHandlerDeps): Record<string, RpcHandler> {
  // Capture the OPTIONAL evictRegistry once so the conditional spread
  // narrows it to non-undefined inside the evict handler closure (no `!`
  // non-null assertion needed). Absent ⇒ the autonomy.evict key is omitted from
  // the returned record entirely.
  const evictRegistry = deps.evictRegistry;

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
      let rootGenerationRetired = false;
      if (rootRunId) {
        // Revoke every lease of the spawn tree (cascading each to its descendants).
        revoked = deps.leaseManager.revokeByRootRun(rootRunId).revoked;
        // ALSO poison the persisted checkpoint so a restart cannot
        // resurrect the pre-revoke caps (the resurrection-window close).
        rootGenerationRetired = await invalidateSpawnTreeState(
          deps,
          rootRunId,
          LeaseRevokeContract.method,
        );
      } else if (leaseId) {
        // Single-lease cooperative stop — report the HONEST count: 1 if the lease
        // existed (now revoked), 0 for an unknown id (never a phantom revoke:1 —
        // both selector paths must agree that a nonexistent id revokes nothing,
        // matching the rootRunId path's honest 0).
        revoked = deps.leaseManager.revoke(leaseId).revoked;
      }

      // §2.7: content-free completion line — the COUNT + method only, never the
      // bearer or the selector bodies.
      deps.logger.info(
        {
          method: LeaseRevokeContract.method,
          revoked,
          by: rootRunId ? "rootRunId" : "leaseId",
          rootGenerationRetired,
        },
        "Capability lease(s) revoked",
      );

      // A typed content-free event BESIDE the INFO line — only on a
      // rootRunId revoke (a by-leaseId revoke has no rootRunId). Carries the COUNT
      // + the id + timestamp ONLY. Absent eventBus ⇒ no emit.
      if (rootRunId) {
        deps.eventBus?.emit("autonomy:revoked", {
          rootRunId,
          revoked,
          timestamp: deps.now?.() ?? 0,
        });
      }

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

      const result = await killSpawnTree(deps, rootRunId);
      if (IS_DEV) RunKillContract.response.parse(result);
      return result;
    },

    // Gate the autonomy.evict handler on the OPTIONAL evictRegistry
    // (mirrors the dispatch-wiring convention of gating whole handler families on
    // leaseManager/boundedAutonomy). Absent ⇒ the method key is omitted;
    // present ⇒ the closure reads the narrowed non-undefined
    // registry. The contract↔handler parity gate accepts this conditional
    // registration (the capabilities.introspect precedent, rpc-dispatch.ts).
    ...(evictRegistry
      ? {
          [AutonomyEvictContract.method]: async (rawParams: Record<string, unknown>) => {
            // Bespoke pre-Zod guard FIRST (user-friendly message).
            const rootRunId = rawParams.rootRunId as string | undefined;
            if (!rootRunId) {
              throw new Error("Missing required parameter: rootRunId");
            }

            const userParams = stripInternalFields(rawParams);
            AutonomyEvictContract.request.parse(userParams);

            // DEMOTE (NOT kill): mark the rootRunId so the chokepoint resolves the
            // run's mode to `default` from the NEXT gate decision. The
            // run KEEPS GOING under default — evict does not abort. `newlyEvicted`
            // reports whether THIS call changed state (the run is demoted either
            // way, so the response is { evicted: true } regardless).
            const { newlyEvicted } = evictRegistry.mark(rootRunId);

            // §2.7: content-free completion line — method + the newly/already enum
            // only, NEVER the selector body (rootRunId is an id, not a payload).
            deps.logger.info(
              { method: AutonomyEvictContract.method, newlyEvicted },
              "Run demoted to default (evict-from-mode)",
            );

            const result = { evicted: true };
            if (IS_DEV) AutonomyEvictContract.response.parse(result);
            return result;
          },
        }
      : {}),
  };
}
