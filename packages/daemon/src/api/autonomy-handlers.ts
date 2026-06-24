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
 *   - `autonomy.evict {rootRunId}` — DEMOTE (Phase 217-04, EVICT-01). Marks the
 *     `rootRunId` in the daemon-wide evicted-set (`evictRegistry.mark`); the
 *     bounded-autonomy chokepoint consults it at the NEXT gate decision (EVICT-03,
 *     mid-run) to resolve the run's effective profile to `default`. UNLIKE
 *     revoke/kill, evict does NOT abort — the run CONTINUES under `default` (which
 *     still escalates outward, never auto-sends). Returns the content-free
 *     `{ evicted }` boolean. Registered ONLY when the OPTIONAL `evictRegistry`
 *     dep is wired (HIGH-1 — the Wave-2 composition root supplies it).
 *
 * DENY-BY-ORIGIN IS AUTOMATIC — there is NO manual agent-origin check here (it
 * would drift, and the single-chokepoint arch gate forbids per-handler scatter).
 * All three methods are `scopes:["admin"]` (Plan 03 / Plan 04) → they land in the
 * DERIVED `ADMIN_METHODS` → the dispatch chokepoint's origin guard
 * (rpc-dispatch.ts) denies any agent-origin call BEFORE the handler runs (an agent
 * cannot self-un-evict — T-217-12). The autonomy-handlers test proves the deny on
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
import type { DurableRunPort } from "@comis/core";
import type { LeaseManager } from "@comis/infra";
import type { ComisLogger } from "@comis/infra";

import type { EvictRegistry } from "../autonomy/evict-registry.js";
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
  /**
   * Phase 216 (DUR-03): the durable-run store. OPTIONAL — when a `rootRunId` is
   * revoked (lease.revoke by rootRunId, OR run.kill), the handler ALSO calls
   * `invalidateForRevoke(rootRunId)` so the persisted checkpoint flips to status
   * `revoked` and a subsequent boot can NEVER re-mint the pre-revoke caps (the
   * resurrection-window close, invariant #6/#13). **Absent ⇒ inert** (the lease
   * revoke alone still stops the live bearer; the persisted record is just not
   * poisoned — only matters once durability is enabled, which is when the daemon
   * wires this). Best-effort: an invalidate error is WARN-logged, never fails the
   * revoke RPC (the lease is already revoked — the cooperative/hard stop holds).
   */
  durableRuns?: DurableRunPort;
  /**
   * Phase 217-04 (EVICT-01): the daemon-wide evicted-`rootRunId` set. OPTIONAL —
   * the sole call site (rpc-dispatch.ts, `createAutonomyHandlers({ ...deps,
   * leaseManager: deps.leaseManager })`) does NOT supply it until the Wave-2
   * composition root (Plan 05) constructs `createEvictRegistry` and threads it
   * onto `deps`. CRITICAL (HIGH-1): it MUST stay OPTIONAL so the Wave-1 `pnpm
   * build` compiles with the unchanged call site; the `autonomy.evict` handler is
   * registered ONLY when this is present (mirrors how `leaseManager`/
   * `boundedAutonomy` gate whole handler families). **Absent ⇒ the autonomy.evict
   * method is simply not registered** (a stray call hits the dispatcher's
   * unknown-method path) — no build break, no half-wired handler.
   */
  evictRegistry?: EvictRegistry;
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
  /**
   * DUR-03: poison the persisted run record on revoke so a subsequent boot finds
   * status='revoked' and ORPHANS the run rather than re-minting the pre-revoke
   * caps. Best-effort — a write error is WARN-logged but never fails the revoke
   * RPC (the in-memory lease is already revoked, so the live bearer is dead
   * regardless; this only affects post-restart resumability). Inert when no
   * durable store is wired (durability off).
   */
  async function invalidatePersistedRecord(rootRunId: string, method: string): Promise<void> {
    if (!deps.durableRuns) return;
    const r = await deps.durableRuns.invalidateForRevoke(rootRunId);
    if (!r.ok) {
      deps.logger.warn(
        { method, err: r.error, hint: "could not flip the durable run record to 'revoked'; a restart could resume it — verify the run is dead", errorKind: "dependency" as const },
        "Durable record invalidate-on-revoke failed (lease still revoked)",
      );
    }
  }

  // HIGH-1: capture the OPTIONAL evictRegistry once so the conditional spread
  // narrows it to non-undefined inside the evict handler closure (no `!`
  // non-null assertion needed). Absent ⇒ the autonomy.evict key is omitted from
  // the returned record entirely (the Wave-1 partial-boot state).
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
      if (rootRunId) {
        // Revoke every lease of the spawn tree (cascading each — Plan 02).
        revoked = deps.leaseManager.revokeByRootRun(rootRunId).revoked;
        // DUR-03: ALSO poison the persisted checkpoint so a restart cannot
        // resurrect the pre-revoke caps (the resurrection-window close).
        await invalidatePersistedRecord(rootRunId, LeaseRevokeContract.method);
      } else if (leaseId) {
        // Single-lease cooperative stop. The LeaseManager.revoke is a void flag;
        // a successful call revokes exactly one lease.
        deps.leaseManager.revoke(leaseId);
        revoked = 1;
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
      // DUR-03: ALSO poison the persisted checkpoint so a restart cannot resume
      // the killed tree under re-minted pre-revoke caps (REVOKE-03 across restart).
      await invalidatePersistedRecord(rootRunId, RunKillContract.method);

      // §2.7: content-free completion line — the killed COUNT + method only.
      deps.logger.info(
        { method: RunKillContract.method, killed },
        "Spawn tree killed (hard stop) and its leases revoked",
      );

      const result = { killed };
      if (IS_DEV) RunKillContract.response.parse(result);
      return result;
    },

    // HIGH-1: gate the autonomy.evict handler on the OPTIONAL evictRegistry
    // (mirrors the dispatch-wiring convention of gating whole handler families on
    // leaseManager/boundedAutonomy). Absent ⇒ the method key is omitted (Wave-1
    // partial boot); present ⇒ the closure reads the narrowed non-undefined
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
            // run's mode to `default` from the NEXT gate decision (EVICT-03). The
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
