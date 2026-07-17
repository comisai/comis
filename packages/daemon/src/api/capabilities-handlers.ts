// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Capabilities RPC handler module — the read-only, agent-reachable surface
 * behind `comis whoami`:
 *
 *   - `capabilities.introspect {}` — return the CALLER's resolved orchestration
 *     capabilities + the remaining per-root budget/quota for its live run. The
 *     read is SELF-SCOPED: it reports caps/budget for the caller's `_agentId`
 *     ONLY — never an arbitrary `agentId` request param (the session-read.ts:43
 *     self-scope precedent). The request is `{}`.
 *
 * NO `requireCapability`. The method is `scopes:["rpc"]`, classified
 * `"ungated"` in `HANDLER_CAPABILITY_MAP` — an agent reading its OWN posture
 * needs no capability. It is NOT in `ADMIN_METHODS`, so deny-by-origin does NOT
 * fire and the agent CAN reach it (correct). The per-cap audit does NOT
 * fire for it either (the audit's filter is real-`AgentCapability`-only, and
 * `"ungated"` is excluded).
 *
 * Self-scope mechanics: read `_agentId` AND `_capabilities` BEFORE
 * `stripInternalFields` (both are dispatcher-injected, unforgeable agent-origin
 * signals — inbound copies are stripped from external callers at the gateway;
 * forged ones are dropped before reaching here). Report the injected
 * `_capabilities` — the EXACT `heldCapabilities` set `createAgentRpcCall`
 * resolves once at setup-tools-capabilities.ts:51-53 and `requireCapability`
 * enforces this run — so the read can NEVER diverge from enforcement. An
 * empty `[]` is authoritative (a genuine zero-cap run), not a fallback trigger.
 * The operator/CLI origin (no in-process gate, no injected `_capabilities`) falls
 * back to re-resolving the caller's OWN `PerAgentConfig.autonomy` — with NO
 * cross-agent `defaultAgentId` fallback, so an unknown `_agentId` is never
 * reported with the default agent's caps under its own id. Budget/quota
 * come from `BoundedAutonomy.snapshot` ONLY when a live `rootRunId` resolves from
 * the caller session key; in-process pre-spawn (no live root) leaves both ABSENT
 * (optional, honest — never a fabricated zero snapshot, which would be a false
 * posture). Content-free §2.7 logging (the agentId + cap COUNT only — never the
 * caps themselves are needed beyond the response, never a body).
 *
 * @module
 */

