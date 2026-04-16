/**
 * Unit tests for provider-env.ts.
 *
 * Tests all exports: PROVIDER_KEYS, PROVIDER_GROUPS, getProviderEnv,
 * hasProvider, hasAnyProvider, createTestSecretManager,
 * logProviderAvailability, and isAuthError.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  PROVIDER_KEYS,
  PROVIDER_GROUPS,
  getProviderEnv,
  hasProvider,
  hasAnyProvider,
  createTestSecretManager,
  logProviderAvailability,
  isAuthError,
} from "./provider-env.js";

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

const TEST_DIR = resolve(tmpdir(), `provider-env-test-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });

let tempFiles: string[] = [];

function writeTempEnv(content: string): string {
  const path = resolve(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(path, content, "utf-8");
  tempFiles.push(path);
  return path;
}

afterEach(() => {
  for (const f of tempFiles) {
    try {
      unlinkSync(f);
    } catch {
      // already cleaned
    }
  }
  tempFiles = [];
  // Clean up any process.env modifications
  delete process.env["ANTHROPIC_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
});

// Cleanup test directory at end
afterEach(() => {
  // Final cleanup handled by OS temp directory lifecycle
});

// ---------------------------------------------------------------------------
// PROVIDER_KEYS and PROVIDER_GROUPS
// ---------------------------------------------------------------------------

describe("PROVIDER_KEYS and PROVIDER_GROUPS", () => {
  it("has entries for all 13 known providers", () => {
    expect(Object.keys(PROVIDER_KEYS).length).toBe(13);
  });

  it("includes ANTHROPIC_API_KEY", () => {
    expect(PROVIDER_KEYS.ANTHROPIC_API_KEY).toBe("Anthropic (Claude)");
  });

  it("includes SEARCH_API_KEY", () => {
    expect(PROVIDER_KEYS.SEARCH_API_KEY).toBe("Brave Search");
  });

  it("includes PERPLEXITY_API_KEY", () => {
    expect(PROVIDER_KEYS.PERPLEXITY_API_KEY).toBe("Perplexity AI");
  });

  it("PROVIDER_GROUPS.llm contains ANTHROPIC_API_KEY and OPENAI_API_KEY", () => {
    expect(PROVIDER_GROUPS.llm).toContain("ANTHROPIC_API_KEY");
    expect(PROVIDER_GROUPS.llm).toContain("OPENAI_API_KEY");
  });

  it("PROVIDER_GROUPS.search contains SEARCH_API_KEY and PERPLEXITY_API_KEY", () => {
    expect(PROVIDER_GROUPS.search).toContain("SEARCH_API_KEY");
    expect(PROVIDER_GROUPS.search).toContain("PERPLEXITY_API_KEY");
  });

  it("PROVIDER_GROUPS.tts contains ELEVENLABS_API_KEY", () => {
    expect(PROVIDER_GROUPS.tts).toContain("ELEVENLABS_API_KEY");
  });

  it("every key in PROVIDER_GROUPS is a valid PROVIDER_KEYS key", () => {
    const validKeys = new Set(Object.keys(PROVIDER_KEYS));
    for (const [group, keys] of Object.entries(PROVIDER_GROUPS)) {
      for (const key of keys) {
        expect(validKeys.has(key), `${key} in group ${group} is not a valid PROVIDER_KEYS key`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getProviderEnv
// ---------------------------------------------------------------------------

describe("getProviderEnv", () => {
  it("returns empty-ish record when .env file does not exist", () => {
    const env = getProviderEnv(`/tmp/no-such-file-${Date.now()}.env`);
    // All values should be undefined (no file, no process.env set)
    for (const key of Object.keys(PROVIDER_KEYS)) {
      if (!process.env[key]) {
        expect(env[key]).toBeUndefined();
      }
    }
  });

  it("parses a valid .env file", () => {
    const path = writeTempEnv("ANTHROPIC_API_KEY=test-key-123\n");
    const env = getProviderEnv(path);
    expect(env["ANTHROPIC_API_KEY"]).toBe("test-key-123");
  });

  it("strips surrounding double quotes", () => {
    const path = writeTempEnv('OPENAI_API_KEY="sk-quoted-key"\n');
    const env = getProviderEnv(path);
    expect(env["OPENAI_API_KEY"]).toBe("sk-quoted-key");
  });

  it("strips surrounding single quotes", () => {
    const path = writeTempEnv("OPENAI_API_KEY='sk-single-quoted'\n");
    const env = getProviderEnv(path);
    expect(env["OPENAI_API_KEY"]).toBe("sk-single-quoted");
  });

  it("skips comments and blank lines", () => {
    const path = writeTempEnv(
      "# This is a comment\n\nANTHROPIC_API_KEY=real-key\n# Another comment\n",
    );
    const env = getProviderEnv(path);
    expect(env["ANTHROPIC_API_KEY"]).toBe("real-key");
  });

  it("process.env takes priority over file values", () => {
    process.env["ANTHROPIC_API_KEY"] = "from-env";
    const path = writeTempEnv("ANTHROPIC_API_KEY=from-file\n");
    const env = getProviderEnv(path);
    expect(env["ANTHROPIC_API_KEY"]).toBe("from-env");
  });
});

// ---------------------------------------------------------------------------
// hasProvider
// ---------------------------------------------------------------------------

describe("hasProvider", () => {
  it("returns true for non-empty string value", () => {
    expect(hasProvider({ KEY: "value" }, "KEY")).toBe(true);
  });

  it("returns false for undefined value", () => {
    expect(hasProvider({ KEY: undefined }, "KEY")).toBe(false);
  });

  it("returns false for empty string value", () => {
    expect(hasProvider({ KEY: "" }, "KEY")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasAnyProvider
// ---------------------------------------------------------------------------

describe("hasAnyProvider", () => {
  it("returns true when at least one key is available", () => {
    const env = { A: "val", B: undefined };
    expect(hasAnyProvider(env, ["A", "B"])).toBe(true);
  });

  it("returns false when no keys are available", () => {
    const env = { A: undefined, B: undefined };
    expect(hasAnyProvider(env, ["A", "B"])).toBe(false);
  });

  it("returns true even if only the last key in the list is available", () => {
    const env = { A: undefined, B: undefined, C: "present" };
    expect(hasAnyProvider(env, ["A", "B", "C"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createTestSecretManager
// ---------------------------------------------------------------------------

describe("createTestSecretManager", () => {
  it("returns a SecretManager with get() and has() methods", () => {
    const path = writeTempEnv("ANTHROPIC_API_KEY=sm-test-key\n");
    const sm = createTestSecretManager(path);
    expect(typeof sm.get).toBe("function");
    expect(typeof sm.has).toBe("function");
  });

  it("SecretManager.has() returns true for keys present in env file", () => {
    const path = writeTempEnv("ANTHROPIC_API_KEY=sm-test-key\n");
    const sm = createTestSecretManager(path);
    expect(sm.has("ANTHROPIC_API_KEY")).toBe(true);
  });

  it("SecretManager.get() returns the value for a present key", () => {
    const path = writeTempEnv("ANTHROPIC_API_KEY=sm-test-key\n");
    const sm = createTestSecretManager(path);
    expect(sm.get("ANTHROPIC_API_KEY")).toBe("sm-test-key");
  });

  it("SecretManager.require() throws for missing keys", () => {
    const path = writeTempEnv("");
    const sm = createTestSecretManager(path);
    expect(() => sm.require("NONEXISTENT_KEY")).toThrow(/NONEXISTENT_KEY/);
  });
});

// ---------------------------------------------------------------------------
// logProviderAvailability
// ---------------------------------------------------------------------------

describe("logProviderAvailability", () => {
  it("logs available and missing providers", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "key-1",
    };
    logProviderAvailability(env);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0]).toContain("[provider-env] Available:");
    expect(spy.mock.calls[0]![0]).toContain("Anthropic (Claude)");
    expect(spy.mock.calls[1]![0]).toContain("[provider-env] Missing:");
    spy.mockRestore();
  });

  it('shows "(none)" when no providers are available', () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logProviderAvailability({});

    expect(spy.mock.calls[0]![0]).toContain("(none)");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// isAuthError
// ---------------------------------------------------------------------------

describe("isAuthError", () => {
  it('returns true for Error with "401" in message', () => {
    expect(isAuthError(new Error("HTTP 401 Unauthorized"))).toBe(true);
  });

  it('returns true for Error with "403" in message', () => {
    expect(isAuthError(new Error("HTTP 403 Forbidden"))).toBe(true);
  });

  it('returns true for Error with "authentication" in message (case-insensitive)', () => {
    expect(isAuthError(new Error("Authentication required"))).toBe(true);
  });

  it('returns true for Error with "unauthorized" in message (case-insensitive)', () => {
    expect(isAuthError(new Error("Request Unauthorized"))).toBe(true);
  });

  it('returns true for Error with "forbidden" in message (case-insensitive)', () => {
    expect(isAuthError(new Error("Access Forbidden"))).toBe(true);
  });

  it('returns false for Error with "404" in message', () => {
    expect(isAuthError(new Error("HTTP 404 Not Found"))).toBe(false);
  });

  it('returns false for non-Error string with "500"', () => {
    expect(isAuthError("Internal Server Error 500")).toBe(false);
  });

  it('returns true for non-Error string containing "401"', () => {
    expect(isAuthError("Got 401 from server")).toBe(true);
  });
});
