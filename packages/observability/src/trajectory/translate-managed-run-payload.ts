// SPDX-License-Identifier: Apache-2.0
/**
 * Managed-run (capability-service) trajectory payload translators.
 *
 * Extracted from `translate-payload.ts` so that module stays under the
 * file-size cap: `translatePayload` early-returns through
 * `isManagedRunTrajectoryEvent` into `translateManagedRunPayload` here, which
 * keeps those event names out of its exhaustive switch.
 *
 * SECURITY INVARIANT: these translators are the primary control over which
 * managed-run fields cross into the persisted trajectory. Only content-free
 * identifiers and closed enums are forwarded — never a report body, an evidence
 * body, a subject digest, an external key value, or the `timestamp` (the
 * recorder envelope's `ts` carries timing). `sanitizeForPersistence` is a
 * defense-in-depth backstop, not a substitute for omission here.
 *
 * @module
 */
import type { TrajectoryBridgedEventName } from "./event-bus-bridge.js";

const MANAGED_RUN_EVENT_NAMES = [
  "managed_run:attention_opened",
  "managed_run:attention_resolved",
  "managed_run:evidence_accepted",
  "managed_run:evidence_rejected",
  "managed_run:revoked",
] as const;

/** The EventBus names this module translates (a subset of the bridge mapping keys). */
export type ManagedRunTrajectoryEventName = (typeof MANAGED_RUN_EVENT_NAMES)[number];

const MANAGED_RUN_EVENT_SET = new Set<string>(MANAGED_RUN_EVENT_NAMES);

/** Narrows a bridged event name to the managed-run subset this module owns. */
export function isManagedRunTrajectoryEvent(
  eventName: TrajectoryBridgedEventName,
): eventName is ManagedRunTrajectoryEventName {
  return MANAGED_RUN_EVENT_SET.has(eventName);
}

/** Project one managed-run EventBus payload into its content-free trajectory data. */
export function translateManagedRunPayload(
  eventName: ManagedRunTrajectoryEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    case "managed_run:attention_opened":
    case "managed_run:attention_resolved":
      return {
        managedRunId: payload.managedRunId,
        serviceInstanceId: payload.serviceInstanceId,
        attentionId: payload.attentionId,
      };
    case "managed_run:evidence_accepted":
      return {
        managedRunId: payload.managedRunId,
        serviceInstanceId: payload.serviceInstanceId,
        evidenceRef: payload.evidenceRef,
        verificationLevel: payload.verificationLevel,
        deliveryKind: payload.deliveryKind,
      };
    case "managed_run:evidence_rejected":
      return {
        ...(payload.managedRunId === undefined ? {} : { managedRunId: payload.managedRunId }),
        ...(payload.serviceInstanceId === undefined ? {} : { serviceInstanceId: payload.serviceInstanceId }),
        reasonCode: payload.reasonCode,
      };
    case "managed_run:revoked":
      return {
        managedRunId: payload.managedRunId,
        serviceInstanceId: payload.serviceInstanceId,
        reasonCode: payload.reasonCode,
      };
    default: {
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}
