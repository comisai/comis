import { vi } from "vitest";
/**
 * Create a mock ComisLogger for unit tests.
 *
 * All log methods are vi.fn() spies. `.child()` returns the SAME mock
 * instance (simpler tracking -- test can assert child was called, and
 * all log calls accumulate on one mock regardless of child depth).
 *
 * Matches the pattern established in agent-executor.test.ts.
 */
export function createMockLogger() {
    const mock = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        audit: vi.fn(),
        child: vi.fn(),
        level: "debug",
    };
    mock.child.mockReturnValue(mock);
    return mock;
}