import {
  CapabilitiesIntrospectContract,
  parseFormattedSessionKey,
  resolveAutonomy,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";
import type { PerAgentConfig, SessionKey } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

import type { BoundedAutonomy } from "../autonomy/bounded-autonomy.js";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper (mirrors autonomy-handlers.ts)
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * The daemon side is the trust boundary; in production the trust check is the
 * in-handler self-scope logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * The narrow deps the capabilities handler reads. `ApiDispatchDeps` (the
 * dispatcher's superset) is assignable to this by structural subtyping —
 * `boundedAutonomy` rides ChannelsApiDeps (gated at the wiring site),
 * `agents`/`defaultAgentId`/`resolveRootRunId` ride SessionsApiDeps, and
 * `logger` is required on every slice.
 */
export interface CapabilitiesHandlerDeps {
  /**
   * The bounded-autonomy composite — `snapshot` is the pure remaining-budget read.
   * OPTIONAL: when NO agent resolves to an autonomy-bearing profile
   * (e.g. all `autonomy.profile: assistant`), bounded-autonomy is not wired — but the handler is
   * STILL registered (never "Unknown RPC method") and returns the disabled-state ({enabled:false,
   * caps:[]}); the budget snapshot is simply omitted (no live root to report).
   */
  boundedAutonomy?: BoundedAutonomy;
  /** The per-agent config map — the caller's `autonomy` (an `AutonomyConfig`) is the caps source. */
  agents: Record<string, PerAgentConfig>;
  /** The default agent the self-scope falls back to (operator/CLI origin, or an unknown agent). */
  defaultAgentId: string;
  /** Tree-stable synthetic-root resolver. Absent ⇒ no live root ⇒ budget omitted. */
  resolveRootRunId?: (agentId: string, sessionKey: SessionKey) => string;
  /** Structured logger for the content-free §2.7 instrumentation. */
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the capabilities RPC handler bound to the given deps. Spread into the
 * dispatcher gated on `deps.boundedAutonomy` being wired.
 */
export function createCapabilitiesHandlers(
  deps: CapabilitiesHandlerDeps,
): Record<string, RpcHandler> {
  return {
    [CapabilitiesIntrospectContract.method]: async (rawParams) => {
      // Self-scope: read the dispatcher-injected `_agentId` BEFORE strip (the
      // unforgeable agent-origin signal). Fall back to the default agent for an
      // operator/CLI origin (no `_agentId`). NEVER an arbitrary `agentId` param.
      const agentId = (rawParams._agentId as string | undefined) ?? deps.defaultAgentId;
      // The caller session key the in-process leg injects (`_callerSessionKey`,
      // setup-tools-capabilities.ts:75) — read BEFORE strip; used to resolve the
      // live synthetic root for the budget snapshot.
      const callerSessionKey =
        typeof rawParams._callerSessionKey === "string" ? rawParams._callerSessionKey : undefined;

      // The AUTHORITATIVE held-cap set the in-process gate injected alongside
      // `_agentId` (`_capabilities` = `createAgentRpcCall`'s `heldCapabilities`,
      // the EXACT bare-string set `requireCapability` enforces this run) — read
      // BEFORE strip, like `_agentId`. Reporting THIS guarantees introspect can
      // never diverge from enforcement. An empty `[]` is authoritative (a genuine
      // zero-cap run), NOT a fallback trigger — only a wholly-absent key falls back.
      const injectedCaps = Array.isArray(rawParams._capabilities)
        ? (rawParams._capabilities as unknown[]).filter((c): c is string => typeof c === "string")
        : undefined;

      const userParams = stripInternalFields(rawParams);
      CapabilitiesIntrospectContract.request.parse(userParams);

      // Report the injected enforced caps when present; otherwise (an
      // operator/CLI origin with no in-process gate) re-resolve the caller's OWN
      // per-agent `AutonomyConfig` — NO cross-agent `defaultAgentId` fallback, so
      // the echoed `agentId` and the reported caps always describe the SAME scope
      // (an unknown `_agentId` never borrows the default agent's caps — the
      // chimeric-posture class). `agentId` already resolves to `defaultAgentId`
      // for a no-`_agentId` operator origin (line above), so that path is intact.
      const resolvedAutonomy = resolveAutonomy(deps.agents[agentId]?.autonomy);
      const caps = injectedCaps ?? [...resolvedAutonomy.capabilities];
      // Report the caller's resolved autonomy.enabled so a disabled/assistant-profile
      // agent gets a clean {enabled:false, caps:[]} instead of an "Unknown RPC method" error.
      const enabled = resolvedAutonomy.enabled;

      // Budget/outwardQuota ONLY when a live rootRunId resolves (in-flight run) AND bounded-autonomy
      // is wired (it may be absent when no autonomy agent exists). In-process pre-spawn
      // (no caller key) or no-autonomy ⇒ both ABSENT — honest, never a fabricated zero snapshot.
      let budget: ReturnType<BoundedAutonomy["snapshot"]>["budget"] | undefined;
      let outwardQuota: ReturnType<BoundedAutonomy["snapshot"]>["outwardQuota"] | undefined;
      const parsedKey = callerSessionKey ? parseFormattedSessionKey(callerSessionKey) : undefined;
      const rootRunId = parsedKey ? deps.resolveRootRunId?.(agentId, parsedKey) : undefined;
      if (rootRunId && deps.boundedAutonomy) {
        const snap = deps.boundedAutonomy.snapshot(rootRunId, agentId, "");
        budget = snap.budget;
        outwardQuota = snap.outwardQuota;
      }

      // §2.7: content-free completion line — the agentId + cap COUNT + whether a
      // live budget was attached. Never the caps list bodies or any param body.
      deps.logger.info(
        {
          method: CapabilitiesIntrospectContract.method,
          agentId,
          enabled,
          capCount: caps.length,
          budgetLive: budget !== undefined,
        },
        "Capabilities introspected",
      );

      const result = {
        agentId,
        enabled,
        caps,
        ...(budget ? { budget } : {}),
        ...(outwardQuota ? { outwardQuota } : {}),
      };
      if (IS_DEV) CapabilitiesIntrospectContract.response.parse(result);
      return result;
    },
  };
}
