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
export declare function createMockLogger(): ComisLogger;
