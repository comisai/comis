// SPDX-License-Identifier: Apache-2.0
/**
 * Execution-scoped side-effect accumulation for attempted tool invocations.
 *
 * Classification comes only from metadata registered under the exact emitted
 * tool name. Facts are recorded at invocation start and only ever change from
 * false to true, so later denial, failure, cancellation, or truncation cannot
 * erase evidence that a side-effecting capability was attempted.
 *
 * @module
 */

import { getToolMetadata } from "@comis/core";
import type {
  ExecutionSideEffectSummary,
  TrackedInvocationSideEffect,
} from "@comis/core";

const TRACKED_INVOCATION_SIDE_EFFECTS: ReadonlySet<TrackedInvocationSideEffect> = new Set([
  "scheduling",
  "outbound_delivery",
  "deferred_work",
]);

export function createBridgeSideEffectSummary(): ExecutionSideEffectSummary {
  return {
    schedulingCapabilityInvoked: false,
    outboundDeliveryCapabilityInvoked: false,
    deferredWorkCapabilityInvoked: false,
    unclassifiedInvocationObserved: false,
  };
}

function markInvocationCapabilities(
  summary: ExecutionSideEffectSummary,
  capabilities: readonly TrackedInvocationSideEffect[],
): void {
  for (const capability of capabilities) {
    switch (capability) {
      case "scheduling":
        summary.schedulingCapabilityInvoked = true;
        break;
      case "outbound_delivery":
        summary.outboundDeliveryCapabilityInvoked = true;
        break;
      case "deferred_work":
        summary.deferredWorkCapabilityInvoked = true;
        break;
      default: {
        const _exhaustive: never = capability;
        void _exhaustive;
      }
    }
  }
}

function isCapabilityList(value: unknown): value is readonly TrackedInvocationSideEffect[] {
  return Array.isArray(value) && value.every(
    (entry) => typeof entry === "string"
      && TRACKED_INVOCATION_SIDE_EFFECTS.has(entry as TrackedInvocationSideEffect),
  );
}

/** Record one attempted invocation without ever clearing facts from earlier turns. */
export function recordToolInvocationSideEffects(
  summary: ExecutionSideEffectSummary,
  toolName: string,
  args: unknown,
): void {
  const declaration = getToolMetadata(toolName)?.invocationSideEffects;
  if (declaration === undefined) {
    summary.unclassifiedInvocationObserved = true;
    return;
  }
  if (declaration.kind === "always") {
    if (!isCapabilityList(declaration.capabilities)) {
      summary.unclassifiedInvocationObserved = true;
      return;
    }
    markInvocationCapabilities(summary, declaration.capabilities);
    return;
  }
  if (declaration.kind !== "by_action" || declaration.parameter !== "action") {
    summary.unclassifiedInvocationObserved = true;
    return;
  }
  const entries = Object.entries(declaration.actions);
  if (entries.length === 0 || entries.some(([, capabilities]) => !isCapabilityList(capabilities))) {
    summary.unclassifiedInvocationObserved = true;
    return;
  }
  const action = typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as { action?: unknown }).action
    : undefined;
  const selected = typeof action === "string"
    ? entries.find(([candidate]) => candidate === action)?.[1]
    : undefined;
  const capabilities = selected ?? entries.flatMap(([, declared]) => declared);
  markInvocationCapabilities(summary, capabilities);
}
