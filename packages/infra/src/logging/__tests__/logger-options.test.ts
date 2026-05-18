// SPDX-License-Identifier: Apache-2.0
/**
 * `LoggerOptions.disableRedaction` behavioral test.
 *
 * Two assertions for the new optional flag:
 *   - default (disableRedaction omitted) → a known sensitive field
 *     ("password") is MASKED (Plan 45-02: edge-keeping mask for strings
 *     ≥ 18 chars, "***" for shorter, "[REDACTED]" for non-string) and
 *     does NOT appear verbatim.
 *   - disableRedaction=true → the same sensitive field appears verbatim
 *     and no mask/sentinel is emitted.
 *
 * Capture strategy: spy on `process.stdout.write`. `createLogger()` does
 * not accept a `destination` parameter, so we exercise the real public
 * factory and intercept the bytes Pino writes to file descriptor 1. This
 * mirrors the documented Pino default destination and proves the flag
 * end-to-end without bypassing the factory.
 *
 * **Plan 45-02 deviation note (Rule 1 — test assertion shape):** the
 * default-redaction assertion was originally `toContain("[REDACTED]")`.
 * Plan 45-02 swaps the literal censor for a callback that emits the
 * edge-keeping mask for string values. The residency invariant TIGHTENS
 * (mask is stricter than the literal sentinel — it never re-leaks the
 * body) so the test's negative assertion (plaintext absent) is the
 * load-bearing check; the positive shape changes from "[REDACTED]" to
 * "the original plaintext does not appear".
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { createLogger } from "../logger.js";

/**
 * Spy on `process.stdout.write` and return a buffer of captured chunks +
 * a restore function. Pino's default destination is fd 1 (stdout), which
 * Node implements as `process.stdout.write` for synchronous one-line
 * JSON output. Capturing this is the most direct way to observe the
 * factory's redaction config without re-implementing it.
 */
function captureStdout(): {
  readonly chunks: string[];
  readonly restore: () => void;
} {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- write() overloads
    .mockImplementation(((chunk: any, ..._rest: any[]): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as never);
  return {
    chunks,
    restore: () => spy.mockRestore(),
  };
}

describe("LoggerOptions.disableRedaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default (disableRedaction omitted) — masks known sensitive paths and the plaintext does not appear", () => {
    // The censor is the Plan 45-02 callback: maskToken for strings, the
    // "[REDACTED]" sentinel for non-strings. The 18+-char password value
    // becomes an edge-keeping mask "should…0xyz"-like shape (NOT the
    // literal sentinel). Sub-18-char strings become "***".
    //
    // Also disable the regex transport for this test — the transport
    // runs in a worker thread and would buffer output asynchronously,
    // making the synchronous stdout spy miss the line. The censor is
    // what we want to assert anyway; the transport is the second-line
    // free-form regex pass and is covered by integration tests.
    const cap = captureStdout();
    try {
      const logger = createLogger({
        name: "test-redaction-default",
        level: "info",
        regexRedactInTransport: false, // synchronous stdout — no worker transport
        // No disableRedaction — default redaction MUST apply.
      });
      logger.info(
        { password: "should-be-redacted-canary-1234" }, // 29 chars
        "test default redaction",
      );
    } finally {
      cap.restore();
    }
    const output = cap.chunks.join("");
    // Plaintext must NOT appear anywhere in the captured output.
    expect(output).not.toContain("should-be-redacted-canary-1234");
    // Some censoring evidence is present — either an edge-keeping mask
    // shape ("…" U+2026 ellipsis) or a "***" sub-MIN_LENGTH sentinel.
    // For our 29-char input the mask shape is the edge form, so the
    // ellipsis is present.
    expect(output).toContain("…");
  });

  it("disableRedaction=true — sensitive field appears verbatim, no mask/sentinel", () => {
    const cap = captureStdout();
    try {
      const logger = createLogger({
        name: "test-redaction-disabled",
        level: "info",
        disableRedaction: true,
      });
      logger.info(
        { password: "should-be-VISIBLE-canary-9f3a" },
        "test disableRedaction=true",
      );
    } finally {
      cap.restore();
    }
    const output = cap.chunks.join("");
    expect(output).toContain("should-be-VISIBLE-canary-9f3a");
    expect(output).not.toContain("[REDACTED]");
  });
});
