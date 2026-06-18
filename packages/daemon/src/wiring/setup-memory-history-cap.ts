// SPDX-License-Identifier: Apache-2.0
/**
 * REVISE-02 (Phase 203 Plan 05): resolve the bounded asOf-history cap the
 * user-representation `revise()` trim enforces, for the SINGLE cross-agent
 * `createSqliteUserRepresentationStore` instance (a per-agent store would be an
 * architectural change). Like the daemon-global summarizer-breaker default in
 * `setup-memory.ts`, ONE value is resolved: the MAX configured `historyCap`
 * across the agents that ENABLE the user-representation cron. Absent ⇒ undefined
 * ⇒ the store's own `DEFAULT_HISTORY_CAP` (10). This makes the per-agent
 * `agents.<id>.memoryUserRepresentation.historyCap` knob REACHABLE when set.
 *
 * Extracted from `setup-memory.ts` to keep that composition-root leaf under the
 * 800-line cap (the sibling-helper discipline; mirrors `setup-memory-cost-notice.ts`).
 *
 * @module
 */

/** The slice of agent config this resolver reads (structural — no schema import). */
interface AgentsWithUserRepConfig {
  readonly [agentId: string]:
    | { readonly memoryUserRepresentation?: { readonly enabled?: boolean; readonly historyCap?: number } }
    | undefined;
}

/**
 * Resolve the store-wide `historyCap` constructor option from the per-agent
 * config: the MAX `historyCap` among agents with the cron enabled, or `undefined`
 * when none configure it (the store then keeps its own default).
 */
export function resolveUserRepresentationHistoryCap(
  agents: AgentsWithUserRepConfig | undefined,
): number | undefined {
  const caps = Object.values(agents ?? {})
    .filter((agent) => agent?.memoryUserRepresentation?.enabled)
    .map((agent) => agent?.memoryUserRepresentation?.historyCap)
    .filter((cap): cap is number => typeof cap === "number");
  return caps.length > 0 ? Math.max(...caps) : undefined;
}

/**
 * Spread-ready form for the store constructor: `{ historyCap }` when resolved, or
 * `{}` so the store falls back to its own default (keeps the call site one line +
 * the exactOptionalPropertyTypes contract — never an explicit `historyCap: undefined`).
 */
export function resolveUserRepresentationHistoryCapOption(
  agents: AgentsWithUserRepConfig | undefined,
): { historyCap?: number } {
  const cap = resolveUserRepresentationHistoryCap(agents);
  return cap !== undefined ? { historyCap: cap } : {};
}
