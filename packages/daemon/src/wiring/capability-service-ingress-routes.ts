// SPDX-License-Identifier: Apache-2.0
import type { z } from "zod";
import {
  CapabilityPutEvidenceRequestSchema,
  CapabilityReportRequestSchema,
  type CapabilityServiceErrorKind,
} from "@comis/capability-service-sdk";
import type { ClockPort, ComisLogger, TimerPort } from "@comis/core";
import { err, fromPromise, tryCatch, type Result } from "@comis/shared";
import type { ManagedRunEvidenceBridge } from "./managed-run-evidence-bridge.js";
import type { ManagedRunReportBridge } from "./managed-run-report-bridge.js";

export interface CapabilityServiceIngressRouteDeps {
  readonly reportBridge: ManagedRunReportBridge;
  readonly evidenceBridge: ManagedRunEvidenceBridge;
  readonly requestDeadlineMs: number;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly logger: ComisLogger;
}

export interface CapabilityServiceIngressRouteResult {
  readonly response: unknown;
  readonly errorKind?: CapabilityServiceErrorKind;
}

async function awaitResultDeadline<T>(
  operation: Promise<Result<T, Error>>,
  timers: TimerPort,
  deadlineMs: number,
): Promise<Result<T, Error> | undefined> {
  return new Promise((resolveDeadline) => {
    let settled = false;
    const timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveDeadline(undefined);
    }, deadlineMs);
    timer.unref();
    void fromPromise(operation).then((result) => {
      if (settled) return;
      settled = true;
      timer.cancel();
      resolveDeadline(result.ok ? result.value : err(result.error));
    });
  });
}

function responseError(errorKind: CapabilityServiceErrorKind): CapabilityServiceIngressRouteResult {
  return { response: undefined, errorKind };
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
  const settled = invoked.ok
    ? await awaitResultDeadline(invoked.value, deps.timers, deps.requestDeadlineMs)
    : err(invoked.error);
  let result: CapabilityServiceIngressRouteResult;
  if (settled === undefined) result = responseError("deadline_exceeded");
  else if (!settled.ok) result = responseError("internal_error");
  else if (settled.value.kind === "rejected") {
    result = responseError(settled.value.reasonCode === "replay_conflict"
      ? "replay_conflict"
      : settled.value.reasonCode === "invalid_report"
        ? "invalid_params"
        : "precondition_failed");
  } else {
    result = {
      response: {
        managedRunId: settled.value.report.managedRunId,
        serviceReportId: settled.value.report.serviceReportId,
        acceptedSequence: settled.value.report.sequence,
        retainedUntilMs: settled.value.report.retainedUntilMs,
      },
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
  const settled = invoked.ok
    ? await awaitResultDeadline(invoked.value, deps.timers, deps.requestDeadlineMs)
    : err(invoked.error);
  let result: CapabilityServiceIngressRouteResult;
  if (settled === undefined) result = responseError("deadline_exceeded");
  else if (!settled.ok) result = responseError("internal_error");
  else if (settled.value.kind === "rejected") {
    result = responseError(settled.value.reasonCode === "replay_conflict"
      ? "replay_conflict"
      : settled.value.reasonCode === "invalid_evidence"
        ? "invalid_params"
        : "precondition_failed");
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
    };
  }
  deps.logger.info({
    serviceInstanceId,
    managedRunId: request.params.managedRunId,
    durationMs: Math.max(0, deps.clock.now() - startedAtMs),
  }, "Capability-service evidence request completed");
  return result;
}
