// SPDX-License-Identifier: Apache-2.0
import type { ComisLogger, EventMap, TypedEventBus } from "@comis/core";
import { emitObservationalEventSafely } from "@comis/core";

interface ObservationalEventDeps {
  eventBus: TypedEventBus;
  logger: ComisLogger;
}

/**
 * Fan out a lifecycle notification without letting a subscriber alter the
 * publisher's control flow or starve later observers.
 */
export function emitObservationalEvent<K extends keyof EventMap>(
  deps: ObservationalEventDeps,
  event: K,
  payload: EventMap[K],
): void {
  emitObservationalEventSafely(deps, event, payload);
}
