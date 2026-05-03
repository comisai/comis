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
export declare function createMockLogger(overrides?: Partial<ComisLogger>): ComisLogger;
/**
 * One captured logger call. Captured in order so tests can assert on
 * sequencing as well as content (e.g., once-per-process semantics).
 */
export interface MockLoggerCall {
    /** Pino log level. */
    level: "debug" | "info" | "warn" | "error";
    /** Structured payload object passed as the first argument to the logger. */
    payload: Record<string, unknown>;
    /** Message string passed as the second argument. */
    msg: string;
}
/**
 * Mock logger interface — methods are real `vi.fn()`s so tests can also
 * assert with `toHaveBeenCalledWith` if preferred. The `_calls(level?)`
 * helper returns the captured list filtered by level (or all of them when
 * no level given) for substring/payload-shape assertions.
 */
export interface MockLogger {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    child: ReturnType<typeof vi.fn>;
    /**
     * Return all captured calls (when level is undefined) or only those at the
     * given level. The returned array is a defensive copy.
     */
    _calls(level?: "debug" | "info" | "warn" | "error"): MockLoggerCall[];
    /** Reset captured calls. Useful between sub-tests in a describe block. */
    _reset(): void;
}
/**
 * Build a MockLogger that captures every call into an in-memory list.
 * `child(...)` returns the same instance — sufficient for OAuthTokenManager
 * which calls `agentLogger.child({ module: "oauth-token-manager" })` once
 * and then logs against the child.
 */
export declare function makeMockLogger(): MockLogger;
