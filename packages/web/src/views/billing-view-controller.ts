// SPDX-License-Identifier: Apache-2.0
/**
 * Billing-view controller.
 *
 * Owns the `obs.billing.{total,byProvider,byAgent,bySession}` RPC fetches and
 * the wire→domain data shaping for the billing view. The view delegates each
 * drill-level load to this controller and keeps the resulting data on its own
 * load-bearing `@state` (so the existing shadow-DOM tests stay green); the
 * controller never touches the DOM.
 *
 * Split mold: `setup-wizard-controller.ts` / `skills-controller.ts` — a factory
 * that owns RPC orchestration + data shapes, leaving the view to render.
 *
 * @module
 */

import type { RpcClient } from "../api/rpc-client.js";
import type {
  BillingByProvider,
  BillingByAgent,
  BillingBySession,
  AgentInfo,
  ToolCostBreakdown,
  SubagentCostBreakdown,
} from "../api/types/index.js";

/** Billing total shape returned by obs.billing.total RPC. */
export interface BillingTotalData {
  totalCost: number;
  totalTokens: number;
  callCount: number;
}

/** Result of loading the "total" drill level. */
export interface TotalLevelData {
  total: BillingTotalData;
  /** Populated asynchronously after the primary total resolves. */
  previousTotal: BillingTotalData | null;
  providers: BillingByProvider[];
}

/**
 * The billing-view controller: a thin, DOM-free orchestrator over the
 * `obs.billing.*` admin RPCs. Each method returns the shaped data the view
 * stores on its own `@state`; the controller holds no Lit state itself.
 */
export interface BillingViewController {
  /**
   * Load the total level. Returns the primary total immediately; the optional
   * `onAsyncUpdate` callback fires once the background cumulative + provider
   * breakdown resolve (the view re-renders on it).
   */
  loadTotalLevel(
    sinceMs: number,
    onAsyncUpdate: (partial: { previousTotal?: BillingTotalData; providers?: BillingByProvider[] }) => void,
  ): Promise<BillingTotalData>;
  loadProviderLevel(sinceMs: number): Promise<BillingByProvider[]>;
  loadAgentLevel(sinceMs: number): Promise<BillingByAgent[]>;
  loadSessionLevel(sinceMs: number, agentId: string | undefined): Promise<BillingBySession[]>;
}

/* ------------------------------------------------------------------ */
/*  Wire-shape narrowing helpers (loose obs.billing.* responses)       */
/* ------------------------------------------------------------------ */

function toBillingTotal(raw: Record<string, unknown>): BillingTotalData {
  return {
    totalCost: Number(raw.totalCost ?? 0),
    totalTokens: Number(raw.totalTokens ?? 0),
    callCount: Number(raw.callCount ?? 0),
  };
}

/** obs.billing.byProvider returns either a bare array or { providers: [...] }. */
function narrowProviders(raw: unknown): BillingByProvider[] {
  if (Array.isArray(raw)) return raw as BillingByProvider[];
  const wrapped = raw as Record<string, unknown>;
  return Array.isArray(wrapped.providers) ? (wrapped.providers as BillingByProvider[]) : [];
}

/** obs.billing.bySession returns either a bare array or { sessions: [...] }. */
function narrowSessions(raw: unknown): BillingBySession[] {
  if (Array.isArray(raw)) return raw as BillingBySession[];
  const wrapped = raw as Record<string, unknown>;
  return Array.isArray(wrapped.sessions) ? (wrapped.sessions as BillingBySession[]) : [];
}

/**
 * Narrow an optional per-tool cost breakdown (COST-01 `tool_tag`, best-effort)
 * off a billing response. Content-free: tool ids/numbers only, never bodies.
 */
export function narrowToolCosts(raw: unknown): ToolCostBreakdown[] {
  const wrapped = raw as Record<string, unknown> | undefined;
  const rows = wrapped?.tools;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r): ToolCostBreakdown | null => {
      const o = r as Record<string, unknown>;
      const tool = typeof o.tool === "string" ? o.tool : undefined;
      if (tool === undefined) return null;
      return {
        tool,
        cost: Number(o.cost ?? 0),
        tokens: Number(o.tokens ?? 0),
        calls: Number(o.calls ?? 0),
      };
    })
    .filter((r): r is ToolCostBreakdown => r !== null);
}

