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
  return {
    emit: vi.fn(),
    on: vi.fn(() => unsub),
    off: vi.fn(),
    once: vi.fn(() => unsub),
    removeAllListeners: vi.fn(),
    ...overrides,
  } as unknown as TypedEventBus;
}
