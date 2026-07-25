// SPDX-License-Identifier: Apache-2.0
/**
 * acp-activity-bridge — maps redacted {@link ActivityEvent}s to ACP
 * `session/update` frames while NEVER letting raw tool params cross
 * the wire (spec §19.6).
 *
 * The bridge subscribes a single turn's activity stream via the
 * `ActivityStreamPort`, and for each redacted event:
 *
 *   - pushes it into a LOCAL 256-slot FIFO drop-oldest queue
 *     (`createAcpBoundedQueue`, NOT the observability one — gateway depends on
 *     `@comis/core` + `@comis/shared` + the SDK only; spec §5.1 line 717),
 *   - drains the queue SEQUENTIALLY, awaiting each `connection.sessionUpdate`
 *     so the SDK write-queue preserves enqueue order,
 *   - receives the ACP session id explicitly at turn subscription and no-ops
 *     if no connection is retained.
 *
 * Phase → SessionUpdate is a closed-union switch (AGENTS.md §2.8): `start` →
 * `tool_call`, `progress | end` → `tool_call_update`, with an exhaustive
 * `const _exhaustive: never` default.
 *
 * §19.6: the produced `tool_call` / `tool_call_update` objects
 * carry ONLY `toolCallId` / `title` / `status`. The SDK's raw-input/raw-output
 * fields are NEVER referenced, and the redacted event params (even though
 * sanitized at emit) are NEVER forwarded to any SDK field — carrying them would
 * re-open the data-protection surface and make this guarantee fragile. The bridge is a
 * void-emitter (it does not throw and carries no allow-throw annotation); the
 * logger is injected via Deps (no module-level logger factory, no
 * infra-package import).
 *
 * @module
 */
import type {
  ActivityEvent,
  ActivityStreamPort,
  ComisLogger,
  TurnActivityContext,
} from "@comis/core";
import type {
  AgentSideConnection,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
  createAcpBoundedQueue,
  DEFAULT_ACP_QUEUE_CAPACITY,
} from "./acp-bounded-queue.js";

/** Dependencies for {@link createAcpActivityBridge}. */
export interface CreateAcpActivityBridgeDeps {
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
  /** Injected bound logger. Optional — DEBUG-level drop/no-op traces. */
  readonly logger?: ComisLogger;
}

/** A subscribed ACP activity bridge — call `subscribe(ctx)` to start a turn. */
export interface AcpActivityBridge {
  /**
   * Begin mapping a single turn's redacted ActivityEvents to ACP
   * `session/update` frames. Returns an `unsubscribe()` that detaches the
   * underlying activity-stream subscription (cleanup symmetry).
   */
  subscribe(ctx: TurnActivityContext, acpSessionId: string): () => void;
}

/**
 * Map a redacted {@link ActivityEvent} to its SDK {@link SessionUpdate}.
 *
 * §19.6: carries ONLY `toolCallId` / `title` / `status`. The SDK's
 * raw-input/raw-output fields are never set and the redacted event params are
 * never forwarded.
 */
function toSessionUpdate(e: ActivityEvent): SessionUpdate {
  switch (e.phase) {
    case "start":
      return {
        sessionUpdate: "tool_call",
        toolCallId: e.toolCallId ?? e.activityId,
        // ToolCall.title is REQUIRED; source from the redacted label/toolName.
        title: e.defaultLabel ?? e.toolName ?? "tool",
        status: "pending",
      };
    case "progress":
    case "end":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: e.toolCallId ?? e.activityId,
        status:
          e.status === "completed"
            ? "completed"
            : e.status === "failed"
              ? "failed"
              : "in_progress",
      };
    default: {
      // Exhaustive closed-union guard (AGENTS.md §2.8): a new phase fails tsc.
      const _exhaustive: never = e.phase;
      return _exhaustive;
    }
  }
}

/**
 * Create the ACP activity bridge. Pure factory — no I/O until `subscribe()`.
 */
export function createAcpActivityBridge(
  deps: CreateAcpActivityBridgeDeps,
): AcpActivityBridge {
  return {
    subscribe(ctx: TurnActivityContext, acpSessionId: string): () => void {
      // Local 256-slot bounded queue. Drop-oldest backpressure caps
      // memory if the IDE consumer is slow (spec §5.1 line 717 = 256).
      const queue = createAcpBoundedQueue<ActivityEvent>({
        capacity: DEFAULT_ACP_QUEUE_CAPACITY,
      });

      // Serialize the async drain so enqueue order is preserved on the wire
      // even when multiple events arrive before a drain completes.
      let draining: Promise<void> = Promise.resolve();

      const pump = (): void => {
        draining = draining.then(async () => {
          for (const event of queue.drain()) {
            if (acpSessionId.length === 0 || event.sessionKey !== ctx.sessionKey) {
              deps.logger?.debug?.(
                {
                  sessionKey: event.sessionKey,
                  submodule: "acp-activity-bridge",
                  step: "resolve-session",
                },
                "activity event does not match the subscribed ACP turn — dropping",
              );
              continue;
            }
            const connection = deps.getConnection(acpSessionId);
            if (connection === undefined) {
              // No retained connection (dropped / unknown session) — no-op.
              continue;
            }
            // SINGLE-ARG sessionUpdate({ sessionId, update }) (acp.d.ts:45).
            // await so the SDK write-queue preserves enqueue order. The await
            // is isolated in a try/catch INSIDE the .then callback so a single
            // rejected frame (e.g. the IDE disconnects mid-turn and the writer
            // closes) is logged and dropped WITHOUT rejecting the `draining`
            // chain — a rejected chain would poison every later pump's
            // `.then`, silently dropping all remaining frames for the turn
            // The bridge stays a non-throwing void-emitter (no
            // allow-throw); only the redacted SDK error is logged, never the
            // params.
            try {
              await connection.sessionUpdate({
                sessionId: acpSessionId,
                update: toSessionUpdate(event),
              });
            } catch (err) {
              deps.logger?.debug?.(
                {
                  err,
                  acpSessionId,
                  submodule: "acp-activity-bridge",
                  step: "session-update",
                  hint: "IDE connection may have closed; frame dropped, chain preserved",
                  errorKind: "dependency" as const,
                },
                "acp sessionUpdate failed — dropping frame, chain preserved",
              );
            }
          }
        });
      };

      const subscription = deps.activityStreamPort.subscribeForTurn(
        ctx,
        (event: ActivityEvent) => {
          const dropped = queue.push(event);
          if (dropped > 0) {
            deps.logger?.debug?.(
              {
                agentId: event.agentId,
                droppedCount: queue.droppedCount(),
                submodule: "acp-activity-bridge",
                step: "queue-overflow",
              },
              "acp activity queue overflow — dropped oldest event",
            );
          }
          pump();
        },
      );

      return function unsubscribe(): void {
        subscription.unsubscribe();
      };
    },
  };
}
