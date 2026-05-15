// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for finalizeLockResult — post-withSession outcome handling.
 *
 * Closure-extracted helper (state-first per EXEC-SPLIT-06): tests cover
 * the three branches (success, session_reset, lock failure) without
 * standing up the full executor.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { SessionKey } from "@comis/core";

import { finalizeLockResult, type LockResult } from "./executor-error-mapping.js";
import type { ExecutionResult } from "../types.js";
import type { PiExecutorDeps } from "./pi-executor.js";
import type { ComisSessionManager } from "../../session/comis-session-manager.js";

function makeResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    response: "",
    sessionKey: { tenantId: "t", channelId: "c", userId: "u" } as SessionKey,
    tokensUsed: { input: 0, output: 0, total: 0 },
    cost: { total: 0 },
    stepsExecuted: 0,
    llmCalls: 0,
    finishReason: "stop",
    ...overrides,
  };
}

function makeNoopLogger() {
  const logger: { [k: string]: unknown } = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, trace: () => {},
  };
  logger.child = () => logger;
  return logger;
}

const sessionKey = { tenantId: "t", channelId: "c", userId: "u" } as SessionKey;

describe("finalizeLockResult (EXEC-SPLIT-06)", () => {
  it("returns the inner success value unchanged when lock acquired and no reset", async () => {
    const result = makeResult({ finishReason: "stop", response: "ok" });
    const lockResult: LockResult<ExecutionResult> = { ok: true, value: result };
    const destroySession = vi.fn();
    const deps = { logger: makeNoopLogger() } as unknown as PiExecutorDeps;
    const sessionAdapter = { destroySession } as unknown as ComisSessionManager;

    const out = await finalizeLockResult({ result }, deps, { lockResult, sessionAdapter, sessionKey });

    expect(out).toBe(result);
    expect(out.finishReason).toBe("stop");
    expect(destroySession).not.toHaveBeenCalled();
  });

  it("destroys session file when finishReason is session_reset", async () => {
    const innerResult = makeResult({ finishReason: "session_reset" });
    const outerResult = makeResult();
    const lockResult: LockResult<ExecutionResult> = { ok: true, value: innerResult };
    const destroySession = vi.fn().mockResolvedValue(undefined);
    const deps = { logger: makeNoopLogger() } as unknown as PiExecutorDeps;
    const sessionAdapter = { destroySession } as unknown as ComisSessionManager;

    const out = await finalizeLockResult({ result: outerResult }, deps, { lockResult, sessionAdapter, sessionKey });

    expect(destroySession).toHaveBeenCalledWith(sessionKey);
    expect(out).toBe(innerResult);
  });

  it("maps lock failure (error=\"locked\") to friendly user message and finishReason=error", async () => {
    const result = makeResult();
    const lockResult: LockResult<ExecutionResult> = { ok: false, error: "locked" };
    const deps = { logger: makeNoopLogger() } as unknown as PiExecutorDeps;
    const sessionAdapter = { destroySession: vi.fn() } as unknown as ComisSessionManager;

    const out = await finalizeLockResult({ result }, deps, { lockResult, sessionAdapter, sessionKey });

    expect(out).toBe(result);
    expect(out.finishReason).toBe("error");
    expect(out.response).toContain("locked");
  });

  it("maps lock failure (other error) to generic session-access-error message", async () => {
    const result = makeResult();
    const lockResult: LockResult<ExecutionResult> = { ok: false, error: "disk_full" };
    const deps = { logger: makeNoopLogger() } as unknown as PiExecutorDeps;
    const sessionAdapter = { destroySession: vi.fn() } as unknown as ComisSessionManager;

    const out = await finalizeLockResult({ result }, deps, { lockResult, sessionAdapter, sessionKey });

    expect(out.finishReason).toBe("error");
    expect(out.response).toBe("Session access error.");
  });
});
