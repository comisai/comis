// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `emitDockerRestartPolicyWarn` -- the daemon boot-time WARN that
 * fires inside Docker containers to tell the operator the container needs
 * `--restart unless-stopped` (or compose `restart: unless-stopped`) for
 * wizard restart actions and gateway.* config-reload actions to recover.
 *
 * The probe is dependency-injected via `opts.isDocker` so we don't need to
 * `vi.mock` `@comis/infra` -- keeps the test deterministic and isolated.
 */

import { describe, it, expect, vi } from "vitest";
import { emitDockerRestartPolicyWarn } from "./setup-docker-restart-warn.js";

function makeMockLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
}

describe("emitDockerRestartPolicyWarn", () => {
  it("emits a single structured WARN when isDocker() returns true", () => {
    const logger = makeMockLogger();

    emitDockerRestartPolicyWarn(logger as never, { isDocker: () => true });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = logger.warn.mock.calls[0]!;
    expect(fields).toMatchObject({
      module: "daemon",
      errorKind: "config",
    });
    expect((fields as { hint: string }).hint).toContain("unless-stopped");
    expect((fields as { hint: string }).hint).toContain("docker inspect");
    expect(msg).toBe(
      "Running in Docker — restart policy required for config-reload operations",
    );
  });

  it("does NOT emit a WARN when isDocker() returns false", () => {
    const logger = makeMockLogger();

    emitDockerRestartPolicyWarn(logger as never, { isDocker: () => false });

    expect(logger.warn).not.toHaveBeenCalled();
    // No other side effects on the logger either.
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
