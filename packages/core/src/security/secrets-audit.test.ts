/**
 * Unit tests for secrets audit scanner.
 *
 * Tests scanConfigForSecrets, scanEnvForSecrets, and auditSecrets
 * covering config YAML scanning, .env scanning, SecretRef detection,
 * and combined audit scenarios.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanConfigForSecrets,
  scanEnvForSecrets,
  auditSecrets,
} from "./secrets-audit.js";

// ── scanConfigForSecrets ───────────────────────────────────────────

describe("scanConfigForSecrets", () => {
  it("detects plaintext botToken string", () => {
    const config = {
      channels: {
        telegram: {
          botToken: "123456:ABC-DEF",
          enabled: true,
        },
      },
    };

    const findings = scanConfigForSecrets("/etc/comis/config.yaml", config);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      code: "PLAINTEXT_SECRET",
      severity: "error",
      file: "/etc/comis/config.yaml",
      jsonPath: "channels.telegram.botToken",
      message: expect.stringContaining("Plaintext secret detected in field 'botToken'"),
    });
  });

  it("skips SecretRef objects (properly configured)", () => {
    const config = {
      channels: {
        telegram: {
          botToken: {
            source: "env",
            provider: "comis",
            id: "TELEGRAM_BOT_TOKEN",
          },
        },
      },
    };

    const findings = scanConfigForSecrets("/etc/comis/config.yaml", config);
    expect(findings).toHaveLength(0);
  });

  it("skips empty string values", () => {
    const config = {
      channels: {
        telegram: {
          botToken: "",
        },
      },
    };

    const findings = scanConfigForSecrets("/etc/comis/config.yaml", config);
    expect(findings).toHaveLength(0);
  });

  it("detects multiple nested secrets", () => {
    const config = {
      channels: {
        telegram: {
          botToken: "tg-token-value",
        },
        slack: {
          appToken: "xapp-slack-token",
        },
      },
    };

    const findings = scanConfigForSecrets("/config.yaml", config);

    expect(findings).toHaveLength(2);
    expect(findings[0].jsonPath).toBe("channels.telegram.botToken");
    expect(findings[1].jsonPath).toBe("channels.slack.appToken");
  });

  it("does not flag non-secret fields", () => {
    const config = {
      channels: {
        telegram: {
          enabled: true,
          chatId: "12345",
          pollingTimeout: 30,
        },
      },
    };

    const findings = scanConfigForSecrets("/config.yaml", config);
    expect(findings).toHaveLength(0);
  });

  it("handles array bracket notation in jsonPath", () => {
    const config = {
      gateway: {
        tokens: [
          { secret: "my-secret-token", label: "admin" },
        ],
      },
    };

    const findings = scanConfigForSecrets("/config.yaml", config);

    expect(findings).toHaveLength(1);
    expect(findings[0].jsonPath).toBe("gateway.tokens[0].secret");
  });

  it("handles deeply nested objects", () => {
    const config = {
      level1: {
        level2: {
          level3: {
            apiKey: "deep-api-key",
          },
        },
      },
    };

    const findings = scanConfigForSecrets("/config.yaml", config);

    expect(findings).toHaveLength(1);
    expect(findings[0].jsonPath).toBe("level1.level2.level3.apiKey");
  });

  it("detects various secret field name patterns", () => {
    const config = {
      myPassword: "pass123",
      someCredential: "cred456",
      private_key: "key789",
      api_key: "apikey000",
    };

    const findings = scanConfigForSecrets("/config.yaml", config);
    expect(findings).toHaveLength(4);
  });

  it("handles empty config object", () => {
    const findings = scanConfigForSecrets("/config.yaml", {});
    expect(findings).toHaveLength(0);
  });
});

// ── scanEnvForSecrets ──────────────────────────────────────────────

describe("scanEnvForSecrets", () => {
  it("detects ANTHROPIC_API_KEY", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-test-key",
    };

    const findings = scanEnvForSecrets("/home/user/.comis/.env", env);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      code: "KNOWN_PROVIDER_ENV",
      severity: "warn",
      file: "/home/user/.comis/.env",
      jsonPath: "ANTHROPIC_API_KEY",
      message: expect.stringContaining("anthropic"),
    });
  });

  it("skips PATH and HOME", () => {
    const env = {
      PATH: "/usr/bin:/usr/local/bin",
      HOME: "/home/user",
    };

    const findings = scanEnvForSecrets("/.env", env);
    expect(findings).toHaveLength(0);
  });

  it("skips COMIS_ prefixed vars", () => {
    const env = {
      COMIS_CONFIG_PATHS: "/etc/comis/config.yaml",
    };

    const findings = scanEnvForSecrets("/.env", env);
    expect(findings).toHaveLength(0);
  });

  it("detects CUSTOM_API_KEY via wildcard pattern", () => {
    const env = {
      CUSTOM_API_KEY: "custom-key-value",
    };

    const findings = scanEnvForSecrets("/.env", env);

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("KNOWN_PROVIDER_ENV");
    expect(findings[0].message).toContain("unknown");
  });

  it("skips empty values", () => {
    const env = {
      OPENAI_API_KEY: "",
    };

    const findings = scanEnvForSecrets("/.env", env);
    expect(findings).toHaveLength(0);
  });

  it("skips undefined values", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: undefined,
    };

    const findings = scanEnvForSecrets("/.env", env);
    expect(findings).toHaveLength(0);
  });

  it("detects multiple known providers", () => {
    const env = {
      OPENAI_API_KEY: "sk-test",
      DISCORD_BOT_TOKEN: "discord-token",
      SLACK_SIGNING_SECRET: "slack-secret",
    };

    const findings = scanEnvForSecrets("/.env", env);
    expect(findings).toHaveLength(3);

    const providers = findings.map(f => f.message);
    expect(providers.some(m => m.includes("openai"))).toBe(true);
    expect(providers.some(m => m.includes("discord"))).toBe(true);
    expect(providers.some(m => m.includes("slack"))).toBe(true);
  });

  it("skips NODE_ prefixed vars", () => {
    const env = {
      NODE_ENV: "production",
      NODE_OPTIONS: "--max-old-space-size=4096",
    };

    const findings = scanEnvForSecrets("/.env", env);
    expect(findings).toHaveLength(0);
  });
});

// ── auditSecrets ───────────────────────────────────────────────────

describe("auditSecrets", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "comis-audit-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when no files exist", () => {
    const findings = auditSecrets({
      configPaths: [join(tempDir, "nonexistent.yaml")],
      envPath: join(tempDir, "nonexistent.env"),
    });

    expect(findings).toEqual([]);
  });

  it("returns empty array for empty config paths", () => {
    const findings = auditSecrets({
      configPaths: [],
    });

    expect(findings).toEqual([]);
  });

  it("scans YAML config file for plaintext secrets", () => {
    const configPath = join(tempDir, "config.yaml");
    writeFileSync(configPath, `
channels:
  telegram:
    botToken: "plaintext-token"
    enabled: true
`);

    const findings = auditSecrets({
      configPaths: [configPath],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("PLAINTEXT_SECRET");
    expect(findings[0].jsonPath).toBe("channels.telegram.botToken");
  });

  it("scans .env file for known provider secrets", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, `
ANTHROPIC_API_KEY=sk-ant-test
OPENAI_API_KEY=sk-test
NODE_ENV=production
`);

    const findings = auditSecrets({
      configPaths: [],
      envPath,
    });

    expect(findings).toHaveLength(2);
    expect(findings.every(f => f.code === "KNOWN_PROVIDER_ENV")).toBe(true);
  });

  it("sorts findings by severity (errors first, then warnings)", () => {
    const configPath = join(tempDir, "config.yaml");
    writeFileSync(configPath, `
channels:
  telegram:
    botToken: "plaintext-token"
`);

    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, `OPENAI_API_KEY=sk-test`);

    const findings = auditSecrets({
      configPaths: [configPath],
      envPath,
    });

    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe("error");
    expect(findings[1].severity).toBe("warn");
  });

  it("handles quoted values in .env", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, `ANTHROPIC_API_KEY="sk-ant-quoted"`);

    const findings = auditSecrets({
      configPaths: [],
      envPath,
    });

    expect(findings).toHaveLength(1);
  });

  it("gracefully handles invalid YAML", () => {
    const configPath = join(tempDir, "bad.yaml");
    writeFileSync(configPath, "{{invalid yaml: [}");

    // Should not throw
    const findings = auditSecrets({
      configPaths: [configPath],
    });

    // Findings may be empty or contain whatever the parser manages to extract
    expect(Array.isArray(findings)).toBe(true);
  });
});
