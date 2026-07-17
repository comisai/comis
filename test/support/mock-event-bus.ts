// SPDX-License-Identifier: Apache-2.0
import { vi } from "vitest";
import type { TypedEventBus } from "@comis/core";

/**
 * Minimal TypedEventBus mock for unit and integration tests.
 * All methods are vi.fn() spies returning void/noop by default.
 * Tests customize via overrides or mockReturnValue().
 */
export function createMockEventBus(
  overrides?: Partial<TypedEventBus>,
): TypedEventBus {
  const unsub = vi.fn();
  const emit = overrides?.emit ?? vi.fn();
  return {
    emit,
    emitSafely: vi.fn((event, payload) => {
      emit(event, payload);
      return {
        hadListeners: false,
        failures: [],
        pendingFailures: Promise.resolve([]),
      };
    }),
    on: vi.fn(() => unsub),
    off: vi.fn(),
    once: vi.fn(() => unsub),
    removeAllListeners: vi.fn(),
    ...overrides,
  } as unknown as TypedEventBus;
}
