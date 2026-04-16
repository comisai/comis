/**
 * Channel health check unit tests.
 *
 * Tests channel-health check for no channels (skip), missing
 * credentials (fail), configured credentials (pass), and partial
 * credentials scenarios.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DoctorContext } from "../types.js";
import type { AppConfig } from "@comis/core";
import { channelHealthCheck } from "./channel-health.js";

const baseContext: DoctorContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

describe("channelHealthCheck", () => {
  /** Store original env vars to restore after each test. */
  const savedEnv: Record<string, string | undefined> = {};
  const envVarsToClean = [
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_VERIFY_TOKEN",
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_CHANNEL_SECRET",
  ];

  beforeEach(() => {
    // Save current env values
    for (const key of envVarsToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env values
    for (const key of envVarsToClean) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("produces skip when no channels configured", async () => {
    const findings = await channelHealthCheck.run({
      ...baseContext,
      config: undefined,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("skip");
    expect(findings[0].message).toContain("No channels configured");
  });

  it("produces skip when no channels enabled", async () => {
    const config = {
      channels: {
        telegram: { enabled: false },
      },
    } as unknown as AppConfig;

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("skip");
    expect(findings[0].message).toContain("No channels enabled");
  });

  it("produces fail for missing Telegram credentials", async () => {
    const config = {
      channels: {
        telegram: { enabled: true },
      },
    } as unknown as AppConfig;

    // Ensure TELEGRAM_BOT_TOKEN is not set
    delete process.env["TELEGRAM_BOT_TOKEN"];

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("fail");
    expect(findings[0].message).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("produces pass for configured Telegram credentials", async () => {
    const config = {
      channels: {
        telegram: { enabled: true },
      },
    } as unknown as AppConfig;

    process.env["TELEGRAM_BOT_TOKEN"] = "test-token-12345";

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("pass");
    expect(findings[0].message).toContain("telegram");
    expect(findings[0].message).toContain("configured");
  });

  it("produces fail for partial Slack credentials", async () => {
    const config = {
      channels: {
        slack: { enabled: true },
      },
    } as unknown as AppConfig;

    // Set only SLACK_BOT_TOKEN but NOT SLACK_SIGNING_SECRET
    process.env["SLACK_BOT_TOKEN"] = "xoxb-test-token";
    delete process.env["SLACK_SIGNING_SECRET"];

    const findings = await channelHealthCheck.run({
      ...baseContext,
      config,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("fail");
    expect(findings[0].message).toContain("SLACK_SIGNING_SECRET");
  });
});
