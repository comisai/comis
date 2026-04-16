/**
 * SecretManager Integration Tests (non-daemon)
 *
 * Validates the full cross-package lifecycle chain:
 *   loadEnvFile (@comis/core) -> assertEnvLoaded (@comis/core) ->
 *   createSecretManager (@comis/core) -> envSubset (@comis/core)
 *
 * Also exercises defensive snapshot isolation, API surface correctness,
 * log sanitizer 8-pattern coverage with idempotency, and provider-dynamic
 * key naming convention for all 10 known providers.
 *
 * All imports come from built dist/ packages via vitest aliases --
 * this is integration testing, not unit testing.
 *
 *   SM-01: Cross-Package Lifecycle Chain
 *   SM-02: Defensive Snapshot Isolation
 *   SM-03: API Surface (get/has/require/keys)
 *   SM-04: envSubset
 *   SM-05: Log Sanitizer 8-Pattern Comprehensive
 *   SM-06: Provider-Dynamic Key Convention
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  loadEnvFile,
  assertEnvLoaded,
  resetEnvLoadedForTest,
  createSecretManager,
  envSubset,
  sanitizeLogString,
} from "@comis/core";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = join(tmpdir(), `comis-test-sm-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetEnvLoadedForTest();
});

// ---------------------------------------------------------------------------
// SM-01: Cross-Package Lifecycle Chain
// ---------------------------------------------------------------------------

describe("SM-01: Cross-Package Lifecycle Chain", () => {
  it("assertEnvLoaded throws before loadEnvFile is called", () => {
    expect(() => assertEnvLoaded()).toThrow("loadEnvFile() must be called");
  });

  it("loadEnvFile -> assertEnvLoaded -> createSecretManager -> envSubset chain works", () => {
    const envPath = join(tmpDir, ".env-sm01");
    writeFileSync(
      envPath,
      "ANTHROPIC_API_KEY=test-ant-key\nOPENAI_API_KEY=test-oai-key\n",
    );

    // assertEnvLoaded throws before loadEnvFile
    expect(() => assertEnvLoaded()).toThrow("loadEnvFile() must be called");

    // loadEnvFile parses and sets the guard flag
    const target: Record<string, string | undefined> = {};
    const count = loadEnvFile(envPath, target);
    expect(count).toBe(2);

    // assertEnvLoaded no longer throws
    expect(() => assertEnvLoaded()).not.toThrow();

    // createSecretManager works with loaded values
    const manager = createSecretManager(target);
    expect(manager.get("ANTHROPIC_API_KEY")).toBe("test-ant-key");
    expect(manager.get("OPENAI_API_KEY")).toBe("test-oai-key");

    // envSubset returns only requested keys
    const subset = envSubset(manager, ["ANTHROPIC_API_KEY"]);
    expect(subset).toEqual({ ANTHROPIC_API_KEY: "test-ant-key" });
    expect(Object.keys(subset)).not.toContain("OPENAI_API_KEY");
  });

  it("assertEnvLoaded does not throw after loadEnvFile with missing file", () => {
    const missingPath = join(tmpDir, "nonexistent.env");

    // loadEnvFile returns -1 for missing file but still sets the guard flag
    const count = loadEnvFile(missingPath);
    expect(count).toBe(-1);

    // Guard flag is set even for missing files
    expect(() => assertEnvLoaded()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SM-02: Defensive Snapshot Isolation
// ---------------------------------------------------------------------------

describe("SM-02: Defensive Snapshot Isolation", () => {
  it("mutations to source record after creation have no effect", () => {
    const env: Record<string, string | undefined> = { TEST_KEY: "original" };
    const manager = createSecretManager(env);

    // Mutate the original record
    env.TEST_KEY = "mutated";
    expect(manager.get("TEST_KEY")).toBe("original");

    // Add a new key to the original record
    env.NEW_KEY = "new";
    expect(manager.has("NEW_KEY")).toBe(false);
  });

  it("deletion from source record after creation has no effect", () => {
    const env: Record<string, string | undefined> = {
      KEY_A: "a-value",
      KEY_B: "b-value",
    };
    const manager = createSecretManager(env);

    // Delete from source
    delete env.KEY_A;
    expect(manager.get("KEY_A")).toBe("a-value");
    expect(manager.has("KEY_A")).toBe(true);
  });

  it("process.env mutations after creation have no effect on the manager", () => {
    const uniqueKey = `COMIS_TEST_SNAPSHOT_${Date.now()}`;
    try {
      process.env[uniqueKey] = "original";
      const manager = createSecretManager(process.env);
      expect(manager.get(uniqueKey)).toBe("original");

      // Mutate process.env after creation
      process.env[uniqueKey] = "mutated";
      expect(manager.get(uniqueKey)).toBe("original");
    } finally {
      delete process.env[uniqueKey];
    }
  });
});

// ---------------------------------------------------------------------------
// SM-03: API Surface (get/has/require/keys)
// ---------------------------------------------------------------------------

describe("SM-03: API Surface (get/has/require/keys)", () => {
  const env = { KEY_A: "value-a", KEY_B: "value-b" };
  let manager: ReturnType<typeof createSecretManager>;

  beforeEach(() => {
    manager = createSecretManager(env);
  });

  it("get returns undefined for missing key", () => {
    expect(manager.get("MISSING_KEY")).toBeUndefined();
  });

  it("has returns false for missing key and true for existing key", () => {
    expect(manager.has("MISSING_KEY")).toBe(false);
    expect(manager.has("KEY_A")).toBe(true);
  });

  it("require throws for missing key with message containing the key name", () => {
    expect(() => manager.require("MISSING_KEY")).toThrow("MISSING_KEY");
  });

  it("require error message does NOT contain available key names", () => {
    try {
      manager.require("MISSING_KEY");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("KEY_A");
      expect(msg).not.toContain("KEY_B");
      expect(msg).not.toContain("value-a");
      expect(msg).not.toContain("value-b");
    }
  });

  it("keys returns all key names as string array", () => {
    const keys = manager.keys();
    expect(keys).toContain("KEY_A");
    expect(keys).toContain("KEY_B");
    expect(keys).toHaveLength(2);
  });

  it("keys returns a defensive copy -- mutating does not affect internal state", () => {
    const k1 = manager.keys();
    k1.push("INJECTED");
    expect(manager.keys()).not.toContain("INJECTED");
    expect(manager.keys()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// SM-04: envSubset
// ---------------------------------------------------------------------------

describe("SM-04: envSubset", () => {
  it("returns only requested keys that exist in manager", () => {
    const manager = createSecretManager({
      KEY_A: "a",
      KEY_B: "b",
      KEY_C: "c",
    });
    const subset = envSubset(manager, ["KEY_A", "KEY_B"]);
    expect(subset).toEqual({ KEY_A: "a", KEY_B: "b" });
    expect(Object.keys(subset)).not.toContain("KEY_C");
  });

  it("skips keys not present in manager and returns plain object", () => {
    const manager = createSecretManager({
      KEY_A: "a",
      KEY_B: "b",
    });
    const subset = envSubset(manager, ["KEY_A", "KEY_B", "MISSING"]);
    expect(subset).toEqual({ KEY_A: "a", KEY_B: "b" });
    expect("MISSING" in subset).toBe(false);
    // Returns a plain object, not a Map or other container
    expect(typeof subset).toBe("object");
    expect(subset.constructor).toBe(Object);
  });
});

// ---------------------------------------------------------------------------
// SM-05: Log Sanitizer 8-Pattern Comprehensive
// ---------------------------------------------------------------------------

describe("SM-05: Log Sanitizer 8-Pattern Comprehensive", () => {
  it("redacts all 8 credential types in a combined string", () => {
    const megaString = [
      "API key: sk-abcdefghijklmnopqrstuvwxyz1234567890abcd",
      "Auth: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "Bot: 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ-1234567",
      "AWS: AKIAIOSFODNN7EXAMPLE",
      "aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12",
      "DB: postgres://admin:supersecretpassword@db.example.com:5432/db",
      "Hex: " + "a".repeat(40),
      "GitHub: ghp_" + "A".repeat(36),
    ].join(" | ");

    const sanitized = sanitizeLogString(megaString);

    // All 8 patterns redacted
    expect(sanitized).toContain("sk-[REDACTED]");
    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).toContain("[REDACTED_BOT_TOKEN]");
    expect(sanitized).toContain("AKIA[REDACTED]");
    expect(sanitized).toContain("[REDACTED_AWS_SECRET]");
    expect(sanitized).toContain("[REDACTED_CONN_STRING]");
    expect(sanitized).toContain("[REDACTED_HEX]");
    expect(sanitized).toContain("gh[REDACTED]");

    // No raw credential fragments remain
    expect(sanitized).not.toContain("abcdefghij");
    expect(sanitized).not.toContain("eyJhbGci");
    expect(sanitized).not.toContain("supersecretpassword");
  });

  it("is idempotent -- calling twice produces the same result", () => {
    const input =
      "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig | sk-abcdefghijklmnopqrstuvwxyz1234567890abcd";

    const sanitized1 = sanitizeLogString(input);
    const sanitized2 = sanitizeLogString(sanitized1);
    expect(sanitized2).toBe(sanitized1);
  });

  it("handles empty and falsy inputs safely", () => {
    expect(sanitizeLogString("")).toBe("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = sanitizeLogString(undefined as any);
    expect(result).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// SM-06: Provider-Dynamic Key Convention
// ---------------------------------------------------------------------------

describe("SM-06: Provider-Dynamic Key Convention", () => {
  it("resolves all 10 known provider API keys via ${provider.toUpperCase()}_API_KEY convention", () => {
    const providers = [
      "anthropic",
      "openai",
      "google",
      "groq",
      "mistral",
      "deepseek",
      "xai",
      "together",
      "cerebras",
      "openrouter",
    ];

    const env: Record<string, string> = {};
    for (const p of providers) {
      env[`${p.toUpperCase()}_API_KEY`] = `test-key-${p}`;
    }

    const manager = createSecretManager(env);

    for (const p of providers) {
      expect(manager.get(`${p.toUpperCase()}_API_KEY`)).toBe(`test-key-${p}`);
    }

    // Verify all 10 keys are present
    expect(manager.keys()).toHaveLength(10);
  });
});
