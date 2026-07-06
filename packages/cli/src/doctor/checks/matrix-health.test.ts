// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix doctor-check unit tests.
 *
 * Matrix is a polling channel — there is no webhook endpoint to probe — so
 * `comis doctor` answers "is my Matrix bot healthy?" with polling-flavored
 * probes instead of the webhook endpoint / recent-inbound probes:
 *
 *   1. creds-parse          — homeserver + token/password presence and
 *                             resolution (an unresolved ${MATRIX_ACCESS_TOKEN}
 *                             ref is named, never the token value).
 *   2. reachability         — the live adapter state + error over the
 *                             channel-status RPC (the daemon owns the adapter).
 *   3. e2ee backend         — end-to-end encryption is on by default, so an
 *                             enabled channel whose RPC entry carries no
 *                             verification block means the crypto backend
 *                             failed to initialize.
 *   4. device-verification  — the cross-signing / device-verified booleans over
 *                             RPC. Unverified is a supported posture (loud, not
 *                             fatal), so it warns rather than fails.
 *   5. state-dir            — the durable state directory is best-effort
 *                             writable (a warn, never a hard fail on split-host).
 *
 * The RPC-dependent probes read booleans over the channel-status RPC (mocked so
 * the unit test never opens a socket) and degrade to `skip` when the daemon is
 * unreachable — never a false `pass`. The verification read is booleans only:
 * no key material is ever touched or asserted.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { systemNowMs } from "@comis/core";
import type { AppConfig } from "@comis/core";
import type { DoctorContext, DoctorFinding } from "../types.js";

// The reachability / e2ee / device-verification probes read the live channel
// state over the channel-status RPC, gated on a liveness probe — both mocked
// (withClient throws under VITEST unless COMIS_CLI_E2E=true).
vi.mock("../../sync-tooling/daemon-guard.js", () => ({
  isDaemonRunning: vi.fn(async () => true),
}));
vi.mock("../../client/rpc-client.js", () => ({
  withClient: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
  callTyped: vi.fn(async () => ({ channels: [], timestamp: 0, enabled: true })),
}));

const daemonGuard = await import("../../sync-tooling/daemon-guard.js");
const rpcClient = await import("../../client/rpc-client.js");
const { matrixHealthCheck } = await import("./matrix-health.js");

const baseContext: DoctorContext = {
  configPaths: ["/cfg/config.yaml"],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
  gatewayUrl: "http://127.0.0.1:4766",
};

/** Build a DoctorContext whose matrix config is exactly `matrix`. */
function contextWith(
  matrix: Record<string, unknown>,
  extra: Partial<DoctorContext> = {},
): DoctorContext {
  const config = { channels: { matrix } } as unknown as AppConfig;
  return {
    ...baseContext,
    config,
    configResolution: { foundPath: "/cfg/config.yaml", config },
    ...extra,
  };
}

/** Set the channel-status RPC payload (the matrix health entry) for one test. */
function mockChannelsHealth(channels: unknown[]): void {
  vi.mocked(rpcClient.callTyped).mockResolvedValue({
    channels,
    timestamp: systemNowMs(),
    enabled: true,
  } as never);
}

function find(findings: DoctorFinding[], check: string): DoctorFinding | undefined {
  return findings.find((f) => f.check === check);
}

/** Credentials that pass validateMatrixCredentials (homeserver + token). */
const RESOLVED_CREDS = {
  homeserverUrl: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "syt_resolved_token",
};

