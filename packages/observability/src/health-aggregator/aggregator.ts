// SPDX-License-Identifier: Apache-2.0
/**
 * Health aggregator (ALERT-01).
 *
 * Subscribes to health/safety events on the typed EventBus, classifies
 * each by errorKind, maintains a sliding window per errorKind, and
 * emits `health:budget_exceeded` ONCE per window cross — never per
 * subsequent event in the same window. After the window naturally
 * expires (now - windowStart >= windowMs), the latch resets and the
 * next threshold cross emits a fresh signal.
 *
 * Bounded: state is a Map<errorKind, { count, windowStart, latched }>.
 * Each errorKind in the policy table consumes O(1) memory. No external
 * dependencies. No timers — the window check happens lazily on each
 * inbound event (RESEARCH §Don't Hand-Roll).
 *
 * Cycles: Uses ComisLogger from @comis/core (structural contract) —
 * the aggregator NEVER imports createLogger from @comis/infra
 * (Pitfall 5; Phase 2 Option B pattern).
 *
 * @module
 */
import type { ComisLogger, EventMap, TypedEventBus } from "@comis/core";
import {
  resolveErrorKind,
  SYNTHETIC_ERROR_KIND_MAP,
  TYPED_ERROR_KIND_EVENTS,
  type AggregatorSubscribedEvent,
} from "./error-kind-map.js";
import type { AlertBudgetPolicy } from "./types.js";

export interface CreateHealthAggregatorDeps {
  readonly eventBus: TypedEventBus;
  readonly policy: AlertBudgetPolicy;
  readonly logger?: ComisLogger;
  /** Override "now" for deterministic tests. */
  readonly nowMs?: () => number;
}

interface WindowState {
  count: number;
  windowStart: number;
  latched: boolean;
}

/**
 * Attach subscribers and return an unsubscribe function. When
 * `policy.enabled === false` this is a no-op (returns an unsub that
 * does nothing).
 */
export function createHealthAggregator(deps: CreateHealthAggregatorDeps): () => void {
  if (!deps.policy.enabled) {
    return () => { /* no-op */ };
  }
  const now = deps.nowMs ?? Date.now;
  const state = new Map<string, WindowState>();

  function onEvent(
    eventName: AggregatorSubscribedEvent,
    payload: { readonly errorKind?: string } & Record<string, unknown>,
  ): void {
    const kind = resolveErrorKind(eventName, payload);
    if (kind === null) return;

    const threshold = deps.policy.thresholds[kind];
    if (!threshold) return; // unknown errorKind — no policy entry, skip (T-07-03-05)

    const t = now();
    let s = state.get(kind);
    if (!s || t - s.windowStart >= threshold.windowMs) {
      // Fresh window — natural expiry path. Reset count and latch.
      s = { count: 0, windowStart: t, latched: false };
      state.set(kind, s);
    }
    s.count++;

    if (!s.latched && s.count >= threshold.count) {
      s.latched = true;
      deps.eventBus.emit("health:budget_exceeded", {
        kind,
        count: s.count,
        windowMs: threshold.windowMs,
        timestamp: t,
      });
      deps.logger?.warn?.(
        {
          kind,
          count: s.count,
          windowMs: threshold.windowMs,
          errorKind: "internal" as const,
          hint: `Alert budget threshold crossed for errorKind=${kind}. Inspect daemon.log for upstream cause; tune observability.alertBudget if too noisy.`,
        },
        "health:budget_exceeded",
      );
    }
  }

  // Subscribe to all typed + synthetic events.
  const subscribed: Array<{ name: AggregatorSubscribedEvent; handler: (p: unknown) => void }> = [];
  const allEvents = [
    ...TYPED_ERROR_KIND_EVENTS,
    ...(Object.keys(SYNTHETIC_ERROR_KIND_MAP) as Array<keyof typeof SYNTHETIC_ERROR_KIND_MAP>),
  ] as ReadonlyArray<AggregatorSubscribedEvent>;

  for (const name of allEvents) {
    const handler = (payload: unknown) =>
      onEvent(name, payload as { readonly errorKind?: string } & Record<string, unknown>);
    deps.eventBus.on(
      name as keyof EventMap,
      handler as (p: EventMap[keyof EventMap]) => void,
    );
    subscribed.push({ name, handler });
  }

  return function unsubscribe(): void {
    for (const sub of subscribed) {
      deps.eventBus.off(
        sub.name as keyof EventMap,
        sub.handler as (p: EventMap[keyof EventMap]) => void,
      );
    }
    subscribed.length = 0;
    state.clear();
  };
}
