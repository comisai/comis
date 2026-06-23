// SPDX-License-Identifier: Apache-2.0
/**
 * Capabilities-domain RPC contract (Phase 215-02, INTRO-01/INTRO-02).
 *
 * `capabilities.introspect` is the read-only, agent-reachable RPC behind the
 * `comis whoami` surface: an agent (or operator) asks "what can I do + how much
 * budget/quota is left". It returns the run's resolved orchestration capabilities
 * plus the remaining per-root budget + outward-quota headroom (the numbers the
 * Plan-02 `BoundedAutonomy.snapshot` / `PerRootBudget.remaining` /
 * `OutwardQuota.remaining` accessors expose).
 *
 * **Scope (INTRO-02).** `scopes:["rpc"]` — agent-reachable, NOT admin, NOT
 * cap-gated (disjoint from `AgentCapability`, the arch-tested split in 210). It
 * is the read-only "ungated" class: the handler (Plan 04) enforces `_agentId`
 * self-scope (an agent gets ITS OWN caps/budget, never cross-agent) but calls NO
 * `requireCapability` — a read of one's own posture needs no cap.
 *
 * **Self-scoping (V4).** The request is `{}`. The caller agent is identified by
 * the dispatcher-injected `_agentId` internal field (stripped before the parse,
 * read by the handler) — NOT an arbitrary `agentId` request param, so a caller
 * cannot introspect another agent.
 *
 * **Allowlist compliance.** Schemas use the 12-shape allowlist only (z.object,
 * z.string, z.number, z.array, z.nullable, z.optional). No refinements.
 *
 * **Deferred to Plan 04.** The matching daemon handler + `pnpm contracts:generate`
 * regen + the bidirectional contract↔handler parity land together in Plan 04
 * (the same-wave contract+handler rule, 188 BLOCKER-1). This file declares the
 * contract only.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// capabilities.introspect (rpc — read-only, agent-reachable, no cap)
// ---------------------------------------------------------------------------

/**
 * `capabilities.introspect` — the run's resolved caps + remaining budgets/quotas
 * (the `whoami` read). Handler path: deferred to Plan 04 (capabilities-handlers).
 *
 * Request: `{}` (self-scoped via the dispatcher-injected `_agentId` — NOT
 * declared here).
 *
 * Response: `{ agentId, caps, budget?, outwardQuota? }`.
 *   - `agentId`      — the resolved caller agent the read acted on (echoed for
 *     transparency / multi-agent targeting clarity).
 *   - `caps`         — the resolved `ResolvedAutonomy.capabilities` (or the
 *     lease's caps) the run holds, as `orch:*` strings (loose string array — the
 *     handler maps the closed `AgentCapability` enum to strings).
 *   - `budget`       — OPTIONAL: the per-root remaining budget. Absent when no
 *     `rootRunId` is live (in-process, pre-spawn). `usdRemaining` is nullable for
 *     the honest-degrade unpriceable case (BUDGET-02) — the token/wall-clock
 *     limbs are authoritative regardless.
 *   - `outwardQuota` — OPTIONAL: the remaining per-hour outward send allowance.
 */
export const CapabilitiesIntrospectContract = defineContract({
  method: "capabilities.introspect",
  request: z.object({}),
  response: z.object({
    agentId: z.string(),
    caps: z.array(z.string()),
    budget: z
      .object({
        tokensRemaining: z.number(),
        wallClockMsRemaining: z.number(),
        usdRemaining: z.number().nullable(),
      })
      .optional(),
    outwardQuota: z.object({ perHourRemaining: z.number() }).optional(),
  }),
  scopes: ["rpc"] as const,
});

// ===========================================================================
// Aggregator
// ===========================================================================

/** Tuple of every contract for the capabilities umbrella. */
export const CAPABILITIES_CONTRACTS = [CapabilitiesIntrospectContract] as const;
