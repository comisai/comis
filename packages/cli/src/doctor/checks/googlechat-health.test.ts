// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat doctor-check unit tests.
 *
 * Google Chat defaults to a Pub/Sub pull transport and offers an opt-in webhook
 * mode; a webhook ingress is stale-reap-exempt, so `comis doctor` MUST answer "is
 * my Google Chat app actually receiving?" directly. This check runs four probes:
 *
 *   1. creds-parse    — the service-account key parses into a key JSON carrying
 *                       private_key + client_email. SECRET-SAFE: the raw key text
 *                       never appears in any finding.
 *   2. inbound path   — pubsub mode: the pull subscription is configured (a blank
 *                       subscription names roles/pubsub.subscriber); webhook mode:
 *                       the mounted /channels/googlechat route rejects an unauth
 *                       request (401/405) vs is absent (404).
 *   3. recent-inbound — the INBOUND-ONLY lastInboundAt over the channel-status RPC
 *                       (never a conflated last-activity signal).
 *   4. allowlist lint — an email-shaped allowFrom entry WARNs, steering the
 *                       operator toward the immutable users/{id}.
 *
 * The webhook endpoint probe (fetch) and recent-inbound probe (channel-status RPC
 * + liveness guard) are mocked so the unit test never opens a socket.
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
const { googlechatHealthCheck } = await import("./googlechat-health.js");

const baseContext: DoctorContext = {
  configPaths: ["/cfg/config.yaml"],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
  gatewayUrl: "http://127.0.0.1:4766",
};

/**
 * A distinctive private-key marker. The secret-safe assertions verify it NEVER
 * appears in any finding message or suggestion.
 */
const SECRET_MARKER = "PRIVATE-KEY-MATERIAL-MUST-NOT-LEAK-9f83a2c1";

/** A well-formed service-account key JSON string carrying the two required fields. */
const validSaKey = JSON.stringify({
  type: "service_account",
  project_id: "test-project",
  private_key: `-----BEGIN PRIVATE KEY-----\n${SECRET_MARKER}\n-----END PRIVATE KEY-----\n`,
  client_email: "bot@test-project.iam.gserviceaccount.com",
});

/**
 * Build a DoctorContext whose googlechat config is exactly `googlechat`.
 * `configExtra` merges additional top-level config sections (e.g. the global
 * autoReplyEngine block the group-activation probe reads).
 */
function contextWith(
  googlechat: Record<string, unknown>,
  extra: Partial<DoctorContext> = {},
  configExtra: Record<string, unknown> = {},
): DoctorContext {
  const config = { channels: { googlechat }, ...configExtra } as unknown as AppConfig;
  return {
    ...baseContext,
    config,
    configResolution: { foundPath: "/cfg/config.yaml", config },
    ...extra,
  };
}

/** Set the channel-status RPC payload (the googlechat health entry) for one test. */
function mockChannelsHealth(channels: unknown[]): void {
  vi.mocked(rpcClient.callTyped).mockResolvedValue({
    channels,
    timestamp: systemNowMs(),
    enabled: true,
  } as never);
}

/** Set the webhook endpoint probe's HTTP status (fetch) for one test. */
function mockEndpointStatus(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status }) as unknown as Response),
  );
}

function find(findings: DoctorFinding[], check: string): DoctorFinding | undefined {
  return findings.find((f) => f.check === check);
}