/**
 * Narrow an optional per-subagent cost rollup (COST-02 corrected-$ `nodeCost`
 * subtree rollup) off a billing response. Content-free: node ids + corrected
 * dollars only.
 */
export function narrowSubagentCosts(raw: unknown): SubagentCostBreakdown[] {
  const wrapped = raw as Record<string, unknown> | undefined;
  const rows = wrapped?.subagents;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r): SubagentCostBreakdown | null => {
      const o = r as Record<string, unknown>;
      const nodeId = typeof o.nodeId === "string" ? o.nodeId : undefined;
      if (nodeId === undefined) return null;
      return {
        nodeId,
        cost: Number(o.cost ?? 0),
        subtreeCost: Number(o.subtreeCost ?? o.cost ?? 0),
      };
    })
    .filter((r): r is SubagentCostBreakdown => r !== null);
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

/**
 * Create a billing-view controller bound to an RPC client.
 *
 * The view owns the lifecycle/refresh/SSE plumbing and its `@state`; this
 * factory only encapsulates the RPC orchestration + wire shaping so the view
 * stays under the file-size cap.
 */
export function createBillingViewController(rpcClient: RpcClient): BillingViewController {
  return {
    async loadTotalLevel(sinceMs, onAsyncUpdate): Promise<BillingTotalData> {
      // Primary data for the stat cards — awaited so the view can render.
      const raw = await rpcClient.call<Record<string, unknown>>("obs.billing.total", { sinceMs });
      const total = toBillingTotal(raw);

      // Cumulative (for deltas) + provider breakdown load in the background;
      // the view re-renders via onAsyncUpdate when they settle.
      void Promise.allSettled([
        rpcClient.call<Record<string, unknown>>("obs.billing.total", { sinceMs: sinceMs * 2 }),
        rpcClient.call<unknown>("obs.billing.byProvider", { sinceMs }),
      ]).then(([cumulativeResult, providersResult]) => {
        const partial: { previousTotal?: BillingTotalData; providers?: BillingByProvider[] } = {};
        if (cumulativeResult.status === "fulfilled") {
          const cumulative = toBillingTotal(cumulativeResult.value);
          partial.previousTotal = {
            totalCost: cumulative.totalCost - total.totalCost,
            totalTokens: cumulative.totalTokens - total.totalTokens,
            callCount: cumulative.callCount - total.callCount,
          };
        }
        if (providersResult.status === "fulfilled") {
          partial.providers = narrowProviders(providersResult.value);
        }
        if (partial.previousTotal !== undefined || partial.providers !== undefined) {
          onAsyncUpdate(partial);
        }
      });

      return total;
    },

    async loadProviderLevel(sinceMs): Promise<BillingByProvider[]> {
      const raw = await rpcClient.call<unknown>("obs.billing.byProvider", { sinceMs });
      return narrowProviders(raw);
    },

    async loadAgentLevel(sinceMs): Promise<BillingByAgent[]> {
      const listResult = await rpcClient.call<Record<string, unknown>>("agents.list");
      const agentData = Array.isArray(listResult)
        ? listResult
        : Array.isArray((listResult as Record<string, unknown>).agents)
          ? (listResult as { agents: AgentInfo[] | string[] }).agents
          : [];

      const agentIds = agentData.map((a: AgentInfo | string) => (typeof a === "string" ? a : a.id));

      if (agentIds.length === 0) return [];

      const results = await Promise.allSettled(
        agentIds.map((id) =>
          rpcClient.call<Record<string, unknown>>("obs.billing.byAgent", { agentId: id, sinceMs }),
        ),
      );

      return results
        .map((r, i): BillingByAgent | null => {
          if (r.status !== "fulfilled") return null;
          const raw = r.value;
          return {
            agentId: agentIds[i]!,
            totalTokens: Number(raw.tokensToday ?? raw.totalTokens ?? 0),
            percentOfTotal: Number(raw.percentOfTotal ?? 0),
            cost: Number(raw.costToday ?? raw.cost ?? 0),
          };
        })
        .filter((a): a is BillingByAgent => a !== null)
        .sort((a, b) => b.cost - a.cost);
    },

    async loadSessionLevel(sinceMs, agentId): Promise<BillingBySession[]> {
      if (!agentId) return [];
      try {
        const raw = await rpcClient.call<unknown>("obs.billing.bySession", {
          sessionKey: "all",
          agentId,
          sinceMs,
        });
        return narrowSessions(raw);
      } catch {
        return [];
      }
    },
  };
}
