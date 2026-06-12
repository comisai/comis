// SPDX-License-Identifier: Apache-2.0
/**
 * Channel health check unit tests.
 *
 * Tests channel-health check against the resolution-driven contract
 * (2026-06-12 doctor split-brain fix): enabled channels pass when their
 * `${VAR}` credential references resolved (env, ~/.comis/.env, or the
 * encrypted secret store), fail naming the exact unresolved reference,
 * and the no-config skip names the resolution failure instead of
 * claiming nothing is configured.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { DoctorContext } from "../types.js";
import type { AppConfig } from "@comis/core";
import { channelHealthCheck } from "./channel-health.js";

const baseContext: DoctorContext = {
  configPaths: ["/cfg/config.yaml"],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

/** Build a config whose channels section is exactly `channels`. */
function configWith(channels: Record<string, unknown>): AppConfig {
  return { channels } as unknown as AppConfig;
}

describe("channelHealthCheck", () => {
  it("produces skip when no channels configured", async () => {
    const findings = await channelHealthCheck.run({
      ...baseContext,
      config: undefined,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("skip");
    expect(findings[0]?.message).toContain("No channels configured");
  });

  it("names the config-resolution failure instead of claiming no channels are configured", async () => {
    const findings = await channelHealthCheck.run({
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
    expect(findings[0]?.message).not.toContain("No channels configured");
  });

  it("produces skip when no channels enabled", async () => {
    const config = configWith({ telegram: { enabled: false } });

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
      configResolution: { foundPath: "/cfg/config.yaml", config },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("skip");
    expect(findings[0]?.message).toContain("No channels enabled");
  });

  it("passes an enabled channel whose credential references all resolved (store-backed deployment)", async () => {
    const config = configWith({
      telegram: { enabled: true, botToken: "12345:resolved-from-store" },
    });

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
      configResolution: { foundPath: "/cfg/config.yaml", config },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("pass");
    expect(findings[0]?.check).toBe("telegram credentials");
    expect(findings[0]?.message).toContain("resolved");
  });

  it("fails an enabled channel naming the exact unresolved reference and the places checked", async () => {
    const config = configWith({
      telegram: { enabled: true, botToken: "${TELEGRAM_BOT_TOKEN}" },
    });

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        config,
        unresolvedRefs: [{ path: "channels.telegram.botToken", varName: "TELEGRAM_BOT_TOKEN" }],
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("fail");
    expect(findings[0]?.message).toContain("TELEGRAM_BOT_TOKEN");
    expect(findings[0]?.message).toContain("channels.telegram.botToken");
    expect(findings[0]?.message).toContain("encrypted secret store");
    expect(findings[0]?.suggestion).toContain("comis secrets set");
  });

  it("scopes unresolved references to their own channel so a sibling channel still passes", async () => {
    const config = configWith({
      telegram: { enabled: true, botToken: "12345:resolved" },
      discord: { enabled: true, botToken: "${DISCORD_BOT_TOKEN}" },
    });

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        config,
        unresolvedRefs: [{ path: "channels.discord.botToken", varName: "DISCORD_BOT_TOKEN" }],
      },
    });

    expect(findings).toHaveLength(2);
    const telegram = findings.find((f) => f.check === "telegram credentials");
    const discord = findings.find((f) => f.check === "discord credentials");
    expect(telegram?.status).toBe("pass");
    expect(discord?.status).toBe("fail");
    expect(discord?.message).toContain("DISCORD_BOT_TOKEN");
  });

  it("does not report the channels.healthCheck settings block as a channel", async () => {
    const config = configWith({
      telegram: { enabled: true, botToken: "12345:resolved" },
      healthCheck: { enabled: true, intervalMs: 60_000 },
    });

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
      configResolution: { foundPath: "/cfg/config.yaml", config },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe("telegram credentials");
  });

  it("ignores unresolved references outside the channels section when judging channel credentials", async () => {
    const config = configWith({
      telegram: { enabled: true, botToken: "12345:resolved" },
    });

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
      configResolution: {
        foundPath: "/cfg/config.yaml",
        config,
        unresolvedRefs: [{ path: "providers.entries.custom.apiKeyName", varName: "CUSTOM_KEY" }],
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("pass");
  });
});
