// SPDX-License-Identifier: Apache-2.0
/**
 * The per-capability audit emitter at the gate chokepoints.
 *
 * For every capability-gated call (an ALLOWED *and* a DENIED one), this emits
 * the authorization decision at the SINGLE chokepoint as TWO bus events:
 *
 *   1. `audit:event` — the DURABLE trail. Rides the shipped
 *      `wireAuditSink` → `obs_audit_events` + `0600 security-audit.jsonl` +
 *      `.audit()` log, reconstructable offline (no gateway). The per-cap tuple
 *      rides the content-free `metadata` free-map (sanitized at the sink).
 *   2. `capability:audited` — the TREE record (folded by the spawn-tree's
 *      per-node producer). A typed, content-free event on the trajectory.
 *
 * One chokepoint emits BOTH (see `rpc-dispatch.ts` in-process +
 * `setup-capability-endpoint.ts` socket). This module is a PURE emitter — it
 * emits, never throws (no `@allow-throw`); the throwing gate is the caller's
 * `requireCapability` / `assertNotAgentOrigin`.
 *
 * CONTENT-FREE: the record carries ids + caps + tool
 * NAME + method + decision ONLY — NEVER the `tool.invoke` args, a message body,
 * a file path, or a secret name. There is deliberately no args/body parameter.
 *
 * CLASSIFICATION: the durable `audit:event.classification` is a member of the
 * closed `AuditEventSchema` enum (`read | mutate | destructive`) or is OMITTED —
 * never an out-of-enum sentinel (the sink coerces any such value to null,
 * dropping the action class). A DENY is `destructive`; an ALLOW derives a
 * `read`/`mutate` from the capability via {@link classifyCapabilityAction} and
 * omits the field for an unrecognized cap (honest unknown, never a mislabel).
 *
 * Chokepoint asymmetry: the in-process path has NO lease, so `leaseId` /
 * `parentLeaseId` / `tool` are honestly ABSENT (omitted) and `rootRunId` is the
 * synthetic `root-session-<key>`. The socket path passes the full real tuple.
 * NEVER fabricate a `lease-<synthetic>` for the in-process record.
 *
 * @module
 */
import { emitObservationalEventSafely, systemNowMs } from "@comis/core";
import type { AgentCapability, ComisLogger, TypedEventBus } from "@comis/core";

/**
 * The minimal structural deps the emitter reads. `ApiDispatchDeps` /
 * `CapabilityEndpointDeps` (whose `container.eventBus` is the full
 * `TypedEventBus`) are assignable to this by structural subtyping, so callers
 * pass their own deps unchanged. `emit` is typed to the two channels this
 * module uses, which also strongly types both payloads at the emit sites.
 */
export interface EmitCapabilityAuditDeps {
  container: {
    eventBus: Pick<TypedEventBus, "emitSafely">;
    config: { tenantId?: string };
  };
  logger?: Pick<ComisLogger, "warn">;
}

/** The content-free per-cap audit fact (ids/caps/tool-NAME/method/decision ONLY). */
export interface CapabilityAuditRecord {
  /** The trusted agent-origin id (in-process: `_agentId`; socket: `lease.agentId`). */
  readonly agentId: string;
  /** The required {@link import("@comis/core").AgentCapability} the method/tool maps to. */
  readonly capability: string;
  /** The inner tool NAME (socket `tool.invoke`). Absent in-process / for direct methods. */
  readonly tool?: string;
  /** The dispatch method identifier (content-free — never a param value). */
  readonly method: string;
  /** ≈ the sessionKey/traceId of the call. Absent when neither is available. */
  readonly runId?: string;
  /**
   * The tree-stable root (the real lease's rootRunId, or the synthetic in-process
   * root). Optional: a gated decision with no resolvable root is still a
   * durable security fact and emits `audit:event`; only the `capability:audited`
   * TREE producer (which needs a placeable root) is suppressed when this is absent.
   */
  readonly rootRunId?: string;
  /** The real lease id (socket). ABSENT in-process — NEVER fabricated. */
  readonly leaseId?: string;
  /** The parent lease id (socket, when present) — the spawn-tree parent edge. */
  readonly parentLeaseId?: string;
  /** The authorization outcome — a closed string-literal union (AGENTS §2.8). */
  readonly decision: "allow" | "deny";
}

/**
 * The closed capability→action-class map for the durable audit trail's
 * `classification` (the `read|mutate|destructive` enum on `AuditEventSchema`).
 * Read-class caps (they observe) → `"read"`; mutate-class caps (they change
 * state or send outward) → `"mutate"`. Typed `Record<AgentCapability, ...>` so a
 * new `AGENT_CAPABILITIES` member is a COMPILE-VISIBLE gap here — never a silent
 * miss. There is no `"destructive"` entry: the allow path attributes read/mutate;
 * a DENY is the only `"destructive"` emitter (a denied call is the signal).
 */
