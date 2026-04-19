/**
 * CONFIG-SCHEMA: Per-section schema validation, unknown key rejection, and
 * defaults verification E2E tests.
 *
 * These tests exercise the config loading + validation pipeline directly
 * (no daemon) -- fast, isolated, and deterministic.
 *
 * Covers:
 * - All 25 top-level config sections produce correct defaults
 * - Valid section configs pass validation
 * - Invalid section configs produce VALIDATION_ERROR
 * - z.strictObject() rejects unknown keys at root and section level
 * - Partial validator preserves valid sections and isolates errors
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfigFile,
  validateConfig,
  validatePartial,
  AppConfigSchema,
} from "@comis/core";
import type { ConfigError } from "@comis/core";

// ---------------------------------------------------------------------------
// Temp directory for YAML fixtures
// ---------------------------------------------------------------------------

const tmpDir = join(tmpdir(), `comis-test-config-119-schema-${Date.now()}`);

describe("Config Schema Validation (119-01)", () => {
  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test group 1: Per-section schema validation
  // -------------------------------------------------------------------------

  describe("Per-section schema validation", () => {
    const allKeys = Object.keys(AppConfigSchema.shape);

    it("AppConfigSchema has all expected top-level keys", () => {
      // Snapshot-style guard: bump this count when a new top-level section is
      // added so the change surfaces in code review. Count reflects all scalars
      // plus all object sections currently in AppConfigSchema.shape.
      expect(allKeys).toHaveLength(37);
    });

    it("empty config {} produces valid defaults for all sections", () => {
      const result = validateConfig({});
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Scalar defaults
      expect(result.value.tenantId).toBe("default");
      expect(result.value.logLevel).toBe("info");
      expect(result.value.dataDir).toBe("");

      // Object sections should all exist and be objects
      const objectKeys = allKeys.filter(
        (k) => !["tenantId", "logLevel", "dataDir", "agentDir"].includes(k),
      );
      for (const key of objectKeys) {
        const section = (result.value as Record<string, unknown>)[key];
        expect(section, `section "${key}" should be defined`).toBeDefined();
        expect(
          typeof section,
          `section "${key}" should be an object`,
        ).toBe("object");
      }
    });

    it("valid gateway section passes validation", () => {
      const configPath = join(tmpDir, "valid-gateway.yaml");
      writeFileSync(
        configPath,
        'gateway:\n  enabled: true\n  host: "127.0.0.1"\n  port: 9999\n',
        "utf-8",
      );

      const loadResult = loadConfigFile(configPath);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      const validateResult = validateConfig(loadResult.value);
      expect(validateResult.ok).toBe(true);
      if (!validateResult.ok) return;

      expect(validateResult.value.gateway.port).toBe(9999);
    });

    it("invalid gateway port type produces VALIDATION_ERROR", () => {
      const result = validateConfig({ gateway: { port: "not-a-number" } });
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const error = result.error as ConfigError;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message.toLowerCase()).toContain("port");
    });

    it("valid memory section passes validation", () => {
      const result = validateConfig({
        memory: { dbPath: "test.db", walMode: true },
      });
      expect(result.ok).toBe(true);
    });

    it("invalid memory walMode type produces VALIDATION_ERROR", () => {
      const result = validateConfig({
        memory: { walMode: "not-boolean" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const error = result.error as ConfigError;
      expect(error.code).toBe("VALIDATION_ERROR");
    });

    it("valid scheduler section passes validation", () => {
      const result = validateConfig({
        scheduler: { cron: { enabled: true, maxConcurrentRuns: 3 } },
      });
      expect(result.ok).toBe(true);
    });

    it("valid security section passes validation", () => {
      const result = validateConfig({
        security: { agentToAgent: { enabled: true } },
      });
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Test group 2: strictObject unknown key rejection
  // -------------------------------------------------------------------------

  describe("strictObject unknown key rejection", () => {
    it("unknown key at root level produces VALIDATION_ERROR", () => {
      const result = validateConfig({ unknownRootKey: "value" } as Record<string, unknown>);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const error = result.error as ConfigError;
      expect(error.code).toBe("VALIDATION_ERROR");
      // Zod strict object error contains "unrecognized_keys" in the issue
      const msgLower = error.message.toLowerCase();
      expect(
        msgLower.includes("unrecognized") || msgLower.includes("unknown"),
      ).toBe(true);
    });

    it("unknown key within gateway section produces VALIDATION_ERROR", () => {
      const result = validateConfig({
        gateway: { unknownSubKey: true },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const error = result.error as ConfigError;
      expect(error.code).toBe("VALIDATION_ERROR");
    });

    it("multiple unknown keys at root level all rejected", () => {
      const result = validateConfig({
        fooBar: 1,
        bazQux: 2,
      } as Record<string, unknown>);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const error = result.error as ConfigError;
      expect(error.code).toBe("VALIDATION_ERROR");
    });
  });

  // -------------------------------------------------------------------------
  // Test group 3: Partial validator behavior
  // -------------------------------------------------------------------------

  describe("Partial validator behavior", () => {
    it("validatePartial preserves valid sections and reports invalid ones", () => {
      const result = validatePartial({
        tenantId: "my-app",
        gateway: { port: "invalid" },
        memory: {},
      });

      expect(result.validSections).toContain("tenantId");
      expect(result.validSections).toContain("memory");

      // gateway should have an error
      const gatewayError = result.errors.find(
        (e) => e.section === "gateway",
      );
      expect(gatewayError).toBeDefined();
      expect(gatewayError!.error.code).toBe("VALIDATION_ERROR");
    });

    it("validatePartial ignores unknown top-level keys", () => {
      const result = validatePartial({
        unknownSection: "value",
        tenantId: "ok",
      });

      expect(result.validSections).toContain("tenantId");
      expect(result.errors).toHaveLength(0);
    });

    it("validatePartial with all valid sections returns no errors", () => {
      const result = validatePartial({
        tenantId: "test",
        logLevel: "debug",
      });

      expect(result.errors).toHaveLength(0);
      expect(result.validSections).toContain("tenantId");
      expect(result.validSections).toContain("logLevel");
    });
  });
});
