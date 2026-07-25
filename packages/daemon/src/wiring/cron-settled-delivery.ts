// SPDX-License-Identifier: Apache-2.0
/** Exact-target, output-guarded, settled delivery shared by cron payloads. */
import {
  resolvePlatformDeliveryResult,
  type ClockPort,
  type ComisLogger,
  type DeliveryAdapter,
  type DeliveryService,
  type OutputGuardPort,
} from "@comis/core";
import type {
  CronDirectDeliveryOutcome,
  CronDeliveryTarget,
  CronRuntimeError,
} from "@comis/scheduler";
import type { Result } from "@comis/shared";

type CronDeliveryAdapter = DeliveryAdapter & { readonly channelId: string };

export interface CronSettledDeliveryDeps {
  clock: ClockPort;
  adaptersByType: ReadonlyMap<string, CronDeliveryAdapter>;
  deliveryService: DeliveryService;
  outputGuard: OutputGuardPort;
  isQuietHours: (nowMs: number) => Result<boolean, CronRuntimeError>;
  logger: Pick<ComisLogger, "warn" | "error">;
}

export interface CronSettledDeliveryRequest {
  executionId: string;
  jobId: string;
  text: string;
  target: CronDeliveryTarget;
  signal: AbortSignal;
}

export function createCronSettledDelivery(deps: CronSettledDeliveryDeps) {
  return async function deliverCronText(
    request: CronSettledDeliveryRequest,
  ): Promise<CronDirectDeliveryOutcome> {
    if (request.signal.aborted) return cancelledDelivery();
    const quiet = deps.isQuietHours(deps.clock.now());
    if (!quiet.ok) {
      deps.logger.error({
        executionId: request.executionId,
        jobId: request.jobId,
        step: "quiet_hours",
        errorKind: quiet.error.errorKind,
        hint: "Repair the validated scheduler quiet-hours configuration before the next delivery",
      }, "Cron quiet-hours evaluation failed");
      return {
        status: "pre_send_failed",
        reason: "target_precondition",
        errorKind: quiet.error.errorKind,
      };
    }
    if (quiet.value) return { status: "suppressed", reason: "quiet_hours" };

    const scanned = deps.outputGuard.scan(request.text);
    if (!scanned.ok || scanned.value.blocked) {
      return {
        status: "pre_send_failed",
        reason: "output_guard",
        errorKind: scanned.ok ? "auth" : "internal",
      };
    }
    if (request.signal.aborted) return cancelledDelivery();

    const endpoint = request.target.destinationEndpoint;
    const adapter = deps.adaptersByType.get(endpoint.channelType);
    if (adapter === undefined || adapter.channelId !== endpoint.channelInstanceId) {
      deps.logger.warn({
        executionId: request.executionId,
        jobId: request.jobId,
        channelType: endpoint.channelType,
        channelInstanceId: endpoint.channelInstanceId,
        errorKind: "precondition" as const,
        hint: "Start the exact channel adapter instance captured by the cron delivery target",
      }, "Cron delivery target is not bound");
      return {
        status: "pre_send_failed",
        reason: "target_precondition",
        errorKind: "precondition",
      };
    }

    const authority = {
      tenantId: request.target.conversation.conversationScope.tenantId,
      agentId: request.target.conversation.conversationScope.agentId,
      conversationRef: request.target.conversation.conversationRef,
    };
    let delivered: Awaited<ReturnType<DeliveryService["deliverToChannel"]>>;
    try {
      delivered = await deps.deliveryService.deliverToChannel(
        adapter,
        endpoint.conversationId,
        scanned.value.sanitized,
        {
          completionMode: "settled",
          authority,
          destinationEndpoint: endpoint,
          ...(endpoint.threadId === undefined ? {} : { threadId: endpoint.threadId }),
          origin: "cron",
          abortSignal: request.signal,
        },
      );
    } catch {
      deps.logger.error({
        executionId: request.executionId,
        jobId: request.jobId,
        step: "platform_delivery",
        errorKind: "dependency" as const,
        hint: "Inspect the exact channel adapter; the immutable cron outcome remains unknown and must not be replayed",
      }, "Cron settled delivery rejected");
      return unknownDelivery(deps.clock.now());
    }
    const platform = resolvePlatformDeliveryResult(delivered);
    if (!platform.ok) {
      return unknownDelivery(deps.clock.now());
    }
    return platform.value.platform;
  };
}

function cancelledDelivery(): CronDirectDeliveryOutcome {
  return {
    status: "pre_send_failed",
    reason: "cancelled",
    errorKind: "precondition",
  };
}

function unknownDelivery(settledAtMs: number): CronDirectDeliveryOutcome {
  return {
    status: "unknown",
    errorKind: "dependency",
    deliveredChunks: 0,
    failedChunks: 1,
    ambiguousChunks: 1,
    settledAtMs,
  };
}
