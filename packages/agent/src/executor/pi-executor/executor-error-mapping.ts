// SPDX-License-Identifier: Apache-2.0
/**
 * Post-withSession error mapping — handles the lock-failure branch and the
 * `session_reset`-triggered destroy-session side effect that runs AFTER
 * `sessionAdapter.withSession(...)` returns. The catch-block inside the
 * `withSession` callback (caller's runPrompt error handling) lives in
 * `message-envelope.ts`; this helper handles the OUTER post-lock layer.
 *
 * Phase 42 split per EXEC-SPLIT-05/06.
 *
 * Closure-extraction protocol: state-by-parameter (Readonly<ErrorMappingState>).
 *
 * @module
 */

import type {
  SessionKey,
  ErrorKind,
} from "@comis/core";

import type { ExecutionResult } from "../types.js";
import type { PiExecutorDeps } from "./pi-executor-types.js";
import type { ComisSessionManager } from "../../session/comis-session-manager.js";

/**
 * Result shape from `sessionAdapter.withSession(...)`. Mirrors the
 * pi-coding-agent `Result<T, "locked" | …>` shape the production code
 * inspects via `.ok` / `.error` / `.value`.
 */
export type LockResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * State surface for post-withSession error mapping.
 *
 * The factory passes the per-execute `result` reference (already mutated
 * inside the `withSession` callback when applicable). On lock failure
 * this helper writes finishReason / response onto `state.result`.
 */
export interface ErrorMappingState {
  readonly result: ExecutionResult;
}

/**
 * Map the `withSession` Result into the final `ExecutionResult`.
 *
 * 1. If the session callback completed with `finishReason === "session_reset"`,
 *    destroy the session file AFTER the lock releases (no destroy-under-lock
 *    contention).
 * 2. If `withSession` itself failed (lock-busy / disk error / etc.),
 *    short-circuit the result to a generic "lock failed" error response.
 * 3. Otherwise return the successful inner result verbatim.
 *
 * @returns The final result (either the inner success value or the lock-error
 *   short-circuit). The caller is expected to return this directly from
 *   `execute()`.
 */
export async function finalizeLockResult(
  state: ErrorMappingState,
  deps: PiExecutorDeps,
  ctx: {
    readonly lockResult: LockResult<ExecutionResult>;
    readonly sessionAdapter: ComisSessionManager;
    readonly sessionKey: SessionKey;
  },
): Promise<ExecutionResult> {
  const { lockResult, sessionAdapter, sessionKey } = ctx;

  // Destroy session file after withSession releases the lock.
  // This must happen outside withSession to avoid file conflicts under lock.
  if (lockResult.ok && lockResult.value.finishReason === "session_reset") {
    await sessionAdapter.destroySession(sessionKey);
  }

  // Handle lock failure
  if (!lockResult.ok) {
    state.result.finishReason = "error";
    state.result.response =
      lockResult.error === "locked"
        ? "Session is currently locked. Please try again."
        : "Session access error.";
    deps.logger.warn(
      {
        error: lockResult.error,
        hint: "Session lock failed",
        errorKind: "resource" as ErrorKind,
      },
      "Session lock error",
    );
    return state.result;
  }

  return lockResult.value;
}
