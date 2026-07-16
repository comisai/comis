// SPDX-License-Identifier: Apache-2.0
/**
 * Test factories.
 *
 * `makeDeliveryService(overrides?: Partial<DeliveryServiceDeps>): DeliveryService`
 * provides a single canonical way to construct a DeliveryService for tests
 * with sensible no-op defaults; tests override individual deps via the
 * Partial parameter.
 *
 * Mirror of `test/support/mock-event-bus.ts` and `test/support/mock-logger.ts`
 * conventions (single function, named after the production type, Partial<X>
 * override pattern, returns the typed interface).
 */

import { vi } from "vitest";
import {
  createDeliveryService,
  createNoOpDeliveryQueue,
  type DeliveryService,
  type DeliveryServiceDeps,
  type HookRunner,
} from "@comis/core";

import { createMockEventBus } from "./mock-event-bus.js";
import { createMockLogger } from "./mock-logger.js";

/**
 * Build a no-op HookRunner for tests that don't care about hooks.
 *
 * All methods are `vi.fn()` spies resolving to no-op values. Build inline (do
 * NOT call `createHookRunner` — that would require a real PluginRegistry per
 * test, which is unnecessary overhead for the default case).
 *
 * The cast through `unknown` is intentional: HookRunner has ~14 methods
 * (including gateway/session hooks), and the default factory only needs
 * the ones the DeliveryService exercises (`runBeforeDelivery`,
 * `runAfterDelivery`). Tests that exercise other hooks override the field
 * via the Partial pattern.
 */
function makeNoopHookRunner(): HookRunner {
  const noop = vi.fn().mockResolvedValue(undefined);
  const noopWithObject = vi.fn().mockResolvedValue({});
  const base = {
    runBeforeAgentStart: noop,
    runBeforeToolCall: noop,
    runToolResultPersist: vi.fn().mockReturnValue(undefined),
    runBeforeCompaction: noop,
    runBeforeDelivery: noopWithObject,
    runAgentEnd: noop,
    runAfterToolCall: noop,
    runAfterCompaction: noop,
    runAfterDelivery: noop,
    runSessionStart: noop,
    runSessionEnd: noop,
    runGatewayStart: noop,
    runGatewayStop: noop,
  };
  return base as unknown as HookRunner;
}

/**
 * Construct a DeliveryService for tests. All deps default to no-op; pass
 * `overrides` to swap in real or assertion-bearing fakes.
 *
 * @example
 * // No-op service (all deps stubbed):
 * const service = makeDeliveryService();
 *
 * @example
 * // Capture hook calls:
 * const runBeforeDelivery = vi.fn().mockResolvedValue({});
 * const service = makeDeliveryService({
 *   hookRunner: { ...defaultHookRunner, runBeforeDelivery } as HookRunner,
 * });
 */
export function makeDeliveryService(
  overrides: Partial<DeliveryServiceDeps> = {},
): DeliveryService {
  return createDeliveryService({
    hookRunner: overrides.hookRunner ?? makeNoopHookRunner(),
    deliveryQueue: overrides.deliveryQueue ?? createNoOpDeliveryQueue(),
    logger: overrides.logger ?? createMockLogger(),
    eventBus: overrides.eventBus ?? createMockEventBus(),
    retryEngine: overrides.retryEngine,
    maxCharsOverride: overrides.maxCharsOverride,
    replyMode: overrides.replyMode,
    // in-flight outbound tracking is now internal to
    // createDeliveryService (see DeliveryService.drainInFlight). Tests that
    // need to observe in-flight Set state should drive it through the
    // production `deliverToChannel` surface and assert via `drainInFlight()`
    // telemetry rather than injecting a Set via deps.
  });
}
