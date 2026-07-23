// SPDX-License-Identifier: Apache-2.0
/** Exact-authority, settled platform delivery for proactive agent heartbeat output. */
import {
  ChannelEndpointSchema,
  createConversationLocator,
  resolvePlatformDeliveryResult,
  type ChannelEndpoint,
  type ClockPort,
  type ComisLogger,
  type DeliveryAdapter,
  type DeliveryService,
  type OutputGuardPort,
} from "@comis/core";
import type {
  DuplicateDetector,
  HeartbeatDeliveryOutcome,
} from "@comis/scheduler";
import { fromPromise, type Result } from "@comis/shared";

type HeartbeatDeliveryAdapter = DeliveryAdapter & { readonly channelId: string };

interface QuietHoursError {
  readonly errorKind: "config" | "validation" | "internal";
}

export interface HeartbeatSettledDeliveryDeps {
  tenantId: string;
  clock: ClockPort;
  adaptersByType: ReadonlyMap<string, HeartbeatDeliveryAdapter>;
  deliveryService: DeliveryService;
  outputGuard: Pick<OutputGuardPort, "scan">;
  duplicateDetector: DuplicateDetector;
  isQuietHours(nowMs: number): Result<boolean, QuietHoursError>;
  criticalBypass: boolean;
  logger: Pick<ComisLogger, "warn" | "error">;
}

export interface HeartbeatSettledDeliveryRequest {
  correlationId: string;
  agentId: string;
  endpoint: ChannelEndpoint;
  text: string;
  level: "ok" | "alert" | "critical";
  allowDm: boolean | undefined;
  signal: AbortSignal;
}

export function createHeartbeatSettledDelivery(deps: HeartbeatSettledDeliveryDeps) {
  return async function deliverHeartbeat(
    request: HeartbeatSettledDeliveryRequest,
  ): Promise<HeartbeatDeliveryOutcome> {
    if (request.signal.aborted) return cancelledDelivery();
    const parsedEndpoint = ChannelEndpointSchema.safeParse(request.endpoint);
    if (!parsedEndpoint.success) {
      return { status: "pre_send_failed", reason: "target_precondition", errorKind: "validation" };
    }
    const endpoint = parsedEndpoint.data;
    if (endpoint.conversationKind === "direct" && request.allowDm === false) {
      return { status: "suppressed", reason: "dm_policy" };
    }
    const quiet = deps.isQuietHours(deps.clock.now());
    if (!quiet.ok) {
      deps.logger.error({
        correlationId: request.correlationId,
        agentId: request.agentId,
        step: "heartbeat_quiet_hours",
        errorKind: quiet.error.errorKind,
        hint: "Repair the validated scheduler quiet-hours configuration before the next heartbeat delivery",
      }, "Heartbeat quiet-hours evaluation failed");
      return { status: "pre_send_failed", reason: "target_precondition", errorKind: quiet.error.errorKind };
    }
    if (quiet.value && (request.level !== "critical" || !deps.criticalBypass)) {
      return { status: "suppressed", reason: "quiet_hours" };
    }

    const scanned = deps.outputGuard.scan(request.text);
    if (!scanned.ok || scanned.value.blocked) {
      return {
        status: "pre_send_failed",
        reason: "output_guard",
        errorKind: scanned.ok ? "auth" : "internal",
      };
    }
    if (request.signal.aborted) return cancelledDelivery();

    const candidate = {
      agentId: request.agentId,
      destinationEndpoint: endpoint,
      text: scanned.value.sanitized,
    };
    if (deps.duplicateDetector.check(candidate)) {
      return { status: "suppressed", reason: "duplicate" };
    }

    const adapter = deps.adaptersByType.get(endpoint.channelType);
    if (adapter === undefined || adapter.channelId !== endpoint.channelInstanceId) {
      deps.logger.warn({
        correlationId: request.correlationId,
        agentId: request.agentId,
        channelType: endpoint.channelType,
        channelInstanceId: endpoint.channelInstanceId,
        errorKind: "precondition" as const,
        hint: "Start the exact channel adapter instance configured for the heartbeat target",
      }, "Heartbeat delivery target is not bound");
      return { status: "pre_send_failed", reason: "target_precondition", errorKind: "precondition" };
    }

    const locator = createConversationLocator({
      tenantId: deps.tenantId,
      agentId: request.agentId,
      partition: { kind: "endpoint-conversation", endpoint },
    });
    if (!locator.ok) {
      return { status: "pre_send_failed", reason: "target_precondition", errorKind: "validation" };
    }
    const delivered = await fromPromise(deps.deliveryService.deliverToChannel(
      adapter,
      endpoint.conversationId,
      scanned.value.sanitized,
      {
        completionMode: "settled",
        authority: {
          tenantId: deps.tenantId,
          agentId: request.agentId,
          conversationRef: locator.value.conversationRef,
        },
        destinationEndpoint: endpoint,
        ...(endpoint.threadId === undefined ? {} : { threadId: endpoint.threadId }),
        origin: "heartbeat",
        abortSignal: request.signal,
      },
    ));
    if (!delivered.ok) {
      deps.logger.error({
        correlationId: request.correlationId,
        agentId: request.agentId,
        step: "heartbeat_platform_delivery",
        errorKind: "dependency" as const,
        hint: "Inspect the exact channel adapter; the heartbeat result remains unknown and must not be replayed",
      }, "Heartbeat settled delivery rejected");
      return unknownDelivery(deps.clock.now());
    }
    const platform = resolvePlatformDeliveryResult(delivered.value);
    if (!platform.ok) return unknownDelivery(deps.clock.now());
    if (
      platform.value.platform.status === "accepted"
      || platform.value.platform.status === "partial"
      || platform.value.platform.status === "unknown"
    ) {
      deps.duplicateDetector.recordPossiblyVisible(candidate);
    }
    return platform.value.platform;
  };
}

function cancelledDelivery(): HeartbeatDeliveryOutcome {
  return { status: "pre_send_failed", reason: "cancelled", errorKind: "precondition" };
}

function unknownDelivery(settledAtMs: number): HeartbeatDeliveryOutcome {
  return {
    status: "unknown",
    errorKind: "dependency",
    deliveredChunks: 0,
    failedChunks: 1,
    ambiguousChunks: 1,
    settledAtMs,
  };
}
