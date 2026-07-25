// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams doctor-check unit tests.
 *
 * Teams is a webhook channel and is exempt from stale-reap, so its liveness
 * cannot ride the health monitor — `comis doctor` MUST answer "is my Teams bot
 * actually receiving?" directly. This check runs four probes:
 *
 *   1. creds-parse    — authMode-aware credential presence/resolution
 *   2. endpoint       — the mounted /channels/msteams/api/messages route
 *                       rejects an unauth request (401/405) vs is absent (404)
 *   3. recent-inbound — the INBOUND-ONLY lastInboundAt over the channel-status
 *                       RPC (never lastMessageAt, which an outbound send bumps —
 *                       a send-only bot must NOT read as healthy)
 *   4. tenant-present — config check
 *
 * The endpoint probe (fetch) and recent-inbound probe (channel-status RPC +
 * liveness guard) are mocked so the unit test never opens a socket.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { systemNowMs } from "@comis/core";
import type { AppConfig } from "@comis/core";
import type { DoctorContext, DoctorFinding } from "../types.js";

// The recent-inbound probe reads lastInboundAt over the channel-status RPC,
// gated on a liveness probe — both mocked (withClient throws under VITEST
// unless COMIS_CLI_E2E=true).
vi.mock("../../sync-tooling/daemon-guard.js", () => ({
  isDaemonRunning: vi.fn(async () => true),
}));
vi.mock("../../client/rpc-client.js", () => ({
  withClient: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
  callTyped: vi.fn(async () => ({ channels: [], timestamp: 0, enabled: true })),
}));

const daemonGuard = await import("../../sync-tooling/daemon-guard.js");
const rpcClient = await import("../../client/rpc-client.js");
const { msteamsHealthCheck } = await import("./msteams-health.js");

const baseContext: DoctorContext = {
  configPaths: ["/cfg/config.yaml"],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
  gatewayUrl: "http://127.0.0.1:4766",
};

/** Build a DoctorContext whose msteams config is exactly `msteams`. */
function contextWith(
  msteams: Record<string, unknown>,
  extra: Partial<DoctorContext> = {},
): DoctorContext {
  const config = { channels: { msteams } } as unknown as AppConfig;
  return {
    ...baseContext,
    config,
    configResolution: { foundPath: "/cfg/config.yaml", config },
    ...extra,
  };
}

/** Set the channel-status RPC payload (the msteams health entry) for one test. */
function mockChannelsHealth(channels: unknown[]): void {
  vi.mocked(rpcClient.callTyped).mockResolvedValue({
    channels,
    timestamp: systemNowMs(),
    enabled: true,
  } as never);
}

/** Set the endpoint probe's HTTP status (fetch) for one test. */
function mockEndpointStatus(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status }) as unknown as Response),
  );
}

function find(findings: DoctorFinding[], check: string): DoctorFinding | undefined {
  return findings.find((f) => f.check === check);
}