describe("matrixHealthCheck", () => {
  beforeEach(() => {
    vi.mocked(daemonGuard.isDaemonRunning).mockReset();
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(true);
    vi.mocked(rpcClient.withClient).mockReset();
    vi.mocked(rpcClient.withClient).mockImplementation(
      async (fn: (c: unknown) => unknown) => fn({}),
    );
    vi.mocked(rpcClient.callTyped).mockReset();
    mockChannelsHealth([]);
  });

  // -------------------------------------------------------------------------
  // Enabled / config gating
  // -------------------------------------------------------------------------

  it("skips with a single finding when the Matrix channel is not enabled", async () => {
    const findings = await matrixHealthCheck.run(contextWith({ enabled: false }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("skip");
  });

  it("names the config-resolution failure instead of claiming Matrix is unconfigured", async () => {
    const findings = await matrixHealthCheck.run({
      ...baseContext,
      config: undefined,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        unresolvedRefs: [{ path: "gateway.tokens[0].secret", varName: "COMIS_GATEWAY_TOKEN" }],
        validationIssues: ["gateway.tokens.0.secret: Too small: expected string to have >=32 characters"],
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("skip");
    expect(findings[0]?.message).toContain("COMIS_GATEWAY_TOKEN");
  });

  // -------------------------------------------------------------------------
  // Probe 1: creds-parse
  // -------------------------------------------------------------------------

  it("fails creds naming the exact unresolved access-token reference (never the value)", async () => {
    const config = {
      channels: {
        matrix: {
          enabled: true,
          homeserverUrl: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "${MATRIX_ACCESS_TOKEN}",
        },
      },
    } as unknown as AppConfig;
    const findings = await matrixHealthCheck.run({
      ...baseContext,
      config,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        config,
        unresolvedRefs: [
          { path: "channels.matrix.accessToken", varName: "MATRIX_ACCESS_TOKEN" },
        ],
      },
    });
    const creds = find(findings, "Matrix credentials");
    expect(creds?.status).toBe("fail");
    expect(creds?.message).toContain("MATRIX_ACCESS_TOKEN");
    // The token VALUE is never echoed — only the ${VAR} name and the path.
    expect(creds?.message).not.toContain("syt_");
    expect(creds?.suggestion ?? "").not.toBe("");
  });

  it("fails creds naming an unresolved password reference (the password-login path)", async () => {
    const config = {
      channels: {
        matrix: {
          enabled: true,
          homeserverUrl: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "${MATRIX_PASSWORD}",
        },
      },
    } as unknown as AppConfig;
    const findings = await matrixHealthCheck.run({
      ...baseContext,
      config,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        config,
        unresolvedRefs: [{ path: "channels.matrix.password", varName: "MATRIX_PASSWORD" }],
      },
    });
    const creds = find(findings, "Matrix credentials");
    expect(creds?.status).toBe("fail");
    expect(creds?.message).toContain("MATRIX_PASSWORD");
    // The password VALUE is never echoed — only the ${VAR} name and the path.
    expect(creds?.suggestion ?? "").not.toBe("");
  });

  it("fails creds naming an unresolved recovery-key reference", async () => {
    const config = {
      channels: {
        matrix: {
          enabled: true,
          homeserverUrl: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "syt_resolved_token",
          recoveryKey: "${MATRIX_RECOVERY_KEY}",
        },
      },
    } as unknown as AppConfig;
    const findings = await matrixHealthCheck.run({
      ...baseContext,
      config,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        config,
        unresolvedRefs: [{ path: "channels.matrix.recoveryKey", varName: "MATRIX_RECOVERY_KEY" }],
      },
    });
    const creds = find(findings, "Matrix credentials");
    expect(creds?.status).toBe("fail");
    expect(creds?.message).toContain("MATRIX_RECOVERY_KEY");
  });

  it("passes creds when the homeserver and token resolve", async () => {
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    const creds = find(findings, "Matrix credentials");
    expect(creds?.status).toBe("pass");
  });

  it("fails creds when the homeserver URL is missing", async () => {
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, userId: "@bot:example.org", accessToken: "tok" }),
    );
    const creds = find(findings, "Matrix credentials");
    expect(creds?.status).toBe("fail");
  });

  // -------------------------------------------------------------------------
  // Probe 2: reachability (live adapter state over RPC)
  // -------------------------------------------------------------------------

  it("passes reachability when the adapter state is healthy", async () => {
    mockChannelsHealth([{ channelType: "matrix", state: "healthy", error: null }]);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    const reach = find(findings, "Matrix reachability");
    expect(reach?.status).toBe("pass");
  });

  it("fails reachability when the adapter is errored, surfacing the error", async () => {
    mockChannelsHealth([
      { channelType: "matrix", state: "errored", error: "sync request rejected: 401" },
    ]);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    const reach = find(findings, "Matrix reachability");
    expect(reach?.status).toBe("fail");
    expect(reach?.message).toContain("401");
  });

  it("warns reachability when no adapter entry is reported (enabled but not running)", async () => {
    mockChannelsHealth([]);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    const reach = find(findings, "Matrix reachability");
    expect(reach?.status).toBe("warn");
  });

  // -------------------------------------------------------------------------
  // Probe 3: e2ee backend loads (e2ee defaults true → gate on !== false)
  // -------------------------------------------------------------------------

  it("warns the e2ee-backend probe when e2ee is on but no verification block is present", async () => {
    // e2ee omitted (defaults true) + entry present WITHOUT verification =
    // the crypto backend failed to initialize.
    mockChannelsHealth([{ channelType: "matrix", state: "healthy", error: null }]);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    const e2ee = find(findings, "Matrix e2ee");
    expect(e2ee?.status).toBe("warn");
  });

  it("passes the e2ee-backend probe when a verification block is present", async () => {
    mockChannelsHealth([
      {
        channelType: "matrix",
        state: "healthy",
        error: null,
        verification: { crossSigningReady: true, deviceVerified: true },
      },
    ]);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    const e2ee = find(findings, "Matrix e2ee");
    expect(e2ee?.status).toBe("pass");
  });

  it("skips the e2ee-backend probe when e2ee is disabled", async () => {
    mockChannelsHealth([{ channelType: "matrix", state: "healthy", error: null }]);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, e2ee: false, ...RESOLVED_CREDS }),
    );
    const e2ee = find(findings, "Matrix e2ee");
    expect(e2ee?.status).toBe("skip");
  });

  // -------------------------------------------------------------------------
  // Probe 4: device-verification (booleans only; unverified is loud not fatal)
  // -------------------------------------------------------------------------

  it("warns device-verification when the device is unverified", async () => {
    mockChannelsHealth([
      {
        channelType: "matrix",
        state: "healthy",
        error: null,
        verification: { crossSigningReady: false, deviceVerified: false },
      },
    ]);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    const verify = find(findings, "Matrix device verification");
    expect(verify?.status).toBe("warn");
    // Unverified must NEVER be fatal — it is a supported posture.
    expect(verify?.status).not.toBe("fail");
  });

  it("passes device-verification when cross-signing and the device are both verified", async () => {
    mockChannelsHealth([
      {
        channelType: "matrix",
        state: "healthy",
        error: null,
        verification: { crossSigningReady: true, deviceVerified: true },
      },
    ]);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    const verify = find(findings, "Matrix device verification");
    expect(verify?.status).toBe("pass");
  });

  // -------------------------------------------------------------------------
  // Daemon-down: RPC-dependent probes skip (never a false pass)
  // -------------------------------------------------------------------------

  it("skips the RPC-dependent probes and does not open the RPC when the daemon is down", async () => {
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(false);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    expect(find(findings, "Matrix reachability")?.status).toBe("skip");
    expect(find(findings, "Matrix e2ee")?.status).toBe("skip");
    expect(find(findings, "Matrix device verification")?.status).toBe("skip");
    // Never even attempted the RPC.
    expect(rpcClient.withClient).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Probe 5: state-dir writable (best-effort — warn, never a hard fail)
  // -------------------------------------------------------------------------

  it("never hard-fails the state-directory probe for an absent directory", async () => {
    const findings = await matrixHealthCheck.run(
      contextWith({
        enabled: true,
        ...RESOLVED_CREDS,
        stateDir: "/nonexistent/matrix-state-does-not-exist",
      }),
    );
    const stateDir = find(findings, "Matrix state directory");
    expect(stateDir).toBeDefined();
    expect(stateDir?.status).not.toBe("fail");
  });

  // -------------------------------------------------------------------------
  // Aggregate: an enabled channel yields all five probes.
  // -------------------------------------------------------------------------

  it("reports all five probes for an enabled channel", async () => {
    mockChannelsHealth([{ channelType: "matrix", state: "healthy", error: null }]);
    const findings = await matrixHealthCheck.run(
      contextWith({ enabled: true, ...RESOLVED_CREDS }),
    );
    const checks = new Set(findings.map((f) => f.check));
    expect(checks).toEqual(
      new Set([
        "Matrix credentials",
        "Matrix reachability",
        "Matrix e2ee",
        "Matrix device verification",
        "Matrix state directory",
      ]),
    );
  });
});
