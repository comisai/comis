// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `emitDockerRestartPolicyWarn` -- the daemon boot-time WARN that
 * fires inside Docker containers to tell the operator the container needs
 * `--restart unless-stopped` (or compose `restart: unless-stopped`) for
 * wizard restart actions and gateway.* config-reload actions to recover.
 *
 * The probe is dependency-injected via `opts.isDocker` so we don't need to
 * `vi.mock` `@comis/infra` -- keeps the test deterministic and isolated.
 *
 * One additional behavior test (the "two-probe" block) drives the
 * retarget of `defaultIsDocker` from `@comis/infra` (single-probe
 * `/.dockerenv` only) to `@comis/core` (two-probe `/.dockerenv` +
 * `/proc/1/cgroup` regex). It mocks `node:fs` so the marker file is
 * absent BUT the cgroup contains a docker pattern -- behavior diverges
 * between the two impls and the test fails until the import retargets.
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
    // The redundant `module: "daemon" as const` field was deleted (parent
    // logger already binds module: "daemon"); the test no longer asserts on
    // it. errorKind/hint remain required-by-contract.
    expect(fields).toMatchObject({
      errorKind: "config",
    });
    expect(fields).not.toHaveProperty("module");
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

/**
 * Behavior gate: the daemon's default `isDocker` probe MUST be core's
 * two-probe impl (`/.dockerenv` + cgroup regex). Infra's deprecated
 * single-probe (`/.dockerenv` only) misses rootless / minimal images
 * that lack the marker file.
 *
 * We mock `node:fs` so that:
 *   - `existsSync("/.dockerenv")` returns false (marker absent)
 *   - `readFileSync("/proc/1/cgroup", "utf8")` returns a docker-pattern
 *     cgroup line (`0::/docker/<hash>`)
 *
 * Core's two-probe returns TRUE here (falls through to cgroup).
 * Infra's single-probe returns FALSE here (no marker, no fallback).
 *
 * We then call `emitDockerRestartPolicyWarn(logger, {})` -- NO
 * `isDocker` injection, so the default closure is exercised. The default
 * must be core's two-probe for the warning to fire.
 *
 * Uses `vi.doMock` + `vi.resetModules` + dynamic import to avoid affecting
 * the static-imported instance used by the tests above.
 */
describe("emitDockerRestartPolicyWarn default isDocker probe", () => {
  it("uses two-probe isDocker by default (detects via /proc/1/cgroup when /.dockerenv missing)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: (p: string) => p === "/.dockerenv" ? false : false,
      readFileSync: (p: string) =>
        p === "/proc/1/cgroup" ? "0::/docker/abc123def456" : "",
    }));

    const { emitDockerRestartPolicyWarn: emitDefault } = await import(
      "./setup-docker-restart-warn.js"
    );
    const logger = makeMockLogger();

    // No opts.isDocker -> the default closure runs.
    // Core's two-probe sees the cgroup match and returns true; infra's
    // single-probe sees no marker file and returns false (this test
    // would fail before the import retarget).
    emitDefault(logger as never);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = logger.warn.mock.calls[0]!;
    expect(fields).toMatchObject({ errorKind: "config" });

    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});
