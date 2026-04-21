// SPDX-License-Identifier: Apache-2.0
import { vi } from "vitest";
import type { ComisLogger } from "@comis/infra";

/**
 * Create a mock ComisLogger for unit tests.
 *
 * All log methods are vi.fn() spies. `.child()` returns the SAME mock
 * instance (simpler tracking -- test can assert child was called, and
 * all log calls accumulate on one mock regardless of child depth).
 *
 * Matches the pattern established in agent-executor.test.ts.
 */
export function createMockLogger(overrides?: Partial<ComisLogger>): ComisLogger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock object shape doesn't match ComisLogger exactly
  const mock: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(),
    level: "debug",
    ...overrides,
  };
  mock.child.mockReturnValue(mock);
  return mock as ComisLogger;
}
