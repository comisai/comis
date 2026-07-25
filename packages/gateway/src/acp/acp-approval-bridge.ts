// SPDX-License-Identifier: Apache-2.0
/**
 * acp-approval-bridge — maps a redacted `kind:"approval"` {@link ActivityEvent}
 * to a single SDK `connection.requestPermission(...)` round-trip on the
 * retained per-session connection (spec §6.4 / §16.8). Surfaces the
 * agent's approval gate as a native IDE permission modal.
 *
 * The bridge subscribes a single turn's activity stream via the
 * `ActivityStreamPort` (the same seam as the activity bridge),
 * and for each `kind:"approval"` event:
 *
 *   - receives the ACP session id explicitly at turn subscription and no-ops
 *     if no connection is retained;
 *   - builds a {@link RequestPermissionRequest} whose `options` are derived
 *     from `event.approval.choices` (`id→optionId`, `defaultLabel→name`,
 *     `id→kind`), and calls `connection.requestPermission(req)` exactly once;
 *   - reads the SDK outcome and LOGS it (`"selected"` w/ optionId | `"cancelled"`).
 *
 * EMIT-AND-LOG (decision): no server-side ACP approval-response SINK exists yet,
 * so the outcome is logged for the audit trail but NOT routed back into the §6.4
 * approval gate. Routing is a deferred follow-up; the emission + the verified SDK
 * contract are sufficient for the current bridge.
 *
 * §19.6: the produced `toolCall` (a `ToolCallUpdate`) carries ONLY
 * `toolCallId` + `title`. The SDK's raw-input/raw-output fields are NEVER
 * referenced, and the redacted event `params` are NEVER forwarded — the source
 * `ApprovalCorrelation` deliberately has no full request id (only `shortId`),
 * so nothing identifying crosses the wire. The bridge is a void-emitter (it does
 * not throw and carries no allow-throw annotation); the logger is injected via
 * Deps (no module-level logger factory, no infra-package import).
 *
 * @module
 */
