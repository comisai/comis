// SPDX-License-Identifier: Apache-2.0
/**
 * MEM-CTX-PORTS-14 / RES-PIT-31-4 — `LoggerOptions.disableRedaction`
 * behavioral test.
 *
 * Two assertions for the new optional flag:
 *   - default (disableRedaction omitted) → a known sensitive field
 *     ("password") is replaced with "[REDACTED]" in Pino's output.
 *   - disableRedaction=true → the same sensitive field appears verbatim
 *     and "[REDACTED]" is NOT emitted.
 *
 * Capture strategy: spy on `process.stdout.write`. `createLogger()` does
 * not accept a `destination` parameter, so we exercise the real public
 * factory and intercept the bytes Pino writes to file descriptor 1. This
 * mirrors the documented Pino default destination and proves the flag
 * end-to-end without bypassing the factory.
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

describe("LoggerOptions.disableRedaction (MEM-CTX-PORTS-14 / RES-PIT-31-4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default (disableRedaction omitted) — redacts known sensitive paths to [REDACTED]", () => {
    const cap = captureStdout();
    try {
      const logger = createLogger({
        name: "test-redaction-default",
        level: "info",
        // No disableRedaction — default redaction MUST apply.
      });
      logger.info({ password: "should-be-redacted" }, "test default redaction");
    } finally {
      cap.restore();
    }
    const output = cap.chunks.join("");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("should-be-redacted");
  });

  it("disableRedaction=true — sensitive field appears verbatim, no [REDACTED] placeholder", () => {
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
