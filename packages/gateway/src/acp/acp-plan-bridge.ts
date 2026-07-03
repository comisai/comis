// SPDX-License-Identifier: Apache-2.0
/**
 * acp-plan-bridge — drives the IDE's native plan panel from the Silent
 * Execution Planner (SEP) by emitting ACP `session/update { sessionUpdate:
 * "plan" }` frames (spec §16.7 / §16.8). This bridge adds NO new plan-state
 * tool — SEP remains the single plan-state source; the bridge ONLY READS the
 * live plan through the core `ExecutionPlanPort` (the holder impl).
 *
 * The algorithm mirrors `createPlanStream`
 * (packages/observability/src/activity/plan-stream.ts:80-143) — but is
 * re-implemented LOCALLY because the gateway depends on `@comis/core` +
 * `@comis/shared` + the SDK only (the observability and agent packages are NOT
 * gateway dependencies; the boundary is enforced by `pnpm cycles` +
 * source-rules.test.ts).
 *
 *   - subscribes `sep:plan_extracted` → reads `executionPlanPort.getCurrentPlan()`
 *     and emits a `{ sessionUpdate: "plan", entries }` derived from
 *     `ExecutionPlan.steps`.
 *   - subscribes `tool:executed` → re-reads the plan and re-emits, so checkbox
 *     transitions (derived by SEP via `PlanStep.completedBy`) surface as the
 *     tools complete. `agentId` / `sessionKey` are OPTIONAL on `tool:executed`
 *     — the re-emit is skipped when either is absent.
 *
 * Two deltas from the analog: (1) instead of an `onPlanUpdate` callback, the
 * acpSessionId is resolved from `parseFormattedSessionKey(sessionKey).peerId`
 * (the AcpSessionMap keys `peerId === acpSessionId`), the retained connection is
 * looked up via `getConnection`, and the frame is pushed with the single-arg
 * `connection.sessionUpdate({ sessionId, update })` (acp.d.ts:45); (2) the
 * renderer projection is replaced by {@link mapEntries} → SDK `PlanEntry[]` with
 * the SEP→SDK status map.
 *
 * SEP `ReadonlyPlanStep.status` is `"pending"|"in_progress"|"done"|"skipped"`;
 * SDK `PlanEntryStatus` is `"pending"|"in_progress"|"completed"` (no "done", no
 * "skipped"). The map: `done → "completed"`, `in_progress → "in_progress"`,
 * `skipped → "completed"` (SDK has no "skipped"; documented lossy collapse),
 * else `"pending"`. The FULL entries list is sent on every
 * update — the SDK client replaces the entire plan (Plan.entries, §16.8).
 *
 * §19.6 M6 carried to the plan frame: each entry carries ONLY `content` /
 * `priority` / `status`. `completedBy` and any raw tool params are NEVER
 * referenced — the plan frame cannot smuggle them. The bridge is a
 * void-emitter (it does not throw, no allow-throw annotation); the logger is
 * injected via Deps (no module-level logger factory, no infra import).
 *
 * @module
 */
import type {
  ComisLogger,
  EventMap,
  TypedEventBus,
  ExecutionPlanPort,
  ReadonlyExecutionPlan,
  ReadonlyPlanStep,
} from "@comis/core";
import { parseFormattedSessionKey } from "@comis/core";
import type {
  AgentSideConnection,
  PlanEntry,
} from "@agentclientprotocol/sdk";

/** Dependencies for {@link createAcpPlanBridge}. */
export interface CreateAcpPlanBridgeDeps {
  /** The agent event bus (`sep:plan_extracted` + `tool:executed`). */
  readonly eventBus: TypedEventBus;
  /**
   * Read-only accessor for the live SEP plan (the holder impl). The bridge
   * re-reads it on every relevant event so SEP's per-turn step-status flips
   * surface without a re-publish.
   */
  readonly executionPlanPort: ExecutionPlanPort;
  /**
   * Look up the retained `AgentSideConnection` for an ACP session id. Returns
   * `undefined` for an unknown / dropped session — the bridge then no-ops for
   * that event.
   */
  readonly getConnection: (
    acpSessionId: string,
  ) => AgentSideConnection | undefined;
  /** Injected bound logger. Optional — DEBUG plan-update traces. */
  readonly logger?: ComisLogger;
}

/**
 * Map SEP plan steps to the SDK `PlanEntry[]` (FULL list every update; the SDK
 * client replaces the entire plan).
 *
 * Carries ONLY `content` / `priority` / `status` — `completedBy` and any raw
 * tool params are never referenced (§19.6 M6 applied to the plan frame).
 */
