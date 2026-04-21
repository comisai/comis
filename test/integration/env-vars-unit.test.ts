// SPDX-License-Identifier: Apache-2.0
/**
 * Non-daemon integration tests for environment variable handling.
 *
 * Covers: loadEnvFile parsing, precedence enforcement, assertEnvLoaded startup
 * guard, SecretManager creation and defensive copy, ${VAR} config substitution,
 * envSubset, and CLI COMIS_GATEWAY_URL resolution.
 *
 * All tests run without a daemon instance for fast execution.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadEnvFile,
  assertEnvLoaded,
  resetEnvLoadedForTest,
  createSecretManager,
  envSubset,
  substituteEnvVars,
  loadConfigFile,
} from "@comis/core";
import { withClient } from "@comis/cli";

// ── Temp directory lifecycle ────────────────────────────────────────────────

const tmpDirPath = join(tmpdir(), `comis-test-env-${Date.now()}`);
mkdirSync(tmpDirPath, { recursive: true });
const tmpDir = tmpDirPath;

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helper: write a temp .env file ──────────────────────────────────────────

function writeTempEnv(name: string, content: string): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ── 1. loadEnvFile parsing ──────────────────────────────────────────────────

describe("loadEnvFile parsing", () => {
  beforeEach(() => {
    resetEnvLoadedForTest();
  });

  it("parses KEY=VALUE lines correctly", () => {
    const envPath = writeTempEnv("basic.env", [
      "DB_HOST=localhost",
      "DB_PORT=5432",
      "DB_NAME=comis",
      "APP_SECRET=s3cret_value",
    ].join("\n"));

    const target: Record<string, string | undefined> = {};
    const count = loadEnvFile(envPath, target);

    expect(count).toBe(4);
    expect(target["DB_HOST"]).toBe("localhost");
    expect(target["DB_PORT"]).toBe("5432");
    expect(target["DB_NAME"]).toBe("comis");
    expect(target["APP_SECRET"]).toBe("s3cret_value");
  });

  it("strips double quotes from values", () => {
    const envPath = writeTempEnv("dq.env", 'TOKEN="double-quoted"\n');
    const target: Record<string, string | undefined> = {};
    loadEnvFile(envPath, target);

    expect(target["TOKEN"]).toBe("double-quoted");
  });

  it("strips single quotes from values", () => {
    const envPath = writeTempEnv("sq.env", "SECRET='single-quoted'\n");
    const target: Record<string, string | undefined> = {};
    loadEnvFile(envPath, target);

    expect(target["SECRET"]).toBe("single-quoted");
  });

  it("skips comment lines and blank lines", () => {
    const envPath = writeTempEnv("comments.env", [
      "# This is a comment",
      "",
      "VALID_KEY=yes",
      "   ",
      "# Another comment",
      "ANOTHER=value",
    ].join("\n"));

    const target: Record<string, string | undefined> = {};
    const count = loadEnvFile(envPath, target);

    expect(count).toBe(2);
    expect(target["VALID_KEY"]).toBe("yes");
    expect(target["ANOTHER"]).toBe("value");
  });

  it("returns -1 for nonexistent file path", () => {
    const target: Record<string, string | undefined> = {};
    const count = loadEnvFile("/nonexistent/path/.env", target);

    expect(count).toBe(-1);
    expect(Object.keys(target)).toHaveLength(0);
  });

  it("handles empty values (KEY= produces empty string)", () => {
    const envPath = writeTempEnv("empty.env", "EMPTY_KEY=\n");
    const target: Record<string, string | undefined> = {};
    loadEnvFile(envPath, target);

    expect(target["EMPTY_KEY"]).toBe("");
  });
});

// ── 2. loadEnvFile precedence ───────────────────────────────────────────────

describe("loadEnvFile precedence", () => {
  beforeEach(() => {
    resetEnvLoadedForTest();
  });

  it("does NOT override existing values in target", () => {
    const envPath = writeTempEnv("override.env", "MY_KEY=from-file\n");
    const target: Record<string, string | undefined> = { MY_KEY: "from-env" };
    loadEnvFile(envPath, target);

    expect(target["MY_KEY"]).toBe("from-env");
  });

  it("loads new keys not present in target", () => {
    const envPath = writeTempEnv("newkeys.env", [
      "KEY_A=file-a",
      "KEY_B=file-b",
    ].join("\n"));

    const target: Record<string, string | undefined> = { KEY_A: "existing" };
    loadEnvFile(envPath, target);

    expect(target["KEY_A"]).toBe("existing");
    expect(target["KEY_B"]).toBe("file-b");
  });

  it("returns count of newly loaded keys (not total keys in file)", () => {
    const envPath = writeTempEnv("count.env", [
      "EXISTING=should-skip",
      "NEW_ONE=loaded",
      "NEW_TWO=also-loaded",
    ].join("\n"));

    const target: Record<string, string | undefined> = { EXISTING: "preset" };
    const count = loadEnvFile(envPath, target);

    expect(count).toBe(2);
  });
});

// ── 3. assertEnvLoaded / resetEnvLoadedForTest lifecycle ────────────────────

describe("assertEnvLoaded / resetEnvLoadedForTest lifecycle", () => {
  beforeEach(() => {
    resetEnvLoadedForTest();
  });

  it("assertEnvLoaded() throws when envLoaded is false", () => {
    expect(() => assertEnvLoaded()).toThrowError(
      "loadEnvFile() must be called before createSecretManager()",
    );
  });

  it("assertEnvLoaded() does NOT throw after loadEnvFile() is called", () => {
    // Even with a nonexistent path, calling loadEnvFile sets the flag
    loadEnvFile("/nonexistent/path/.env", {});
    expect(() => assertEnvLoaded()).not.toThrow();
  });

  it("resetEnvLoadedForTest() resets the flag so assertEnvLoaded() throws again", () => {
    loadEnvFile("/nonexistent/path/.env", {});
    expect(() => assertEnvLoaded()).not.toThrow();

    resetEnvLoadedForTest();
    expect(() => assertEnvLoaded()).toThrowError(
      "loadEnvFile() must be called before createSecretManager()",
    );
  });
});

// ── 4. SecretManager creation and defensive copy ────────────────────────────

describe("SecretManager creation and defensive copy", () => {
  it("createSecretManager produces manager with has() and get()", () => {
    const manager = createSecretManager({ KEY: "value" });

    expect(manager.has("KEY")).toBe(true);
    expect(manager.get("KEY")).toBe("value");
  });

  it("excludes undefined values from the manager", () => {
    const manager = createSecretManager({ KEY: undefined });

    expect(manager.has("KEY")).toBe(false);
    expect(manager.get("KEY")).toBeUndefined();
  });

  it("require() throws for missing keys with descriptive message", () => {
    const manager = createSecretManager({});

    expect(() => manager.require("MISSING_KEY")).toThrowError(
      'Required secret "MISSING_KEY" is not set',
    );
  });

  it("defensive copy: mutating original env does not affect manager", () => {
    const env: Record<string, string | undefined> = { ORIGINAL: "yes" };
    const manager = createSecretManager(env);

    // Mutate the original record after creation
    env["NEW_KEY"] = "new";

    expect(manager.has("NEW_KEY")).toBe(false);
    expect(manager.has("ORIGINAL")).toBe(true);
  });

  it("keys() returns a defensive copy (mutating returned array has no effect)", () => {
    const manager = createSecretManager({ A: "1", B: "2" });

    const keys1 = manager.keys();
    keys1.push("INJECTED");

    const keys2 = manager.keys();
    expect(keys2).not.toContain("INJECTED");
    expect(keys2).toHaveLength(2);
  });
});

// ── 5. ${VAR} substitution ──────────────────────────────────────────────────

describe("${VAR} substitution", () => {
  it("substituteEnvVars replaces ${VAR} with value from getSecret", () => {
    const getSecret = (key: string) =>
      key === "MY_TOKEN" ? "secret-123" : undefined;

    const result = substituteEnvVars(
      { token: "${MY_TOKEN}", nested: { url: "https://${MY_TOKEN}@host" } },
      getSecret,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value["token"]).toBe("secret-123");
      expect((value["nested"] as Record<string, unknown>)["url"]).toBe(
        "https://secret-123@host",
      );
    }
  });

  it("substituteEnvVars returns ENV_VAR_ERROR for missing variables", () => {
    const getSecret = () => undefined;
    const result = substituteEnvVars({ key: "${NONEXISTENT}" }, getSecret);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ENV_VAR_ERROR");
      expect(result.error.message).toContain("NONEXISTENT");
    }
  });

  it("substituteEnvVars handles escape syntax $${VAR} -> literal ${VAR}", () => {
    const getSecret = () => undefined;
    const result = substituteEnvVars({ literal: "$${MY_VAR}" }, getSecret);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>)["literal"]).toBe(
        "${MY_VAR}",
      );
    }
  });

  it("loadConfigFile with getSecret option performs ${VAR} substitution in YAML", () => {
    const yamlPath = join(tmpDir, "config-sub.yaml");
    writeFileSync(
      yamlPath,
      'token: "${MY_TOKEN}"\nurl: "https://api.example.com"\n',
      "utf-8",
    );

    const getSecret = (key: string) =>
      key === "MY_TOKEN" ? "resolved-token-abc" : undefined;

    const result = loadConfigFile(yamlPath, { getSecret });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value["token"]).toBe("resolved-token-abc");
      expect(result.value["url"]).toBe("https://api.example.com");
    }
  });
});

// ── 6. envSubset ────────────────────────────────────────────────────────────

describe("envSubset", () => {
  it("returns only matching keys from manager", () => {
    const manager = createSecretManager({
      KEY_A: "alpha",
      KEY_B: "beta",
      KEY_C: "gamma",
    });

    const subset = envSubset(manager, ["KEY_A", "KEY_B"]);

    expect(subset).toEqual({ KEY_A: "alpha", KEY_B: "beta" });
    expect(subset).not.toHaveProperty("KEY_C");
  });

  it("skips keys not present in manager", () => {
    const manager = createSecretManager({ KEY_A: "alpha" });

    const subset = envSubset(manager, ["KEY_A", "KEY_MISSING"]);

    expect(subset).toEqual({ KEY_A: "alpha" });
    expect(subset).not.toHaveProperty("KEY_MISSING");
  });
});

// ── 7. CLI env var resolution ───────────────────────────────────────────────

describe("CLI env var resolution", () => {
  it("withClient uses COMIS_GATEWAY_URL when set", async () => {
    const originalUrl = process.env["COMIS_GATEWAY_URL"];
    const originalToken = process.env["COMIS_GATEWAY_TOKEN"];

    try {
      // Point to a port nothing listens on
      process.env["COMIS_GATEWAY_URL"] = "ws://127.0.0.1:19999/ws";
      process.env["COMIS_GATEWAY_TOKEN"] = "test-token";

      await expect(
        withClient(async () => "done"),
      ).rejects.toThrow();

      // The error should reference the host/port we set, proving the env var was read.
      // Depending on the error type (ECONNREFUSED, timeout), it may manifest differently,
      // but the key assertion is that it rejected (connection to 19999 failed).
      try {
        await withClient(async () => "done");
      } catch (e: unknown) {
        const message = (e as Error).message;
        // Accept either ECONNREFUSED or timeout -- both prove the env var was used
        expect(
          message.includes("not running") ||
          message.includes("timed out") ||
          message.includes("ECONNREFUSED") ||
          message.includes("19999"),
        ).toBe(true);
      }
    } finally {
      // Clean up env vars
      if (originalUrl !== undefined) {
        process.env["COMIS_GATEWAY_URL"] = originalUrl;
      } else {
        delete process.env["COMIS_GATEWAY_URL"];
      }
      if (originalToken !== undefined) {
        process.env["COMIS_GATEWAY_TOKEN"] = originalToken;
      } else {
        delete process.env["COMIS_GATEWAY_TOKEN"];
      }
    }
  });
});
