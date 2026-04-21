// SPDX-License-Identifier: Apache-2.0
/**
 * Test-only fault injector for the agent executor.
 *
 * Gated by the `COMIS_TEST_SILENT_FAIL_FLAG` environment variable (which
 * names a file path). When the env var is set AND that file exists, the
 * next call to tryInjectSilentFailure() consumes the file atomically and
 * returns a synthetic silent-LLM-failure result. This lets operators
 * validate the FINDING-2 retry/reuseSessionKey code path end-to-end
 * without waiting for Anthropic's real API to fail silently.
 *
 * Safety:
 * - Env var is ABSENT in every shipped config (installer, examples, docs).
 *   No code activation in production without an explicit operator action.
 * - Even with env var set, the file-flag must be explicitly created.
 * - `unlinkSync` is atomic on POSIX, so parallel execute() calls cannot
 *   both inject — at most one wins the race per armed flag.
 * - Flag auto-consumes on first hit; no stuck-state risk.
 *
 * Operational note — `PrivateTmp=yes`:
 *   The shipped systemd unit sets `PrivateTmp=yes`, so the daemon has an
 *   isolated `/tmp` namespace. An operator who `touch`es a path under
 *   `/tmp/` on the host will NOT make that file visible to the daemon —
 *   `unlinkSync` will report ENOENT. Always pick a flag path under the
 *   daemon's data dir (e.g. `/home/comis/.comis/.test-fault-flag`) so the
 *   operator shell and the daemon see the same file.
 *
 * @module
 */

import { unlinkSync } from "node:fs";

/** Shape returned when fault injection fires (otherwise `undefined`). */
export interface SilentFailureInjection {
  finishReason: "error";
  response: "";
  llmCalls: 0;
  stepsExecuted: 0;
}

/** Minimal logger interface for fault-injection diagnostics. */
interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * If the fault flag is armed, atomically consume it and return a synthetic
 * failure shape. Returns `undefined` in all other paths so the caller falls
 * through to real execution.
 *
 * @param logger - For WARN on successful injection, DEBUG on unexpected FS errors.
 * @param context - Extra fields attached to the WARN log (agentId, sessionKey, etc.).
 * @returns SilentFailureInjection when fault fired; undefined otherwise.
 */
export function tryInjectSilentFailure(
  logger: Logger,
  context: Record<string, unknown> = {},
): SilentFailureInjection | undefined {
  // eslint-disable-next-line no-restricted-syntax -- ops toggle read before SecretManager is initialized
  const faultFlag = process.env.COMIS_TEST_SILENT_FAIL_FLAG;
  if (!faultFlag) return undefined;

  // Optional scope gate: COMIS_TEST_SILENT_FAIL_SCOPE controls which
  // execute() calls are eligible to consume the flag.
  //   unset / "all"       — any execute() (parent or sub-agent) may fire
  //   "subagent"          — only sub-agent sessions may fire
  //   "parent"            — only non-sub-agent sessions may fire
  // Sub-agent session keys contain "sub-agent:" (see sub-agent-runner).
  // eslint-disable-next-line no-restricted-syntax -- ops toggle read before SecretManager is initialized
  const scope = process.env.COMIS_TEST_SILENT_FAIL_SCOPE;
  if (scope === "subagent" || scope === "parent") {
    const sessionKey = typeof context.sessionKey === "string" ? context.sessionKey : "";
    const isSubAgent = sessionKey.includes("sub-agent:") || sessionKey.includes("sub-agent-");
    const scopeMatches =
      (scope === "subagent" && isSubAgent) ||
      (scope === "parent" && !isSubAgent);
    if (!scopeMatches) return undefined;
  }

  try {
    // Atomic consume — if another execute() already unlinked, ENOENT is thrown
    // and we fall through to the catch.
    unlinkSync(faultFlag);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Flag not present (common case when env var set but flag not armed,
      // or another parallel execute() won the race) — normal execution.
      return undefined;
    }
    // Unexpected FS error (EACCES, EISDIR, ...) — log but don't block real
    // execution. Better to fail open than to break the daemon on a bad flag.
    logger.debug(
      {
        err,
        faultFlag,
        hint: "Unexpected error consuming COMIS_TEST_SILENT_FAIL_FLAG; falling through to real execution",
      },
      "Fault flag consume failed",
    );
    return undefined;
  }

  logger.warn(
    {
      ...context,
      hint: "COMIS_TEST_SILENT_FAIL_FLAG consumed -- this turn returns synthetic error for FINDING-2 retry-path testing",
      errorKind: "dependency" as const,
    },
    "Synthetic silent LLM failure injected for retry-path testing",
  );

  return {
    finishReason: "error",
    response: "",
    llmCalls: 0,
    stepsExecuted: 0,
  };
}
