// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { loadConfigFile, validateConfig } from "./loader.js";

describe("config/loader", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-config-"));
    tmpDirs.push(dir);
    return dir;
  }

  function writeFile(dir: string, name: string, content: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  describe("loadConfigFile", () => {
    it("loads valid YAML config", () => {
      const dir = makeTmpDir();
      const filePath = writeFile(
        dir,
        "config.yaml",
        `
tenantId: test-tenant
logLevel: debug
agents:
  default:
    name: TestBot
    maxSteps: 10
`,
      );

      const result = loadConfigFile(filePath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("test-tenant");
        expect(result.value.logLevel).toBe("debug");
        const agents = result.value.agents as Record<string, Record<string, unknown>>;
        expect(agents.default.name).toBe("TestBot");
      }
    });

    it("loads valid JSON config", () => {
      const dir = makeTmpDir();
      const filePath = writeFile(
        dir,
        "config.json",
        JSON.stringify({
          tenantId: "json-tenant",
          logLevel: "warn",
        }),
      );

      const result = loadConfigFile(filePath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("json-tenant");
        expect(result.value.logLevel).toBe("warn");
      }
    });

    it("returns FILE_NOT_FOUND for non-existent file", () => {
      const result = loadConfigFile("/does/not/exist/config.yaml");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("FILE_NOT_FOUND");
        expect(result.error.path).toContain("/does/not/exist/config.yaml");
      }
    });

    it("returns PARSE_ERROR for invalid YAML", () => {
      const dir = makeTmpDir();
      const filePath = writeFile(dir, "bad.yaml", "{ invalid: yaml: content: [}");

      const result = loadConfigFile(filePath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PARSE_ERROR");
      }
    });

    it("returns empty object for empty file", () => {
      const dir = makeTmpDir();
      const filePath = writeFile(dir, "empty.yaml", "");

      const result = loadConfigFile(filePath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({});
      }
    });

    it("returns PARSE_ERROR for array root", () => {
      const dir = makeTmpDir();
      const filePath = writeFile(dir, "array.yaml", "- one\n- two\n");

      const result = loadConfigFile(filePath);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PARSE_ERROR");
        expect(result.error.message).toContain("array");
      }
    });
  });

  describe("validateConfig", () => {
    it("validates minimal config with all defaults applied", () => {
      const result = validateConfig({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("default");
        expect(result.value.logLevel).toBe("info");
        expect(result.value.dataDir).toBe("");
        expect(result.value.agents.default.name).toBe("Comis");
        expect(result.value.agents.default.model).toBe("default");
        expect(result.value.agents.default.maxSteps).toBe(150);
        expect(result.value.memory.walMode).toBe(true);
        expect(result.value.security.logRedaction).toBe(true);
      }
    });

    it("applies partial overrides with defaults for missing fields", () => {
      const result = validateConfig({
        tenantId: "custom",
        agents: { default: { name: "MyBot" } },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("custom");
        expect(result.value.agents.default.name).toBe("MyBot");
        // Defaults still applied
        expect(result.value.agents.default.model).toBe("default");
        expect(result.value.logLevel).toBe("info");
      }
    });

    it("rejects invalid log level", () => {
      const result = validateConfig({ logLevel: "verbose" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("logLevel");
      }
    });

    it("rejects invalid types (string where number expected)", () => {
      const result = validateConfig({
        agents: { default: { maxSteps: "not-a-number" } },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects unknown top-level fields (strict mode)", () => {
      const result = validateConfig({ unknownField: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("validates full config with all sections", () => {
      const result = validateConfig({
        tenantId: "acme",
        logLevel: "debug",
        dataDir: "/var/comis",
        agents: {
          default: {
            name: "AcmeBot",
            model: "gpt-4",
            provider: "openai",
            maxSteps: 50,
            budgets: {
              perExecution: 50_000,
              perHour: 200_000,
              perDay: 1_000_000,
            },
            circuitBreaker: {
              failureThreshold: 3,
              resetTimeoutMs: 30_000,
              halfOpenTimeoutMs: 15_000,
            },
          },
        },
        channels: {
          telegram: { enabled: true, botToken: "tok123", allowFrom: ["user1"] },
          discord: {},
          slack: {},
          whatsapp: {},
        },
        memory: {
          dbPath: "/var/comis/memory.db",
          walMode: true,
          embeddingModel: "text-embedding-3-small",
          embeddingDimensions: 1536,
          compaction: { enabled: true, threshold: 500, targetSize: 250 },
          retention: { maxAgeDays: 90, maxEntries: 10_000 },
        },
        security: {
          logRedaction: true,
          auditLog: true,
          permission: {
            enableNodePermissions: true,
            allowedFsPaths: ["/var/comis"],
            allowedNetHosts: ["api.anthropic.com"],
          },
          actionConfirmation: {
            requireForDestructive: true,
            requireForSensitive: true,
            autoApprove: ["read_file"],
          },
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("acme");
        expect(result.value.agents.default.budgets.perExecution).toBe(50_000);
        expect(result.value.channels.telegram.enabled).toBe(true);
        expect(result.value.memory.compaction.threshold).toBe(500);
        expect(result.value.security.permission.enableNodePermissions).toBe(true);
      }
    });
  });

  describe("multi-agent config", () => {
    it("validates agents: map with per-agent skills", () => {
      const result = validateConfig({
        agents: {
          dash: {
            name: "dash",
            provider: "anthropic",
            model: "claude-sonnet-4-5-20250929",
            skills: {
              toolPolicy: {
                profile: "full",
                deny: ["group:platform_actions"],
              },
              builtinTools: {
                read: true,
                write: true,
              },
            },
          },
          coder: {
            name: "coder",
            provider: "anthropic",
            model: "claude-sonnet-4-5-20250929",
            skills: {
              toolPolicy: {
                profile: "coding",
              },
              builtinTools: {
                read: true,
                edit: true,
              },
            },
          },
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agents.dash.skills?.toolPolicy.profile).toBe("full");
        expect(result.value.agents.dash.skills?.toolPolicy.deny).toEqual(["group:platform_actions"]);
        expect(result.value.agents.dash.skills?.builtinTools.read).toBe(true);
        expect(result.value.agents.coder.skills?.toolPolicy.profile).toBe("coding");
        expect(result.value.agents.coder.skills?.builtinTools.read).toBe(true);
        expect(result.value.agents.coder.skills?.builtinTools.edit).toBe(true);
      }
    });

    it("per-agent skills block is optional", () => {
      const result = validateConfig({
        agents: {
          withSkills: {
            name: "WithSkills",
            skills: {
              toolPolicy: { profile: "full" },
            },
          },
          withoutSkills: {
            name: "WithoutSkills",
          },
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agents.withSkills.skills).toBeDefined();
        expect(result.value.agents.withSkills.skills?.toolPolicy.profile).toBe("full");
        expect(result.value.agents.withoutSkills.skills).toBeUndefined();
      }
    });

    it("empty config produces default agents map", () => {
      const result = validateConfig({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agents.default).toBeDefined();
        expect(result.value.agents.default.name).toBe("Comis");
        expect(result.value.agents.default.model).toBe("default");
        expect(result.value.agents.default.provider).toBe("default");
      }
    });

    it("rejects old singular agent: key", () => {
      const result = validateConfig({ agent: { name: "TestBot" } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects old global skills: key", () => {
      const result = validateConfig({ skills: { toolPolicy: { profile: "full" } } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });
});
