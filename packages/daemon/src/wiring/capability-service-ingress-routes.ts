// SPDX-License-Identifier: Apache-2.0
import type { z } from "zod";
import {
  CapabilityPutEvidenceRequestSchema,
  CapabilityReceiveAttentionResponseRequestSchema,
  CapabilityReleaseRequestSchema,
  CapabilityReportRequestSchema,
  type CapabilityServiceErrorKind,
} from "@comis/capability-service-sdk";
import type { ClockPort, ComisLogger, TimerPort } from "@comis/core";
import { err, fromPromise, tryCatch, type Result } from "@comis/shared";
import type { ManagedRunEvidenceBridge } from "./managed-run-evidence-bridge.js";
import type { ManagedAttentionResponseBridge } from "./managed-attention-response-bridge.js";
import type { ManagedRunReportBridge } from "./managed-run-report-bridge.js";
import type { ManagedRunReleaseCoordinator } from "./managed-run-release-coordinator.js";

export interface CapabilityServiceIngressRouteDeps {
  readonly reportBridge: ManagedRunReportBridge;
  readonly evidenceBridge: ManagedRunEvidenceBridge;
  readonly attentionResponseBridge: ManagedAttentionResponseBridge;
  readonly releaseCoordinator: ManagedRunReleaseCoordinator;
  readonly requestDeadlineMs: number;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly logger: ComisLogger;
}

/** Receive an owner-bound private attention response within the bounded wire deadline. */
export async function routeManagedAttentionResponseIngress(
  serviceInstanceId: string,
  request: z.infer<typeof CapabilityReceiveAttentionResponseRequestSchema>,
  deps: CapabilityServiceIngressRouteDeps,
): Promise<CapabilityServiceIngressRouteResult> {
  const startedAtMs = deps.clock.now();
  deps.logger.debug({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    step: "capability-service-attention-response-ingress",
  }, "Routing capability-service attention response receive");
  const invoked = tryCatch(() => deps.attentionResponseBridge.receiveAttentionResponse({
    serviceInstanceId,
    ...request.params,
  }));
  const deadline = invoked.ok
    ? await awaitResultDeadline(invoked.value, deps.timers, deps.requestDeadlineMs)
    : { result: err(invoked.error), settlement: Promise.resolve() };
  const settled = deadline.result;
  let result: CapabilityServiceIngressRouteResult;
  if (settled === undefined) result = responseError("deadline_exceeded", deadline.settlement);
  else if (!settled.ok) result = responseError("internal_error", deadline.settlement);
  else if (settled.value.kind === "rejected") {
    result = responseError(settled.value.reasonCode === "invalid_request"
      ? "invalid_params"
      : "precondition_failed", deadline.settlement);
  } else if (settled.value.kind === "pending") {
    result = {
      response: {
        managedRunId: settled.value.managedRunId,
        externalKey: settled.value.externalKey,
        state: "pending",
      },
      settlement: deadline.settlement,
    };
  } else {
    result = {
      response: {
        managedRunId: settled.value.managedRunId,
        externalKey: settled.value.externalKey,
        state: "delivered",
        response: settled.value.response,
      },
      settlement: deadline.settlement,
    };
  }
  deps.logger.info({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    durationMs: Math.max(0, deps.clock.now() - startedAtMs),
  }, "Capability-service attention response receive completed");
  return result;
}

/** Revoke run-bound capabilities and release the exact workspace lease. */
export async function routeManagedRunReleaseIngress(
  serviceInstanceId: string,
  request: z.infer<typeof CapabilityReleaseRequestSchema>,
  deps: CapabilityServiceIngressRouteDeps,
): Promise<CapabilityServiceIngressRouteResult> {
  const startedAtMs = deps.clock.now();
  deps.logger.debug({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    step: "capability-service-release-ingress",
  }, "Routing capability-service release");
  const invoked = tryCatch(() => deps.releaseCoordinator.release({
    serviceInstanceId,
    ...request.params,
  }));
  const deadline = invoked.ok
    ? await awaitResultDeadline(invoked.value, deps.timers, deps.requestDeadlineMs)
    : { result: err(invoked.error), settlement: Promise.resolve() };
  const settled = deadline.result;
  let result: CapabilityServiceIngressRouteResult;
  if (settled === undefined) result = responseError("deadline_exceeded", deadline.settlement);
  else if (!settled.ok) result = responseError("internal_error", deadline.settlement);
  else if (settled.value.kind === "rejected") {
    result = responseError(settled.value.reasonCode === "release_conflict"
      ? "replay_conflict"
      : "precondition_failed", deadline.settlement);
  } else {
    result = {
      response: {
        managedRunId: settled.value.managedRunId,
        workspaceLeaseId: settled.value.workspaceLeaseId,
        state: "released",
        disposition: settled.value.disposition,
        releasedAtMs: settled.value.releasedAtMs,
      },
      settlement: deadline.settlement,
    };
  }
  deps.logger.info({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    durationMs: Math.max(0, deps.clock.now() - startedAtMs),
  }, "Capability-service release request completed");
  return result;
}

export interface CapabilityServiceIngressRouteResult {
  readonly response: unknown;
  readonly errorKind?: CapabilityServiceErrorKind;
  readonly settlement: Promise<void>;
}

