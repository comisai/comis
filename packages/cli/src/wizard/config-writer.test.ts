/**
 * Tests for config writer wizard functions.
 *
 * Verifies that config directories are created with restrictive permissions
 * (0o700) and sensitive files with 0o600. Uses fs mocks to inspect call args.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock("@comis/core", () => ({
  safePath: (...parts: string[]) => parts.join("/"),
}));

import { writeWizardConfig, writeWizardEnv } from "./config-writer.js";
import type { WizardResult } from "./flow-types.js";

const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

describe("config-writer permissions", () => {
  const baseResult: WizardResult = {
    agentName: "test-agent",
    provider: "anthropic",
    apiKey: "sk-test-key",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("writeWizardConfig", () => {
    it("creates config directory with mode 0o700", () => {
      const result = writeWizardConfig(baseResult, "/tmp/test-config");

      expect(result.ok).toBe(true);
      expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/test-config", {
        recursive: true,
        mode: 0o700,
      });
    });

    it("writes config.yaml file", () => {
      writeWizardConfig(baseResult, "/tmp/test-config");

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test-config/config.yaml",
        expect.any(String),
        "utf-8",
      );
    });

    it("uses ${VAR} substitution for gateway token instead of plaintext", () => {
      const resultWithGateway: WizardResult = {
        ...baseResult,
        gatewayEnabled: true,
        gatewayToken: "super-secret-gateway-token-123",
      };

      writeWizardConfig(resultWithGateway, "/tmp/test-config");

      const writtenYaml = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(writtenYaml).toContain("${COMIS_GATEWAY_TOKEN}");
      expect(writtenYaml).not.toContain("super-secret-gateway-token-123");
    });

    it("uses ${VAR} substitution for telegram channel botToken", () => {
      const resultWithChannel: WizardResult = {
        ...baseResult,
        channels: [{ type: "telegram", botToken: "123456:ABC-SECRET-TOKEN" }],
      };

      writeWizardConfig(resultWithChannel, "/tmp/test-config");

      const writtenYaml = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(writtenYaml).toContain("${TELEGRAM_BOT_TOKEN}");
      expect(writtenYaml).not.toContain("123456:ABC-SECRET-TOKEN");
    });

    it("uses ${VAR} substitution for discord channel botToken", () => {
      const resultWithChannel: WizardResult = {
        ...baseResult,
        channels: [{ type: "discord", botToken: "discord-secret-bot-token" }],
      };

      writeWizardConfig(resultWithChannel, "/tmp/test-config");

      const writtenYaml = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(writtenYaml).toContain("${DISCORD_BOT_TOKEN}");
      expect(writtenYaml).not.toContain("discord-secret-bot-token");
    });

    it("uses ${VAR} substitution for slack channel credentials", () => {
      const resultWithChannel: WizardResult = {
        ...baseResult,
        channels: [{ type: "slack", botToken: "xoxb-slack-token", apiKey: "slack-signing-secret" }],
      };

      writeWizardConfig(resultWithChannel, "/tmp/test-config");

      const writtenYaml = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(writtenYaml).toContain("${SLACK_BOT_TOKEN}");
      expect(writtenYaml).toContain("${SLACK_SIGNING_SECRET}");
      expect(writtenYaml).not.toContain("xoxb-slack-token");
      expect(writtenYaml).not.toContain("slack-signing-secret");
    });

    it("uses generic ${VAR} fallback for unknown channel types", () => {
      const resultWithChannel: WizardResult = {
        ...baseResult,
        channels: [{ type: "irc" as "telegram", botToken: "irc-secret" }],
      };

      writeWizardConfig(resultWithChannel, "/tmp/test-config");

      const writtenYaml = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(writtenYaml).toContain("${IRC_BOT_TOKEN}");
      expect(writtenYaml).not.toContain("irc-secret");
    });
  });

  describe("writeWizardEnv", () => {
    it("creates config directory with mode 0o700", () => {
      writeWizardEnv(baseResult, "/tmp/test-config");

      expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/test-config", {
        recursive: true,
        mode: 0o700,
      });
    });

    it("writes .env file with mode 0o600", () => {
      writeWizardEnv(baseResult, "/tmp/test-config");

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test-config/.env",
        expect.any(String),
        { mode: 0o600 },
      );
    });

    it("writes channel credentials to .env", () => {
      const resultWithChannels: WizardResult = {
        ...baseResult,
        channels: [
          { type: "telegram", botToken: "123456:ABC-SECRET" },
          { type: "slack", botToken: "xoxb-slack", apiKey: "slack-signing" },
        ],
      };

      writeWizardEnv(resultWithChannels, "/tmp/test-config");

      const writtenEnv = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(writtenEnv).toContain("TELEGRAM_BOT_TOKEN=123456:ABC-SECRET");
      expect(writtenEnv).toContain("SLACK_BOT_TOKEN=xoxb-slack");
      expect(writtenEnv).toContain("SLACK_SIGNING_SECRET=slack-signing");
    });

    it("writes gateway token to .env", () => {
      const resultWithGateway: WizardResult = {
        ...baseResult,
        gatewayEnabled: true,
        gatewayToken: "gw-secret-token",
      };

      writeWizardEnv(resultWithGateway, "/tmp/test-config");

      const writtenEnv = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(writtenEnv).toContain("COMIS_GATEWAY_TOKEN=gw-secret-token");
    });

    it("writes all credentials together: provider + channels + gateway", () => {
      const fullResult: WizardResult = {
        ...baseResult,
        channels: [{ type: "telegram", botToken: "tg-token-123" }],
        gatewayEnabled: true,
        gatewayToken: "gw-token-456",
      };

      writeWizardEnv(fullResult, "/tmp/test-config");

      const writtenEnv = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(writtenEnv).toContain("ANTHROPIC_API_KEY=sk-test-key");
      expect(writtenEnv).toContain("TELEGRAM_BOT_TOKEN=tg-token-123");
      expect(writtenEnv).toContain("COMIS_GATEWAY_TOKEN=gw-token-456");
    });
  });
});