describe("googlechatHealthCheck", () => {
  beforeEach(() => {
    vi.mocked(daemonGuard.isDaemonRunning).mockReset();
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(true);
    vi.mocked(rpcClient.withClient).mockReset();
    vi.mocked(rpcClient.withClient).mockImplementation(
      async (fn: (c: unknown) => unknown) => fn({}),
    );
    vi.mocked(rpcClient.callTyped).mockReset();
    mockChannelsHealth([]);
    // Default webhook endpoint: mounted-but-unauth (so pubsub/creds tests don't
    // depend on a fetch mock they don't care about).
    mockEndpointStatus(401);
  });

  // -------------------------------------------------------------------------
  // Enabled / config gating
  // -------------------------------------------------------------------------

  it("skips with a single finding when the Google Chat channel is not enabled", async () => {
    const findings = await googlechatHealthCheck.run(contextWith({ enabled: false }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("skip");
  });

  it("names the config-resolution failure instead of claiming Google Chat is unconfigured", async () => {
    const findings = await googlechatHealthCheck.run({
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
  // Probe 1: creds-parse (SA key) — SECRET-SAFE
  // -------------------------------------------------------------------------

  it("passes creds-parse when the service-account key JSON carries private_key + client_email", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
      }),
    );
    const creds = find(findings, "Google Chat credentials");
    expect(creds?.status).toBe("pass");
  });

  it("fails creds-parse naming 'client_email' when the key JSON is missing that field", async () => {
    const missingClientEmail = JSON.stringify({
      type: "service_account",
      private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
    });
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: missingClientEmail,
        subscriptionName: "projects/test-project/subscriptions/comis",
      }),
    );
    const creds = find(findings, "Google Chat credentials");
    expect(creds?.status).toBe("fail");
    expect(creds?.message).toContain("client_email");
  });

  it("fails creds-parse on malformed JSON without echoing the raw value", async () => {
    const malformed = `{not valid json ${SECRET_MARKER}`;
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: malformed,
        subscriptionName: "projects/test-project/subscriptions/comis",
      }),
    );
    const creds = find(findings, "Google Chat credentials");
    expect(creds?.status).toBe("fail");
    // SECRET-SAFE: the raw (malformed) key text is never placed in the message.
    expect(creds?.message ?? "").not.toContain(SECRET_MARKER);
    expect(creds?.suggestion ?? "").not.toContain(SECRET_MARKER);
  });

  it("fails creds-parse naming the exact unresolved ${GOOGLECHAT_SA_KEY} reference", async () => {
    const config = {
      channels: {
        googlechat: {
          enabled: true,
          mode: "pubsub",
          serviceAccountKey: "${GOOGLECHAT_SA_KEY}",
          subscriptionName: "projects/test-project/subscriptions/comis",
        },
      },
    } as unknown as AppConfig;
    const findings = await googlechatHealthCheck.run({
      ...baseContext,
      config,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        config,
        unresolvedRefs: [
          { path: "channels.googlechat.serviceAccountKey", varName: "GOOGLECHAT_SA_KEY" },
        ],
      },
    });
    const creds = find(findings, "Google Chat credentials");
    expect(creds?.status).toBe("fail");
    expect(creds?.message).toContain("GOOGLECHAT_SA_KEY");
    expect(creds?.suggestion ?? "").not.toBe("");
  });

  it("never echoes the raw service-account key into ANY finding (secret-safe)", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
        allowFrom: ["ops@example.com"],
      }),
    );
    for (const f of findings) {
      expect(f.message).not.toContain(SECRET_MARKER);
      expect(f.suggestion ?? "").not.toContain(SECRET_MARKER);
    }
  });

  // -------------------------------------------------------------------------
  // Probe 2: inbound path (mode branch)
  // -------------------------------------------------------------------------

  it("passes the inbound-path probe in pubsub mode when subscriptionName is set", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
      }),
    );
    const inbound = find(findings, "Google Chat inbound path");
    expect(inbound?.status).toBe("pass");
  });

  it("fails the inbound-path probe in pubsub mode with a blank subscription, naming roles/pubsub.subscriber", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
      }),
    );
    const inbound = find(findings, "Google Chat inbound path");
    expect(inbound?.status).toBe("fail");
    const text = `${inbound?.message ?? ""} ${inbound?.suggestion ?? ""}`;
    expect(text).toContain("roles/pubsub.subscriber");
  });

  it("passes the inbound-path probe in webhook mode when the ingress rejects an unauth request with 401", async () => {
    mockEndpointStatus(401);
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "webhook",
        serviceAccountKey: validSaKey,
        audience: "1234567890",
      }),
    );
    const inbound = find(findings, "Google Chat inbound path");
    expect(inbound?.status).toBe("pass");
  });

  it("fails the inbound-path probe in webhook mode when the ingress route is absent (404)", async () => {
    mockEndpointStatus(404);
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "webhook",
        serviceAccountKey: validSaKey,
        audience: "1234567890",
      }),
    );
    const inbound = find(findings, "Google Chat inbound path");
    expect(inbound?.status).toBe("fail");
  });

  it("skips the inbound-path probe in webhook mode when the gateway/daemon is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "webhook",
        serviceAccountKey: validSaKey,
        audience: "1234567890",
      }),
    );
    const inbound = find(findings, "Google Chat inbound path");
    expect(inbound?.status).toBe("skip");
  });

  // -------------------------------------------------------------------------
  // Probe 3: recent-inbound (keys on lastInboundAt)
  // -------------------------------------------------------------------------

  it("passes recent-inbound when lastInboundAt is within the recency window", async () => {
    mockChannelsHealth([
      { channelType: "googlechat", lastInboundAt: systemNowMs() - 1000, lastMessageAt: systemNowMs() },
    ]);
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
      }),
    );
    const inbound = find(findings, "Google Chat recent inbound");
    expect(inbound?.status).toBe("pass");
  });

  it("warns recent-inbound for a dead ingress (lastInboundAt null, lastMessageAt fresh)", async () => {
    mockChannelsHealth([
      { channelType: "googlechat", lastInboundAt: null, lastMessageAt: systemNowMs() },
    ]);
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "webhook",
        serviceAccountKey: validSaKey,
        audience: "1234567890",
      }),
    );
    const inbound = find(findings, "Google Chat recent inbound");
    expect(inbound?.status).toBe("warn");
  });

  it("warns recent-inbound when the last inbound is beyond the recency window", async () => {
    mockChannelsHealth([
      {
        channelType: "googlechat",
        lastInboundAt: systemNowMs() - 25 * 60 * 60 * 1000,
        lastMessageAt: systemNowMs(),
      },
    ]);
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
      }),
    );
    const inbound = find(findings, "Google Chat recent inbound");
    expect(inbound?.status).toBe("warn");
  });

  it("skips recent-inbound when the daemon is not reachable", async () => {
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(false);
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
      }),
    );
    const inbound = find(findings, "Google Chat recent inbound");
    expect(inbound?.status).toBe("skip");
    // Did not even attempt the RPC.
    expect(rpcClient.withClient).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Probe 4: email-shaped allowFrom lint
  // -------------------------------------------------------------------------

  it("does NOT warn the allowlist probe when every entry is an immutable resource id", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
        allowFrom: ["users/123456789", "spaces/AAAA"],
      }),
    );
    const lint = find(findings, "Google Chat allowlist");
    expect(lint?.status).toBe("pass");
  });

  it("warns the allowlist probe on an email-shaped entry, steering toward users/{id}", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
        allowFrom: ["ops@example.com"],
      }),
    );
    const lint = find(findings, "Google Chat allowlist");
    expect(lint?.status).toBe("warn");
    const text = `${lint?.message ?? ""} ${lint?.suggestion ?? ""}`;
    expect(text).toContain("users/");
  });

  // -------------------------------------------------------------------------
  // Aggregate: an enabled channel yields all four probes.
  // -------------------------------------------------------------------------

  it("reports the four applicable probes for a clean pubsub config", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
        allowFrom: ["users/123456789"],
      }),
    );
    const checks = new Set(findings.map((f) => f.check));
    expect(checks).toEqual(
      new Set([
        "Google Chat credentials",
        "Google Chat inbound path",
        "Google Chat recent inbound",
        "Google Chat allowlist",
      ]),
    );
  });

  // -------------------------------------------------------------------------
  // Probe 5: webhook audience shape vs audienceType cross-check
  // -------------------------------------------------------------------------
  //
  // The inbound verifier binds to a different key set + claim shape per
  // audienceType, so an audience whose shape contradicts audienceType silently
  // rejects every request. `comis doctor` must catch that before the daemon does.

  it("warns the webhook-audience probe when audienceType is project-number but audience is a URL", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "webhook",
        serviceAccountKey: validSaKey,
        audienceType: "project-number",
        audience: "https://chat.example.com/hook",
      }),
    );
    const audienceCheck = find(findings, "Google Chat webhook audience");
    expect(audienceCheck?.status).toBe("warn");
    const text = `${audienceCheck?.message ?? ""} ${audienceCheck?.suggestion ?? ""}`;
    expect(text).toContain("audienceType");
  });

  it("warns the webhook-audience probe when audienceType is app-url but audience is not URL-shaped", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "webhook",
        serviceAccountKey: validSaKey,
        audienceType: "app-url",
        audience: "1234567890",
      }),
    );
    const audienceCheck = find(findings, "Google Chat webhook audience");
    expect(audienceCheck?.status).toBe("warn");
    const text = `${audienceCheck?.message ?? ""} ${audienceCheck?.suggestion ?? ""}`;
    expect(text).toContain("audienceType");
  });

  it("passes the webhook-audience probe when audienceType app-url matches a URL audience", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "webhook",
        serviceAccountKey: validSaKey,
        audienceType: "app-url",
        audience: "https://chat.example.com/hook",
      }),
    );
    const audienceCheck = find(findings, "Google Chat webhook audience");
    expect(audienceCheck?.status).toBe("pass");
  });

  it("passes the webhook-audience probe when audienceType project-number matches a numeric audience", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "webhook",
        serviceAccountKey: validSaKey,
        audienceType: "project-number",
        audience: "1234567890",
      }),
    );
    const audienceCheck = find(findings, "Google Chat webhook audience");
    expect(audienceCheck?.status).toBe("pass");
  });

  it("omits the webhook-audience probe entirely in pubsub mode (audienceType is inert there)", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "pubsub",
        serviceAccountKey: validSaKey,
        subscriptionName: "projects/test-project/subscriptions/comis",
        audienceType: "project-number",
      }),
    );
    expect(find(findings, "Google Chat webhook audience")).toBeUndefined();
  });

  it("never echoes the service-account key into the webhook-audience finding (secret-safe)", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith({
        enabled: true,
        mode: "webhook",
        serviceAccountKey: validSaKey,
        audienceType: "project-number",
        audience: "https://chat.example.com/hook",
      }),
    );
    const audienceCheck = find(findings, "Google Chat webhook audience");
    expect(audienceCheck?.message ?? "").not.toContain(SECRET_MARKER);
    expect(audienceCheck?.suggestion ?? "").not.toContain(SECRET_MARKER);
  });

  // -------------------------------------------------------------------------
  // Probe 6: inert "always" groupActivation lint
  // -------------------------------------------------------------------------
  //
  // Google Chat only delivers mentioned/slash-command space messages, so
  // groupActivation "always" is inert there. The boot validator WARNs about it
  // once in the daemon log; the doctor read is the surface an operator actually
  // consults, so it must surface the same advisory.

  it('warns that groupActivation "always" is inert on Google Chat, naming the exact knob', async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith(
        {
          enabled: true,
          mode: "pubsub",
          serviceAccountKey: validSaKey,
          subscriptionName: "projects/test-project/subscriptions/comis",
        },
        {},
        { autoReplyEngine: { groupActivation: "always" } },
      ),
    );
    const activation = find(findings, "Google Chat group activation");
    expect(activation?.status).toBe("warn");
    expect(activation?.message).toContain("autoReplyEngine.groupActivation");
    expect(activation?.message).toContain('"always"');
  });

  it("omits the group-activation probe for mention-gated activation (nothing inert to flag)", async () => {
    const findings = await googlechatHealthCheck.run(
      contextWith(
        {
          enabled: true,
          mode: "pubsub",
          serviceAccountKey: validSaKey,
          subscriptionName: "projects/test-project/subscriptions/comis",
        },
        {},
        { autoReplyEngine: { groupActivation: "mention-gated" } },
      ),
    );
    expect(find(findings, "Google Chat group activation")).toBeUndefined();
  });
});
