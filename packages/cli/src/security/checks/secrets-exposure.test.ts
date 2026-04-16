/**
 * Secrets exposure check unit tests.
 *
 * Verifies that secretsExposureCheck detects all known secret patterns
 * (sk- keys, AWS keys, bot tokens, GitHub tokens, Slack tokens,
 * private key headers) and returns no findings for clean content.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { secretsExposureCheck } from "./secrets-exposure.js";
import type { AuditContext } from "../types.js";

/** Base audit context with no raw config content. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

describe("secretsExposureCheck", () => {
  it("returns empty findings when no rawConfigContent", async () => {
    const findings = await secretsExposureCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("detects OpenAI/Anthropic API key (sk-)", async () => {
    const findings = await secretsExposureCheck.run({
      ...baseContext,
      rawConfigContent: "apiKey: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SECRET-SK_KEY");
    expect(findings[0].severity).toBe("critical");
  });

  it("detects AWS access key (AKIA)", async () => {
    const findings = await secretsExposureCheck.run({
      ...baseContext,
      rawConfigContent: "awsKey: AKIAIOSFODNN7EXAMPLE",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SECRET-AWS_KEY");
    expect(findings[0].severity).toBe("critical");
  });

  it("detects Telegram bot token", async () => {
    const findings = await secretsExposureCheck.run({
      ...baseContext,
      rawConfigContent: "botToken: 123456789:ABCdefGHIjklMNOpqrSTUvwxyz",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SECRET-BOT_TOKEN");
    expect(findings[0].severity).toBe("critical");
  });

  it("detects GitHub token (ghp_)", async () => {
    const findings = await secretsExposureCheck.run({
      ...baseContext,
      rawConfigContent:
        "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SECRET-GITHUB_TOKEN");
    expect(findings[0].severity).toBe("critical");
  });

  it("detects Slack token (xoxb-)", async () => {
    const findings = await secretsExposureCheck.run({
      ...baseContext,
      rawConfigContent: "slackToken: xoxb-123456789-abcdefghijklmnop",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SECRET-SLACK_TOKEN");
    expect(findings[0].severity).toBe("critical");
  });

  it("detects private key header", async () => {
    const findings = await secretsExposureCheck.run({
      ...baseContext,
      rawConfigContent: "-----BEGIN PRIVATE KEY-----",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SECRET-PRIVATE_KEY");
    expect(findings[0].severity).toBe("critical");
  });

  it("returns no findings for clean config", async () => {
    const findings = await secretsExposureCheck.run({
      ...baseContext,
      rawConfigContent: "tenantId: default\nlogLevel: info",
    });

    expect(findings).toHaveLength(0);
  });
});
