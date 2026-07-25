// SPDX-License-Identifier: Apache-2.0
import { fromPromise, tryCatch } from "@comis/shared";
import type { TypedEventBus } from "./bus.js";
import type { EventMap } from "./events.js";

type SubscriberFailurePhase = "fanout" | "sync" | "async";

interface SubscriberFailureSummary {
  readonly listenerIndex: number;
}

/** Dependencies for a content-free, failure-isolated lifecycle fan-out. */
export interface ObservationalEmissionDeps {
  readonly eventBus: Pick<TypedEventBus, "emitSafely">;
  readonly logger?: {
    readonly warn?: (fields: Record<string, unknown>, message: string) => unknown;
  };
}

/**
 * Record at most one warning for each fan-out phase. Subscriber exceptions can
 * contain user-authored content, so the log deliberately carries only the
 * closed event name, phase, count, and first listener index.
 */
function reportSubscriberFailures(
  deps: ObservationalEmissionDeps,
  event: keyof EventMap,
  phase: SubscriberFailurePhase,
  failures: readonly SubscriberFailureSummary[],
): void {
  const prepared = tryCatch(() => {
    if (failures.length === 0) return undefined;
    const warn = deps.logger?.warn;
    if (warn === undefined) return undefined;
    return {
      warn,
      receiver: deps.logger,
      fields: {
        eventName: event,
        subscriberFailurePhase: phase,
        subscriberFailureCount: failures.length,
        firstListenerIndex: failures[0]?.listenerIndex ?? -1,
        hint: "Inspect the named event subscriber; publisher control flow and later subscribers were preserved",
        errorKind: "internal" as const,
      },
    };
  });
  if (!prepared.ok || prepared.value === undefined) return;
  const preparedWarning = prepared.value;
  const invoked = tryCatch(() => Reflect.apply(
    preparedWarning.warn,
    preparedWarning.receiver,
    [preparedWarning.fields, "Observational event subscriber failed"],
  ) as unknown);
  if (!invoked.ok) return;
  const warning = tryCatch(() => Promise.resolve(invoked.value));
  if (!warning.ok) return;
  void fromPromise(warning.value);
}

/**
 * Fan out an observational lifecycle event without allowing a synchronous
 * throw, asynchronous rejection, or broken warning logger to affect the
 * publisher's authoritative control flow.
 */
export function emitObservationalEventSafely<K extends keyof EventMap>(
  deps: ObservationalEmissionDeps,
  event: K,
  payload: EventMap[K],
): void {
  const emitted = tryCatch(() => deps.eventBus.emitSafely(event, payload));
  if (!emitted.ok) {
    reportSubscriberFailures(deps, event, "fanout", [{ listenerIndex: -1 }]);
    return;
  }

  const syncFailures = tryCatch(() => emitted.value.failures);
  if (!syncFailures.ok) {
    reportSubscriberFailures(deps, event, "fanout", [{ listenerIndex: -1 }]);
    return;
  }
  reportSubscriberFailures(deps, event, "sync", syncFailures.value);
  const pendingFailures = tryCatch(() => emitted.value.pendingFailures);
  if (!pendingFailures.ok || pendingFailures.value === undefined) {
    if (!pendingFailures.ok) {
      reportSubscriberFailures(deps, event, "fanout", [{ listenerIndex: -1 }]);
    }
    return;
  }
  void fromPromise(pendingFailures.value).then((settled) => {
    if (!settled.ok) {
      reportSubscriberFailures(deps, event, "fanout", [{ listenerIndex: -1 }]);
      return;
    }
    reportSubscriberFailures(deps, event, "async", settled.value);
  });
}