import type {
  ActivityEvent,
  ActivityStreamPort,
  ApprovalChoice,
  ComisLogger,
  TurnActivityContext,
} from "@comis/core";
import type {
  AgentSideConnection,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";

/** Dependencies for {@link createAcpApprovalBridge}. */
export interface CreateAcpApprovalBridgeDeps {
  /**
   * Per-turn activity subscription seam. The concrete impl lives in
   * the observability package; the gateway receives the bound port shape from
   * `@comis/core`.
   */
  readonly activityStreamPort: ActivityStreamPort;
  /**
   * Look up the retained `AgentSideConnection` for an ACP session id.
   * Returns `undefined` for an unknown / dropped session — the bridge
   * then no-ops for that event.
   */
  readonly getConnection: (
    acpSessionId: string,
  ) => AgentSideConnection | undefined;
  /** Injected bound logger. Optional — records the permission outcome. */
  readonly logger?: ComisLogger;
}

/** A subscribed ACP approval bridge — call `subscribe(ctx)` to start a turn. */
export interface AcpApprovalBridge {
  /**
   * Begin mapping a single turn's `kind:"approval"` ActivityEvents to SDK
   * `requestPermission(...)` round-trips. Returns an `unsubscribe()` that
   * detaches the underlying activity-stream subscription (cleanup symmetry).
   */
  subscribe(ctx: TurnActivityContext, acpSessionId: string): () => void;
}

/**
 * Map an {@link ApprovalChoice} id to its SDK {@link PermissionOptionKind}.
 *
 * Closed-union switch (AGENTS.md §2.8): `ApprovalChoice.id` is the closed union
 * `"approve" | "deny" | "details"`, so a new member fails `tsc` at the
 * exhaustive `const _exhaustive: never` default. `details` is a non-destructive
 * "show more" action, so it maps to `allow_once` (not a rejection).
 */
function choiceKind(id: ApprovalChoice["id"]): PermissionOptionKind {
  switch (id) {
    case "approve":
      return "allow_once";
    case "deny":
      return "reject_once";
    case "details":
      return "allow_once";
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

/**
 * Build the SDK {@link RequestPermissionRequest} for an approval event.
 *
 * §19.6: `toolCall` carries ONLY `toolCallId` + `title`; the SDK's
 * raw-input/raw-output fields are never set and the event `params` are never
 * forwarded.
 */
function toRequestPermissionRequest(
  acpSessionId: string,
  e: ActivityEvent,
  choices: readonly ApprovalChoice[],
): RequestPermissionRequest {
  const options: PermissionOption[] = choices.map((c) => ({
    optionId: c.id,
    name: c.defaultLabel,
    kind: choiceKind(c.id),
  }));
  return {
    sessionId: acpSessionId,
    // ToolCallUpdate — toolCallId is the only REQUIRED field; title is a safe
    // redacted label. The SDK's raw-input / raw-output fields are NEVER set
    // and the event params are never forwarded.
    toolCall: {
      toolCallId: e.toolCallId ?? e.activityId,
      title: e.defaultLabel ?? "Approval required",
    },
    options,
  };
}

/**
 * Create the ACP approval bridge. Pure factory — no I/O until `subscribe()`.
 */
export function createAcpApprovalBridge(
  deps: CreateAcpApprovalBridgeDeps,
): AcpApprovalBridge {
  return {
    subscribe(ctx: TurnActivityContext, acpSessionId: string): () => void {
      // Serialize the async requestPermission round-trips so concurrent
      // approval events do not interleave their SDK calls out of order.
      let chain: Promise<void> = Promise.resolve();

      const handleApproval = (e: ActivityEvent): void => {
        // 1) Approval-only gate. The schema guarantees the block is present iff
        //    kind === "approval", but guard the narrowed type anyway.
        if (e.kind !== "approval" || e.approval === undefined) return;
        const approval = e.approval;

        // 2) Resolve the ACP session id and the retained connection. A dropped
        //    / unknown session (getConnection === undefined) is a no-op.
        if (acpSessionId.length === 0 || e.sessionKey !== ctx.sessionKey) {
          deps.logger?.debug?.(
            {
              sessionKey: e.sessionKey,
              submodule: "acp-approval-bridge",
              step: "resolve-session",
            },
            "approval event does not match the subscribed ACP turn — dropping",
          );
          return;
        }
        const connection = deps.getConnection(acpSessionId);
        if (connection === undefined) return;

        // 3) Build the request from the approval choices (§19.6: toolCall
        //    carries only toolCallId + title).
        const req = toRequestPermissionRequest(
          acpSessionId,
          e,
          approval.choices,
        );

        // 4) Drive the SDK round-trip and LOG the outcome. Emit-and-log: there
        //    is no ACP approval-response sink yet, so the outcome is NOT
        //    routed back into the §6.4 gate (deferred follow-up). Log only the
        //    outcome discriminant + optionId — never the shortId, choice label
        //    content, or any params (no message bodies / secrets).
        //    The await + outcome log are isolated in a try/catch INSIDE the
        //    .then callback so a rejected requestPermission (e.g. the IDE
        //    disconnects mid-turn) is logged and dropped WITHOUT rejecting the
        //    `chain` — a rejected chain would poison every later approval's
        //    `.then`, silently dropping all remaining approvals for the turn
        //    The bridge stays a non-throwing void-emitter (no
        //    allow-throw); only the redacted SDK error is logged, never params.
        chain = chain.then(async () => {
          try {
            const res = await connection.requestPermission(req);
            deps.logger?.info?.(
              {
                agentId: e.agentId,
                acpSessionId,
                outcome: res.outcome.outcome,
                optionId:
                  res.outcome.outcome === "selected"
                    ? res.outcome.optionId
                    : undefined,
                submodule: "acp-approval-bridge",
                step: "permission-outcome",
              },
              "ACP approval outcome received",
            );
          } catch (err) {
            deps.logger?.debug?.(
              {
                err,
                acpSessionId,
                submodule: "acp-approval-bridge",
                step: "permission-outcome",
                hint: "IDE connection may have closed; approval dropped, chain preserved",
                errorKind: "dependency" as const,
              },
              "acp requestPermission failed — dropping approval, chain preserved",
            );
          }
        });
      };

      const subscription = deps.activityStreamPort.subscribeForTurn(
        ctx,
        handleApproval,
      );

      return function unsubscribe(): void {
        subscription.unsubscribe();
      };
    },
  };
}