async function awaitResultDeadline<T>(
  operation: Promise<Result<T, Error>>,
  timers: TimerPort,
  deadlineMs: number,
): Promise<{
  readonly result: Result<T, Error> | undefined;
  readonly settlement: Promise<void>;
}> {
  const settledOperation = fromPromise(operation).then((result) => (
    result.ok ? result.value : err(result.error)
  ));
  const result = await new Promise<Result<T, Error> | undefined>((resolveDeadline) => {
    let settled = false;
    const timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveDeadline(undefined);
    }, deadlineMs);
    timer.unref();
    void settledOperation.then((operationResult) => {
      if (settled) return;
      settled = true;
      timer.cancel();
      resolveDeadline(operationResult);
    });
  });
  return { result, settlement: settledOperation.then(() => undefined) };
}

function responseError(
  errorKind: CapabilityServiceErrorKind,
  settlement: Promise<void>,
): CapabilityServiceIngressRouteResult {
  return { response: undefined, errorKind, settlement };
}

/** Invoke the durable report bridge within the bounded wire deadline. */
export async function routeManagedRunReportIngress(
  serviceInstanceId: string,
  request: z.infer<typeof CapabilityReportRequestSchema>,
  deps: CapabilityServiceIngressRouteDeps,
): Promise<CapabilityServiceIngressRouteResult> {
  const startedAtMs = deps.clock.now();
  deps.logger.debug({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    step: "capability-service-report-ingress",
  }, "Routing capability-service report");
  const invoked = tryCatch(() => deps.reportBridge.ingestReport({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    report: {
      serviceReportId: request.params.serviceReportId,
      kind: request.params.kind,
      summary: request.params.summary,
      ...(request.params.externalKey === undefined ? {} : { externalKey: request.params.externalKey }),
      ...(request.params.details === undefined ? {} : { details: request.params.details }),
      ...(request.params.artifactRefs === undefined ? {} : { artifactRefs: request.params.artifactRefs }),
      ...(request.params.observedAtMs === undefined ? {} : { observedAtMs: request.params.observedAtMs }),
    },
  }));
  const deadline = invoked.ok
    ? await awaitResultDeadline(invoked.value, deps.timers, deps.requestDeadlineMs)
    : { result: err(invoked.error), settlement: Promise.resolve() };
  const settled = deadline.result;
  let result: CapabilityServiceIngressRouteResult;
  if (settled === undefined) result = responseError("deadline_exceeded", deadline.settlement);
  else if (!settled.ok) result = responseError("internal_error", deadline.settlement);
  else if (settled.value.kind === "rejected") {
    result = responseError(settled.value.reasonCode === "replay_conflict"
      ? "replay_conflict"
      : settled.value.reasonCode === "invalid_report"
        ? "invalid_params"
        : "precondition_failed", deadline.settlement);
  } else {
    result = {
      response: {
        managedRunId: settled.value.report.managedRunId,
        serviceReportId: settled.value.report.serviceReportId,
        acceptedSequence: settled.value.report.sequence,
        retainedUntilMs: settled.value.report.retainedUntilMs,
      },
      settlement: deadline.settlement,
    };
  }
  deps.logger.info({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    durationMs: Math.max(0, deps.clock.now() - startedAtMs),
  }, "Capability-service report request completed");
  return result;
}

/** Invoke the verifier-bound evidence bridge within the bounded wire deadline. */
export async function routeManagedRunEvidenceIngress(
  serviceInstanceId: string,
  request: z.infer<typeof CapabilityPutEvidenceRequestSchema>,
  deps: CapabilityServiceIngressRouteDeps,
): Promise<CapabilityServiceIngressRouteResult> {
  const startedAtMs = deps.clock.now();
  deps.logger.debug({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    step: "capability-service-evidence-ingress",
  }, "Routing capability-service evidence");
  const invoked = tryCatch(() => deps.evidenceBridge.putEvidence({
    serviceInstanceId,
    ...request.params,
  }));
  const deadline = invoked.ok
    ? await awaitResultDeadline(invoked.value, deps.timers, deps.requestDeadlineMs)
    : { result: err(invoked.error), settlement: Promise.resolve() };
  const settled = deadline.result;
  let result: CapabilityServiceIngressRouteResult;
  if (settled === undefined) result = responseError("deadline_exceeded", deadline.settlement);
  else if (!settled.ok) result = responseError("internal_error", deadline.settlement);
  else if (settled.value.kind === "rejected") {
    result = responseError(settled.value.reasonCode === "replay_conflict"
      ? "replay_conflict"
      : settled.value.reasonCode === "invalid_evidence"
        ? "invalid_params"
        : "precondition_failed", deadline.settlement);
  } else {
    result = {
      response: {
        managedRunId: settled.value.evidence.managedRunId,
        evidenceRef: settled.value.evidence.evidenceRef,
        contentHash: settled.value.evidence.contentHash,
        verificationLevel: settled.value.evidence.verificationLevel,
        ...(settled.value.evidence.expiresAtMs === undefined
          ? {}
          : { retainedUntilMs: settled.value.evidence.expiresAtMs }),
      },
      settlement: deadline.settlement,
    };
  }
  deps.logger.info({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    durationMs: Math.max(0, deps.clock.now() - startedAtMs),
  }, "Capability-service evidence request completed");
  return result;
}