function mapEntries(steps: readonly ReadonlyPlanStep[]): PlanEntry[] {
  return steps.map((step) => ({
    content: step.description,
    // SEP has no priority concept; a constant medium default keeps the panel
    // ordering neutral.
    priority: "medium",
    status:
      step.status === "done"
        ? "completed" // SEP "done" → SDK "completed" (SDK has no "done").
        : step.status === "in_progress"
          ? "in_progress"
          : step.status === "skipped"
            ? "completed" // SDK has no "skipped"; collapse to completed (documented lossy map).
            : "pending",
  }));
}

/**
 * Create the ACP plan-bridge. NO new tool is registered (§16.7) — the bridge
 * ONLY reads the existing SEP plan via the port. Returns an `unsubscribe()` that
 * detaches both bus handlers (subscription-bag cleanup symmetry, mirrored from
 * `plan-stream.ts:82-141`).
 */
export function createAcpPlanBridge(
  deps: CreateAcpPlanBridgeDeps,
): () => void {
  const subscriptions: Array<{
    eventName: keyof EventMap;
    handler: (payload: unknown) => void;
  }> = [];

  const emitFromPlan = (agentId: string, sessionKey: string): void => {
    const plan: ReadonlyExecutionPlan | undefined =
      deps.executionPlanPort.getCurrentPlan();
    if (plan === undefined || !plan.active) {
      // SEP inactive for this turn — nothing to project (§16.7).
      return;
    }

    // Resolve the ACP session id from the formatted sessionKey. The
    // AcpSessionMap keys `peerId === acpSessionId`.
    const acpSessionId = parseFormattedSessionKey(sessionKey)?.peerId;
    if (acpSessionId === undefined) {
      deps.logger?.debug?.(
        {
          agentId,
          sessionKey,
          submodule: "acp-plan-bridge",
          step: "resolve-session",
        },
        "plan event sessionKey has no acp peerId — dropping",
      );
      return;
    }

    const connection = deps.getConnection(acpSessionId);
    if (connection === undefined) {
      // No retained connection (dropped / unknown session) — no-op.
      return;
    }

    const entries = mapEntries(plan.steps);
    deps.logger?.debug?.(
      {
        agentId,
        sessionKey,
        stepCount: entries.length,
        completedCount: plan.completedCount,
        submodule: "acp-plan-bridge",
        step: "plan-update",
      },
      "plan update derived from SEP",
    );
    // SINGLE-ARG sessionUpdate({ sessionId, update }) (acp.d.ts:45). The FULL
    // entries list is sent every update — the SDK client replaces the entire
    // plan (Plan.entries, §16.8). The discarded promise carries a `.catch` so a
    // rejected frame (e.g. the IDE disconnects mid-turn and the plan panel
    // closes) is logged instead of surfacing as an unhandled rejection.
    // Each emit is independent (no serialization chain), so the catch only logs
    // the redacted SDK error — never the entries/params. The bridge stays a
    // non-throwing void-emitter (no allow-throw annotation).
    connection
      .sessionUpdate({
        sessionId: acpSessionId,
        update: { sessionUpdate: "plan", entries },
      })
      .catch((err: unknown) => {
        deps.logger?.debug?.(
          {
            err,
            acpSessionId,
            submodule: "acp-plan-bridge",
            step: "plan-update",
            hint: "IDE connection may have closed; plan frame dropped",
            errorKind: "dependency" as const,
          },
          "acp plan sessionUpdate failed — dropping frame",
        );
      });
  };

  // sep:plan_extracted → derive the initial plan-update.
  const planHandler = (payload: EventMap["sep:plan_extracted"]): void => {
    emitFromPlan(payload.agentId, payload.sessionKey);
  };
  deps.eventBus.on("sep:plan_extracted", planHandler);
  subscriptions.push({
    eventName: "sep:plan_extracted",
    handler: planHandler as (p: unknown) => void,
  });

  // tool:executed → re-read the plan and re-emit (checkbox transitions derived
  // by SEP via PlanStep.completedBy). agentId/sessionKey are OPTIONAL on the
  // payload; skip the re-emit when either is absent.
  const toolHandler = (payload: EventMap["tool:executed"]): void => {
    if (payload.agentId === undefined || payload.sessionKey === undefined)
      return;
    emitFromPlan(payload.agentId, payload.sessionKey);
  };
  deps.eventBus.on("tool:executed", toolHandler);
  subscriptions.push({
    eventName: "tool:executed",
    handler: toolHandler as (p: unknown) => void,
  });

  return function unsubscribe(): void {
    for (const sub of subscriptions) {
      deps.eventBus.off(
        sub.eventName,
        sub.handler as (p: EventMap[keyof EventMap]) => void,
      );
    }
    subscriptions.length = 0;
  };
}
