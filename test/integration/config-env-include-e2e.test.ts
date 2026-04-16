/**
 * CONFIG-ENV-INCLUDE: Env var substitution and $include resolution E2E tests
 * with real YAML files.
 *
 * These tests exercise the full config loading pipeline (loadConfigFile with
 * options) -- no daemon required.
 *
 * Covers:
 * - ${VAR} substitution via getSecret option with real YAML files
 * - Missing env var produces ENV_VAR_ERROR
 * - Escaped $${VAR} produces literal ${VAR} in output
 * - Env substitution + validation pipeline behavior (string port stays string)
 * - $include merges base file with sibling override
 * - $include with missing file produces INCLUDE_ERROR
 * - Circular $include produces CIRCULAR_INCLUDE error
 * - Nested $include chain resolves correctly
 * - Combined $include + env substitution pipeline
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { ok, err } from "@comis/shared";
import {
  loadConfigFile,
  validateConfig,
} from "@comis/core";
import type { ConfigError } from "@comis/core";

// Resolve yaml from @comis/core's dependency tree (not hoisted to root)
const coreRequire = createRequire(
  resolve(__dirname, "../../packages/core/src/index.ts"),
);
const { parse: parseYaml } = coreRequire("yaml") as { parse: (s: string) => unknown };

// ---------------------------------------------------------------------------
// Temp directory for YAML fixtures
// ---------------------------------------------------------------------------

const tmpDir = join(tmpdir(), `comis-test-config-119-env-include-${Date.now()}`);

// ---------------------------------------------------------------------------
// IncludeResolverDeps using real filesystem
// ---------------------------------------------------------------------------

const includeDeps = {
  readFile: (absPath: string) => {
    try {
      return ok(readFileSync(absPath, "utf-8"));
    } catch {
      return err({
        code: "FILE_NOT_FOUND" as const,
        message: `Not found: ${absPath}`,
        path: absPath,
      });
    }
  },
  parseFn: (raw: string, _filePath: string) => {
    try {
      const parsed = parseYaml(raw);
      if (parsed === null || parsed === undefined) {
        return ok({} as Record<string, unknown>);
      }
      return ok(parsed as Record<string, unknown>);
    } catch (e) {
      return err({
        code: "PARSE_ERROR" as const,
        message: String(e),
      });
    }
  },
  resolvePath: (base: string, inc: string) => ok(resolve(base, inc)),
};

describe("Config Env Substitution & $include E2E (119-01)", () => {
  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test group 1: Env var substitution E2E
  // -------------------------------------------------------------------------

  describe("Env var substitution E2E", () => {
    it("${VAR} in YAML file is substituted via getSecret option", () => {
      const configPath = join(tmpDir, "env-sub.yaml");
      writeFileSync(
        configPath,
        [
          'tenantId: "${TEST_TENANT_ID}"',
          "gateway:",
          "  port: 9999",
          "  tokens:",
          '    - id: "test"',
          '      secret: "${TEST_SECRET}"',
          '      scopes: ["rpc"]',
        ].join("\n") + "\n",
        "utf-8",
      );

      const result = loadConfigFile(configPath, {
        getSecret: (key: string) => {
          if (key === "TEST_TENANT_ID") return "my-tenant";
          if (key === "TEST_SECRET") return "super-secret";
          return undefined;
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.tenantId).toBe("my-tenant");
      const tokens = (result.value.gateway as Record<string, unknown>)
        .tokens as Array<Record<string, unknown>>;
      expect(tokens[0].secret).toBe("super-secret");
    });

    it("missing env var produces ENV_VAR_ERROR", () => {
      const configPath = join(tmpDir, "missing-env.yaml");
      writeFileSync(
        configPath,
        'tenantId: "${MISSING_VAR}"\n',
        "utf-8",
      );

      const result = loadConfigFile(configPath, {
        getSecret: () => undefined,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      const error = result.error as ConfigError;
      expect(error.code).toBe("ENV_VAR_ERROR");
      expect(error.message).toContain("MISSING_VAR");
    });

    it("escaped $${VAR} produces literal ${VAR} in output", () => {
      const configPath = join(tmpDir, "escaped-env.yaml");
      writeFileSync(
        configPath,
        'tenantId: "$${ESCAPED_VAR}"\n',
        "utf-8",
      );

      const result = loadConfigFile(configPath, {
        getSecret: () => undefined,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.tenantId).toBe("${ESCAPED_VAR}");
    });

    it("env var substitution + validation pipeline: string port stays string, validation fails", () => {
      const configPath = join(tmpDir, "env-port.yaml");
      writeFileSync(
        configPath,
        [
          "gateway:",
          '  port: "${GATEWAY_PORT}"',
        ].join("\n") + "\n",
        "utf-8",
      );

      const loadResult = loadConfigFile(configPath, {
        getSecret: (key: string) => {
          if (key === "GATEWAY_PORT") return "8500";
          return undefined;
        },
      });

      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      // Port is string "8500" after substitution, Zod expects number (no coercion)
      const validateResult = validateConfig(loadResult.value);
      expect(validateResult.ok).toBe(false);
      if (validateResult.ok) return;

      const error = validateResult.error as ConfigError;
      expect(error.code).toBe("VALIDATION_ERROR");
    });
  });

  // -------------------------------------------------------------------------
  // Test group 2: $include resolution E2E
  // -------------------------------------------------------------------------

  describe("$include resolution E2E", () => {
    it("$include merges base file with sibling override", () => {
      const basePath = join(tmpDir, "base.yaml");
      writeFileSync(
        basePath,
        [
          "gateway:",
          "  enabled: true",
          '  host: "0.0.0.0"',
          "  port: 4766",
        ].join("\n") + "\n",
        "utf-8",
      );

      const mainPath = join(tmpDir, "main.yaml");
      writeFileSync(
        mainPath,
        [
          '$include: "./base.yaml"',
          "gateway:",
          "  port: 9876",
        ].join("\n") + "\n",
        "utf-8",
      );

      const result = loadConfigFile(mainPath, { includeDeps });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const gateway = result.value.gateway as Record<string, unknown>;
      expect(gateway.port).toBe(9876); // sibling override
      expect(gateway.host).toBe("0.0.0.0"); // from base
      expect(gateway.enabled).toBe(true); // from base
    });

    it("$include with missing file produces INCLUDE_ERROR", () => {
      const configPath = join(tmpDir, "missing-include.yaml");
      writeFileSync(
        configPath,
        [
          '$include: "./does-not-exist.yaml"',
          'tenantId: "test"',
        ].join("\n") + "\n",
        "utf-8",
      );

      const result = loadConfigFile(configPath, { includeDeps });
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const error = result.error as ConfigError;
      expect(error.code).toBe("INCLUDE_ERROR");
    });

    it("circular $include produces CIRCULAR_INCLUDE error", () => {
      const aPath = join(tmpDir, "a.yaml");
      const bPath = join(tmpDir, "b.yaml");

      writeFileSync(
        aPath,
        [
          '$include: "./b.yaml"',
          'tenantId: "a"',
        ].join("\n") + "\n",
        "utf-8",
      );

      writeFileSync(
        bPath,
        [
          '$include: "./a.yaml"',
          'tenantId: "b"',
        ].join("\n") + "\n",
        "utf-8",
      );

      const result = loadConfigFile(aPath, { includeDeps });
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const error = result.error as ConfigError;
      expect(error.code).toBe("CIRCULAR_INCLUDE");
    });

    it("nested $include chain resolves correctly", () => {
      const level2Path = join(tmpDir, "level2.yaml");
      writeFileSync(
        level2Path,
        [
          "gateway:",
          "  port: 7777",
          'tenantId: "base"',
        ].join("\n") + "\n",
        "utf-8",
      );

      const level1Path = join(tmpDir, "level1.yaml");
      writeFileSync(
        level1Path,
        [
          '$include: "./level2.yaml"',
          'tenantId: "override"',
        ].join("\n") + "\n",
        "utf-8",
      );

      const result = loadConfigFile(level1Path, { includeDeps });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // level1 tenantId overrides level2
      expect(result.value.tenantId).toBe("override");
      // gateway from level2 is preserved
      const gateway = result.value.gateway as Record<string, unknown>;
      expect(gateway.port).toBe(7777);
    });

    it("combined $include + env substitution pipeline", () => {
      const baseVarsPath = join(tmpDir, "base-with-vars.yaml");
      writeFileSync(
        baseVarsPath,
        'tenantId: "${MY_TENANT}"\n',
        "utf-8",
      );

      const overlayPath = join(tmpDir, "overlay.yaml");
      writeFileSync(
        overlayPath,
        [
          '$include: "./base-with-vars.yaml"',
          'logLevel: "debug"',
        ].join("\n") + "\n",
        "utf-8",
      );

      const result = loadConfigFile(overlayPath, {
        includeDeps,
        getSecret: (key: string) =>
          key === "MY_TENANT" ? "combined-test" : undefined,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.tenantId).toBe("combined-test");
      expect(result.value.logLevel).toBe("debug");
    });
  });
});
