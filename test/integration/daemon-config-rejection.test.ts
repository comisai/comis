// SPDX-License-Identifier: Apache-2.0
/**
 * DAEMON-03: Config Rejection Integration Tests
 *
 * Validates that the daemon rejects startup when given invalid configuration:
 * - Bad YAML syntax -> PARSE_ERROR
 * - Nonexistent file -> FILE_NOT_FOUND
 * - Wrong value types -> VALIDATION_ERROR
 * - Empty config accepted (schema defaults fill all fields)
 * - Layered loading rejects bad layers
 * - bootstrap() returns Result error (not throws) for bad config
 * - Error messages are descriptive enough to diagnose the problem
 *
 * These tests exercise the config/bootstrap layer directly WITHOUT starting
 * a full daemon -- fast, isolated, and deterministic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfigFile,
  validateConfig,
  loadLayered,
  bootstrap,
} from "@comis/core";
import type { ConfigError } from "@comis/core";

// ---------------------------------------------------------------------------
// Test fixtures: temporary bad config files
// ---------------------------------------------------------------------------

const tmpDir = join(tmpdir(), `comis-test-config-${Date.now()}`);
const badYamlPath = join(tmpDir, "bad-yaml.yaml");
const badTypesPath = join(tmpDir, "bad-types.yaml");
const emptyConfigPath = join(tmpDir, "empty.yaml");
const nonexistentPath = join(tmpDir, "nonexistent.yaml");

// Path to the real test config for layered loading tests
const goodConfigPath = join(__dirname, "../config/config.test.yaml");

describe("Config Rejection (DAEMON-03)", () => {
  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });

    // 1. Invalid YAML syntax (unclosed bracket)
    writeFileSync(badYamlPath, "gateway:\n  port: [unclosed\n", "utf-8");

    // 2. Valid YAML but wrong types (port should be number, not string)
    writeFileSync(
      badTypesPath,
      'gateway:\n  port: "not-a-number"\n  enabled: "yes-string"\n',
      "utf-8",
    );

    // 3. Empty config (just an empty object)
    writeFileSync(emptyConfigPath, "{}\n", "utf-8");

    // 4. nonexistent.yaml is NOT created -- that's the point
  });

  afterAll(() => {
    // Clean up temp files
    for (const f of [badYamlPath, badTypesPath, emptyConfigPath]) {
      if (existsSync(f)) unlinkSync(f);
    }
    if (existsSync(tmpDir)) rmdirSync(tmpDir);
  });

  // -------------------------------------------------------------------------
  // Config loader tests
  // -------------------------------------------------------------------------

  it("rejects invalid YAML syntax", () => {
    const result = loadConfigFile(badYamlPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as ConfigError;
      expect(error.code).toBe("PARSE_ERROR");
      expect(error.message).toContain(badYamlPath.split("/").pop());
    }
  });

  it("rejects nonexistent config file", () => {
    const result = loadConfigFile(nonexistentPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as ConfigError;
      expect(error.code).toBe("FILE_NOT_FOUND");
    }
  });

  it("rejects config with wrong value types", () => {
    // loadConfigFile should succeed (valid YAML)
    const loadResult = loadConfigFile(badTypesPath);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    // validateConfig should fail (wrong types)
    const validateResult = validateConfig(loadResult.value);
    expect(validateResult.ok).toBe(false);
    if (!validateResult.ok) {
      const error = validateResult.error as ConfigError;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message.toLowerCase()).toContain("port");
    }
  });

  it("accepts empty config with schema defaults", () => {
    const result = validateConfig({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Verify defaults were applied
      expect(result.value.tenantId).toBe("default");
      expect(result.value.logLevel).toBe("info");
      expect(result.value.gateway).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // Layered loading tests
  // -------------------------------------------------------------------------

  it("loadLayered rejects when any layer has bad YAML", () => {
    const result = loadLayered([goodConfigPath, badYamlPath]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as ConfigError;
      expect(error.code).toBe("PARSE_ERROR");
    }
  });

  it("loadLayered rejects when file not found", () => {
    const result = loadLayered([nonexistentPath]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as ConfigError;
      expect(error.code).toBe("FILE_NOT_FOUND");
    }
  });

  // -------------------------------------------------------------------------
  // Bootstrap tests
  // -------------------------------------------------------------------------

  it("bootstrap returns error Result for invalid config", () => {
    const result = bootstrap({
      configPaths: [badYamlPath],
      watchConfig: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as ConfigError;
      expect(error.code).toBe("PARSE_ERROR");
      expect(error.message).toBeDefined();
    }
  });

  it("validation error message describes the problem", () => {
    const result = validateConfig({ gateway: { port: "not-a-number" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as ConfigError;
      expect(error.code).toBe("VALIDATION_ERROR");
      // Error message should mention the problematic field
      const msgLower = error.message.toLowerCase();
      expect(msgLower).toContain("port");
      // Error message should indicate it's a validation failure
      expect(msgLower).toContain("validation");
    }
  });
});