export const CAPABILITY_ACTION_CLASS: Record<AgentCapability, "read" | "mutate"> = {
  "orch:read": "read",
  "orch:web": "read",
  "orch:analyze": "read",
  "orch:browse": "read",
  // MCP calls observe the connected server — a read-class action. (A deny is
  // always emitted as `destructive`, so this class is the ALLOW-path attribution.)
  "orch:mcp": "read",
  "orch:write": "mutate",
  "orch:message": "mutate",
  "orch:spawn": "mutate",
  "orch:graph": "mutate",
  "orch:cron": "mutate",
  "orch:skill": "mutate",
};

/**
 * Classify a capability into the audit `classification` enum — a PURE lookup (no
 * I/O, no throw; the `attenuateCaps` pure discipline). Returns the `read`/`mutate`
 * action class for a known {@link import("@comis/core").AgentCapability}, or
 * `undefined` for ANY OTHER string (the in-process dispatch path may pass a
 * non-`orch:` cap) — an honest unknown that OMITS the field rather than
 * mislabeling it (e.g. tagging a mutate as read).
 */
export function classifyCapabilityAction(
  capability: string,
): "read" | "mutate" | undefined {
  return (CAPABILITY_ACTION_CLASS as Record<string, "read" | "mutate" | undefined>)[
    capability
  ];
}

/**
 * Emit the per-cap audit for a gated call's authorization decision — BOTH the
 * durable `audit:event` and the `capability:audited` trajectory
 * record. Pure emitter: emits, never throws.
 *
 * @param deps - structural deps carrying `container.eventBus` + tenant config.
 * @param record - the content-free per-cap fact. Optional fields
 *   (`tool`/`runId`/`leaseId`/`parentLeaseId`) are emitted only when present —
 *   the in-process record honestly omits `leaseId`/`parentLeaseId`/`tool`.
 */
export function emitCapabilityAudit(
  deps: EmitCapabilityAuditDeps,
  record: CapabilityAuditRecord,
): void {
  const isDeny = record.decision === "deny";
  const timestamp = systemNowMs();
  const tenantId = deps.container.config.tenantId ?? "default";

  // The action class for the durable trail: a DENY is the destructive-intent
  // signal; an ALLOW derives a read|mutate from the capability's mutation
  // semantics and is OMITTED for an unrecognized cap (an honest unknown — never
  // an out-of-enum sentinel the sink would drop to null). Mirrors the
  // conditional-carry of `createAuditEvent`.
  const classification: "read" | "mutate" | "destructive" | undefined = isDeny
    ? "destructive"
    : classifyCapabilityAction(record.capability);

  // 1. The durable audit trail — ALWAYS emitted for a gated decision (the
  //    security trail is NOT coupled to tree-root resolution). The per-cap
  //    tuple rides the content-free `metadata` free-map; optional ids (incl.
  //    rootRunId) are present only when known (honest absence in-process).
  emitObservationalEventSafely({ eventBus: deps.container.eventBus, logger: deps.logger }, "audit:event", {
    timestamp,
    agentId: record.agentId,
    tenantId,
    actionType: record.method,
    kind: isDeny ? "capability_denied" : "audit",
    outcome: isDeny ? "denied" : "success",
    ...(classification !== undefined ? { classification } : {}),
    metadata: {
      capability: record.capability,
      method: record.method,
      // Optional ids — included only when present (honest absence in-process).
      ...(record.tool !== undefined ? { tool: record.tool } : {}),
      ...(record.runId !== undefined ? { runId: record.runId } : {}),
      ...(record.rootRunId !== undefined ? { rootRunId: record.rootRunId } : {}),
      ...(record.leaseId !== undefined ? { leaseId: record.leaseId } : {}),
      ...(record.parentLeaseId !== undefined ? { parentLeaseId: record.parentLeaseId } : {}),
      decision: record.decision,
    },
  });

  // 2. The TREE record (the spawn-tree's per-node producer) — emitted ONLY with a
  //    resolvable root: a node with no root is unplaceable in the tree,
  //    and `capability:audited.rootRunId` is a required string. The translator
  //    (translate-orchestration-payload.ts) strips the envelope; this carries the
  //    typed content-free tuple.
  if (record.rootRunId !== undefined) {
    emitObservationalEventSafely({ eventBus: deps.container.eventBus, logger: deps.logger }, "capability:audited", {
      timestamp,
      agentId: record.agentId,
      capability: record.capability,
      ...(record.tool !== undefined ? { tool: record.tool } : {}),
      method: record.method,
      decision: record.decision,
      ...(record.runId !== undefined ? { runId: record.runId } : {}),
      rootRunId: record.rootRunId,
      ...(record.leaseId !== undefined ? { leaseId: record.leaseId } : {}),
      ...(record.parentLeaseId !== undefined ? { parentLeaseId: record.parentLeaseId } : {}),
    });
  }
}
