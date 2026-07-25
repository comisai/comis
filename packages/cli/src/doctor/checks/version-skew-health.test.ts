// SPDX-License-Identifier: Apache-2.0
/**
 * CLI <-> daemon version-skew check unit tests.
 *
 * Detects version skew that can make CLI-side schema diagnostics disagree
 * with the running daemon.
 *
 * Covers:
 *   - PASS when CLI version == daemon version
 *   - WARN (patch-only mismatch) — versions differ but major.minor agree
 *   - WARN (major.minor mismatch) — stronger schema-parity message
 *   - graceful skip when the daemon is unreachable (no throw, never fails)
 *   - graceful skip when the daemon does not report a version (optional field)
 *   - never throws even when the RPC itself rejects
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { DoctorContext, DoctorFinding } from "../types.js";

// The check connects to the daemon via the gateway.status RPC, gated on a
// liveness probe — both are mocked so the unit test never opens a socket
// (withClient throws under VITEST unless COMIS_CLI_E2E=true).
vi.mock("../../sync-tooling/daemon-guard.js", () => ({
  isDaemonRunning: vi.fn(async () => true),
}));
vi.mock("../../client/rpc-client.js", () => ({
  withClient: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
  callTyped: vi.fn(async () => ({ version: "1.0.42" })),
}));

const daemonGuard = await import("../../sync-tooling/daemon-guard.js");
const rpcClient = await import("../../client/rpc-client.js");
const { versionSkewHealthCheck } = await import("./version-skew-health.js");

const baseContext: DoctorContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
  cliVersion: "1.0.42",
};

/** Convenience: set the daemon-reported gateway.status payload for one test. */
function mockDaemonVersion(payload: unknown): void {
  vi.mocked(rpcClient.callTyped).mockResolvedValue(payload as never);
}

describe("versionSkewHealthCheck", () => {
  beforeEach(() => {
    vi.mocked(daemonGuard.isDaemonRunning).mockReset();
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(true);
    vi.mocked(rpcClient.withClient).mockReset();
    vi.mocked(rpcClient.withClient).mockImplementation(
      async (fn: (c: unknown) => unknown) => fn({}),
    );
    vi.mocked(rpcClient.callTyped).mockReset();
    vi.mocked(rpcClient.callTyped).mockResolvedValue({ version: "1.0.42" } as never);
  });

  it("resolves to a defined result instead of throwing when the probe fails", async () => {
    await expect(
      versionSkewHealthCheck.run({ ...baseContext }),
    ).resolves.toBeDefined();
  });

  it("produces PASS when CLI and daemon versions match", async () => {
    mockDaemonVersion({ version: "2.30.0" });
    const findings = await versionSkewHealthCheck.run({
      ...baseContext,
      cliVersion: "2.30.0",
    });

    expect(findings).toHaveLength(1);
    const f = findings[0] as DoctorFinding;
    expect(f.status).toBe("pass");
    expect(f.message).toContain("2.30.0");
  });

  it("produces WARN on a patch-only version mismatch", async () => {
    mockDaemonVersion({ version: "2.30.5" });
    const findings = await versionSkewHealthCheck.run({
      ...baseContext,
      cliVersion: "2.30.1",
    });

    expect(findings).toHaveLength(1);
    const f = findings[0] as DoctorFinding;
    expect(f.status).toBe("warn");
    // Both versions named so the operator sees the exact skew.
    expect(f.message).toContain("2.30.1");
    expect(f.message).toContain("2.30.5");
  });

  it("produces a stronger warning on a major.minor mismatch", async () => {
    mockDaemonVersion({ version: "2.30.0" });
    const findings = await versionSkewHealthCheck.run({
      ...baseContext,
      cliVersion: "1.0.42",
    });

    expect(findings).toHaveLength(1);
    const f = findings[0] as DoctorFinding;
    expect(f.status).toBe("warn");
    expect(f.message).toContain("1.0.42");
    expect(f.message).toContain("2.30.0");
    expect(f.message.toLowerCase()).toContain("schema");
    expect(f.suggestion ?? "").not.toBe("");
  });

  it("skips gracefully when the daemon is unreachable", async () => {
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(false);
    const findings = await versionSkewHealthCheck.run({ ...baseContext });

    expect(findings).toHaveLength(1);
    const f = findings[0] as DoctorFinding;
    expect(f.status).toBe("skip");
    expect(f.repairable).toBe(false);
    // Did not even attempt the RPC.
    expect(rpcClient.withClient).not.toHaveBeenCalled();
  });

  it("skips gracefully when the daemon does not report a version", async () => {
    // `version` is optional on the gateway.status contract — this payload omits it.
    mockDaemonVersion({ pid: 1, uptime: 1, nodeVersion: "v22.0.0" });
    const findings = await versionSkewHealthCheck.run({ ...baseContext });

    expect(findings).toHaveLength(1);
    const f = findings[0] as DoctorFinding;
    expect(f.status).toBe("skip");
    expect(f.message.toLowerCase()).toContain("version");
  });

  it("skips gracefully (no throw) when the RPC itself rejects", async () => {
    vi.mocked(rpcClient.withClient).mockRejectedValue(
      new Error("Authorization: Bearer PRIVATE_VERSION_SENTINEL"),
    );
    const findings = await versionSkewHealthCheck.run({ ...baseContext });

    expect(findings).toHaveLength(1);
    const f = findings[0] as DoctorFinding;
    expect(f.status).toBe("skip");
    expect(f.message).not.toContain("PRIVATE_VERSION_SENTINEL");
  });

  it("does not surface a malformed daemon version", async () => {
    mockDaemonVersion({
      version: "Authorization: Bearer PRIVATE_DAEMON_VERSION_SENTINEL",
    });

    const findings = await versionSkewHealthCheck.run({ ...baseContext });
    const f = findings[0] as DoctorFinding;

    expect(f.status).toBe("skip");
    expect(f.message).toContain("valid semantic version");
    expect(f.message).not.toContain("PRIVATE_DAEMON_VERSION_SENTINEL");
  });

  it("does not surface an oversized numeric version", async () => {
    const oversizedVersion = `${"9".repeat(256)}.0.0`;
    mockDaemonVersion({ version: oversizedVersion });

    const findings = await versionSkewHealthCheck.run({ ...baseContext });
    const f = findings[0] as DoctorFinding;

    expect(f.status).toBe("skip");
    expect(f.message).not.toContain(oversizedVersion);
  });
});
