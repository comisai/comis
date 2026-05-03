// SPDX-License-Identifier: Apache-2.0
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
export function createMockLogger(overrides) {
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
        ...overrides,
    };
    mock.child.mockReturnValue(mock);
    return mock;
}
/**
 * Build a MockLogger that captures every call into an in-memory list.
 * `child(...)` returns the same instance — sufficient for OAuthTokenManager
 * which calls `agentLogger.child({ module: "oauth-token-manager" })` once
 * and then logs against the child.
 */
export function makeMockLogger() {
    let calls = [];
    const push = (level) => (payload, msg) => {
        calls.push({
            level,
            payload: payload,
            msg,
        });
    };
    const logger = {
        debug: vi.fn(push("debug")),
        info: vi.fn(push("info")),
        warn: vi.fn(push("warn")),
        error: vi.fn(push("error")),
        child: vi.fn(function () {
            return logger;
        }),
        _calls(level) {
            if (level === undefined)
                return calls.slice();
            return calls.filter((c) => c.level === level);
        },
        _reset() {
            calls = [];
        },
    };
    return logger;
}