describe("msteamsHealthCheck", () => {
  beforeEach(() => {
    vi.mocked(daemonGuard.isDaemonRunning).mockReset();
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(true);
    vi.mocked(rpcClient.withClient).mockReset();
    vi.mocked(rpcClient.withClient).mockImplementation(
      async (fn: (c: unknown) => unknown) => fn({}),
    );
    vi.mocked(rpcClient.callTyped).mockReset();
    mockChannelsHealth([]);
    // Default endpoint: mounted-but-unauth (so creds/tenant tests don't depend
    // on a fetch mock they don't care about).
    mockEndpointStatus(401);
  });

  // -------------------------------------------------------------------------
  // Enabled / config gating
  // -------------------------------------------------------------------------

  it("skips with a single finding when the Teams channel is not enabled", async () => {
    const findings = await msteamsHealthCheck.run(contextWith({ enabled: false }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("skip");
  });

  it("names the config-resolution failure instead of claiming Teams is unconfigured", async () => {
    const findings = await msteamsHealthCheck.run({
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
  // Probe 1: creds-parse (authMode-aware)
  // -------------------------------------------------------------------------

  it("passes certificate-mode creds on certPath presence WITHOUT requiring appPassword", async () => {
    const findings = await msteamsHealthCheck.run(
      contextWith({
        enabled: true,
        authMode: "certificate",
        appId: "app-1",
        tenantId: "tenant-1",
        // A real, readable path on this host proves the readable branch.
        certPath: import.meta.url.replace("file://", ""),
      }),
    );
    const creds = find(findings, "Teams credentials");
    expect(creds?.status).toBe("pass");
  });

  it("passes managed-identity creds when managedIdentityClientId is present", async () => {
    const findings = await msteamsHealthCheck.run(
      contextWith({
        enabled: true,
        authMode: "managedIdentity",
        appId: "app-1",
        tenantId: "tenant-1",
        managedIdentityClientId: "mi-client-1",
      }),
    );
    const creds = find(findings, "Teams credentials");
    expect(creds?.status).toBe("pass");
  });

  it("fails secret-mode creds naming the exact unresolved appPassword reference", async () => {
    const config = {
      channels: {
        msteams: {
          enabled: true,
          authMode: "secret",
          appId: "app-1",
          tenantId: "tenant-1",
          appPassword: "${MSTEAMS_APP_PASSWORD}",
        },
      },
    } as unknown as AppConfig;
    const findings = await msteamsHealthCheck.run({
      ...baseContext,
      config,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        config,
        unresolvedRefs: [
          { path: "channels.msteams.appPassword", varName: "MSTEAMS_APP_PASSWORD" },
        ],
      },
    });
    const creds = find(findings, "Teams credentials");
    expect(creds?.status).toBe("fail");
    expect(creds?.message).toContain("MSTEAMS_APP_PASSWORD");
    expect(creds?.suggestion ?? "").not.toBe("");
  });

  // -------------------------------------------------------------------------
  // Probe 2: endpoint-reachable
  // -------------------------------------------------------------------------

  it("passes the endpoint probe when the ingress rejects an unauth request with 401", async () => {
    mockEndpointStatus(401);
    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, tenantId: "tenant-1", appPassword: "pw" }),
    );
    const endpoint = find(findings, "Teams endpoint");
    expect(endpoint?.status).toBe("pass");
  });

  it("fails the endpoint probe when the ingress route is absent (404)", async () => {
    mockEndpointStatus(404);
    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, tenantId: "tenant-1", appPassword: "pw" }),
    );
    const endpoint = find(findings, "Teams endpoint");
    expect(endpoint?.status).toBe("fail");
  });

  it("skips the endpoint probe when the gateway/daemon is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, tenantId: "tenant-1", appPassword: "pw" }),
    );
    const endpoint = find(findings, "Teams endpoint");
    expect(endpoint?.status).toBe("skip");
  });

  // -------------------------------------------------------------------------
  // Probe 3: recent-inbound (keys on lastInboundAt, NOT lastMessageAt)
  // -------------------------------------------------------------------------

  it("passes recent-inbound when lastInboundAt is within the recency window", async () => {
    mockChannelsHealth([
      { channelType: "msteams", lastInboundAt: systemNowMs() - 1000, lastMessageAt: systemNowMs() },
    ]);
    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, tenantId: "tenant-1", appPassword: "pw" }),
    );
    const inbound = find(findings, "Teams recent inbound");
    expect(inbound?.status).toBe("pass");
  });

  it("does NOT pass recent-inbound for a send-only bot (lastInboundAt null, lastMessageAt fresh)", async () => {
    // The trap: lastMessageAt is fresh (an outbound/proactive send), but the
    // ingress has received nothing. Keying on lastMessageAt would report this
    // dead ingress as healthy — the probe MUST read lastInboundAt.
    mockChannelsHealth([
      { channelType: "msteams", lastInboundAt: null, lastMessageAt: systemNowMs() },
    ]);
    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, tenantId: "tenant-1", appPassword: "pw" }),
    );
    const inbound = find(findings, "Teams recent inbound");
    expect(inbound?.status).not.toBe("pass");
    expect(inbound?.status).toBe("warn");
  });

  it("skips recent-inbound when the daemon is not reachable", async () => {
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(false);
    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, tenantId: "tenant-1", appPassword: "pw" }),
    );
    const inbound = find(findings, "Teams recent inbound");
    expect(inbound?.status).toBe("skip");
    // Did not even attempt the RPC.
    expect(rpcClient.withClient).not.toHaveBeenCalled();
  });

  it("does not surface channel-status RPC error content", async () => {
    vi.mocked(rpcClient.withClient).mockRejectedValueOnce(
      new Error("Authorization: Bearer PRIVATE_TEAMS_SENTINEL"),
    );

    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, tenantId: "tenant-1", appPassword: "pw" }),
    );
    const inbound = find(findings, "Teams recent inbound");

    expect(inbound?.status).toBe("skip");
    expect(inbound?.message).not.toContain("PRIVATE_TEAMS_SENTINEL");
  });

  // -------------------------------------------------------------------------
  // Probe 4: tenant-present
  // -------------------------------------------------------------------------

  it("fails the tenant probe when tenantId is missing", async () => {
    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, appPassword: "pw" }),
    );
    const tenant = find(findings, "Teams tenant");
    expect(tenant?.status).toBe("fail");
  });

  it("passes the tenant probe when tenantId is present", async () => {
    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, tenantId: "tenant-1", appPassword: "pw" }),
    );
    const tenant = find(findings, "Teams tenant");
    expect(tenant?.status).toBe("pass");
  });

  // -------------------------------------------------------------------------
  // Aggregate: an enabled channel yields all four probes.
  // -------------------------------------------------------------------------

  it("reports all four probes for an enabled channel", async () => {
    const findings = await msteamsHealthCheck.run(
      contextWith({ enabled: true, tenantId: "tenant-1", appPassword: "pw" }),
    );
    const checks = new Set(findings.map((f) => f.check));
    expect(checks).toEqual(
      new Set(["Teams credentials", "Teams endpoint", "Teams recent inbound", "Teams tenant"]),
    );
  });
});
