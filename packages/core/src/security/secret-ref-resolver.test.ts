import { describe, it, expect, vi } from "vitest";
import { createSecretManager } from "./secret-manager.js";
import { resolveSecretRef, resolveConfigSecretRefs } from "./secret-ref-resolver.js";
import type { ResolveSecretRefDeps } from "./secret-ref-resolver.js";
import type { SecretRef } from "../domain/secret-ref.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(
  env: Record<string, string> = {},
  overrides: Partial<ResolveSecretRefDeps> = {},
): ResolveSecretRefDeps {
  return {
    secretManager: createSecretManager(env),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveSecretRef — env source
// ---------------------------------------------------------------------------

describe("resolveSecretRef — env source", () => {
  it("resolves a known env key", () => {
    const deps = makeDeps({ TELEGRAM_BOT_TOKEN: "my-secret-token" });
    const ref: SecretRef = { source: "env", provider: "telegram", id: "TELEGRAM_BOT_TOKEN" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("my-secret-token");
  });

  it("returns error for unknown env key", () => {
    const deps = makeDeps({});
    const ref: SecretRef = { source: "env", provider: "telegram", id: "MISSING_KEY" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not found in SecretManager");
  });
});

// ---------------------------------------------------------------------------
// resolveSecretRef — file source
// ---------------------------------------------------------------------------

describe("resolveSecretRef — file source", () => {
  it("reads a single-value file and trims whitespace", () => {
    const deps = makeDeps({}, {
      statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 20, mode: 0o600 }),
      readFileSync: () => "  secret-from-file  \n",
    });
    const ref: SecretRef = { source: "file", provider: "vault", id: "/secrets/api.key" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("secret-from-file");
  });

  it("extracts value via JSON Pointer from JSON file", () => {
    const jsonContent = JSON.stringify({
      data: { apiKey: "extracted-key", other: "ignored" },
    });
    const deps = makeDeps({}, {
      statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100, mode: 0o600 }),
      readFileSync: () => jsonContent,
    });
    const ref: SecretRef = {
      source: "file",
      provider: "vault#/data/apiKey",
      id: "/secrets/vault-response.json",
    };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("extracted-key");
  });

  it("rejects relative paths", () => {
    const deps = makeDeps();
    const ref: SecretRef = { source: "file", provider: "vault", id: "relative/path.key" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("absolute path");
  });

  it("rejects paths with traversal segments", () => {
    const deps = makeDeps();
    const ref: SecretRef = { source: "file", provider: "vault", id: "/secrets/../etc/passwd" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("traversal");
  });

  it("rejects files exceeding size limit", () => {
    const deps = makeDeps({}, {
      statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 2_000_000, mode: 0o600 }),
    });
    const ref: SecretRef = { source: "file", provider: "vault", id: "/secrets/big.key" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("exceeds size limit");
  });

  it("returns error for nonexistent file", () => {
    const deps = makeDeps({}, {
      statSync: () => { throw new Error("ENOENT"); },
    });
    const ref: SecretRef = { source: "file", provider: "vault", id: "/secrets/missing.key" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not found");
  });

  it("rejects non-file (directory)", () => {
    const deps = makeDeps({}, {
      statSync: () => ({ isFile: () => false, isSymbolicLink: () => false, size: 0, mode: 0o755 }),
    });
    const ref: SecretRef = { source: "file", provider: "vault", id: "/secrets" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not a regular file");
  });

  it("returns error when JSON Pointer target is not a string", () => {
    const jsonContent = JSON.stringify({ data: { nested: { value: 42 } } });
    const deps = makeDeps({}, {
      statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 50, mode: 0o600 }),
      readFileSync: () => jsonContent,
    });
    const ref: SecretRef = {
      source: "file",
      provider: "vault#/data/nested",
      id: "/secrets/vault.json",
    };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("expected string");
  });
});

// ---------------------------------------------------------------------------
// resolveSecretRef — exec source
// ---------------------------------------------------------------------------

describe("resolveSecretRef — exec source", () => {
  it("resolves value from valid JSON RPC response", () => {
    const mockExecFileSync = vi.fn().mockReturnValue(
      JSON.stringify({
        protocolVersion: 1,
        values: { "my-secret-id": "resolved-secret" },
      }),
    );
    const deps = makeDeps({}, { execFileSync: mockExecFileSync });
    const ref: SecretRef = { source: "exec", provider: "op", id: "my-secret-id" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("resolved-secret");

    // Verify protocol: command is ref.provider, args is empty array, input is JSON
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "op",
      [],
      expect.objectContaining({
        input: expect.stringContaining('"ids":["my-secret-id"]'),
        encoding: "utf-8",
      }),
    );
  });

  it("returns error when command fails (timeout etc)", () => {
    const mockExecFileSync = vi.fn().mockImplementation(() => {
      throw new Error("ETIMEDOUT");
    });
    const deps = makeDeps({}, { execFileSync: mockExecFileSync });
    const ref: SecretRef = { source: "exec", provider: "slow-helper", id: "key" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("command failed");
  });

  it("returns error for invalid JSON response", () => {
    const mockExecFileSync = vi.fn().mockReturnValue("not-json");
    const deps = makeDeps({}, { execFileSync: mockExecFileSync });
    const ref: SecretRef = { source: "exec", provider: "broken-helper", id: "key" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("invalid JSON");
  });

  it("returns error for wrong protocol version", () => {
    const mockExecFileSync = vi.fn().mockReturnValue(
      JSON.stringify({ protocolVersion: 2, values: {} }),
    );
    const deps = makeDeps({}, { execFileSync: mockExecFileSync });
    const ref: SecretRef = { source: "exec", provider: "future-helper", id: "key" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("protocol");
  });

  it("returns error when requested key is missing from response", () => {
    const mockExecFileSync = vi.fn().mockReturnValue(
      JSON.stringify({ protocolVersion: 1, values: { "other-key": "val" } }),
    );
    const deps = makeDeps({}, { execFileSync: mockExecFileSync });
    const ref: SecretRef = { source: "exec", provider: "op", id: "missing-key" };

    const result = resolveSecretRef(ref, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// resolveConfigSecretRefs — deep walk
// ---------------------------------------------------------------------------

describe("resolveConfigSecretRefs", () => {
  it("resolves nested SecretRef objects in config", () => {
    const deps = makeDeps({
      TELEGRAM_BOT_TOKEN: "tg-resolved",
      DISCORD_BOT_TOKEN: "dc-resolved",
    });
    const config = {
      channels: {
        telegram: {
          enabled: true,
          botToken: { source: "env", provider: "telegram", id: "TELEGRAM_BOT_TOKEN" },
        },
        discord: {
          enabled: true,
          botToken: { source: "env", provider: "discord", id: "DISCORD_BOT_TOKEN" },
        },
      },
      plainField: "stays-unchanged",
    };

    const result = resolveConfigSecretRefs(
      config as unknown as Record<string, unknown>,
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolved = result.value as typeof config;
      expect(resolved.channels.telegram.botToken).toBe("tg-resolved");
      expect(resolved.channels.discord.botToken).toBe("dc-resolved");
      expect(resolved.plainField).toBe("stays-unchanged");
      // Original should not be mutated
      expect(config.channels.telegram.botToken).toEqual({
        source: "env",
        provider: "telegram",
        id: "TELEGRAM_BOT_TOKEN",
      });
    }
  });

  it("returns first error when any ref fails", () => {
    const deps = makeDeps({}); // empty — env lookups will fail
    const config = {
      good: "plain-string",
      bad: { source: "env", provider: "x", id: "MISSING" },
    };

    const result = resolveConfigSecretRefs(config as Record<string, unknown>, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not found in SecretManager");
  });

  it("returns clone unchanged when no SecretRefs present", () => {
    const deps = makeDeps();
    const config = {
      channels: { telegram: { enabled: false, botToken: "plain" } },
      nested: { array: [1, 2, 3] },
    };

    const result = resolveConfigSecretRefs(
      config as unknown as Record<string, unknown>,
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(config);
      // Must be a different object (clone)
      expect(result.value).not.toBe(config);
    }
  });

  it("resolves SecretRefs inside arrays", () => {
    const deps = makeDeps({ TOKEN_1: "val-1", TOKEN_2: "val-2" });
    const config = {
      tokens: [
        { source: "env", provider: "gw", id: "TOKEN_1" },
        "plain-token",
        { source: "env", provider: "gw", id: "TOKEN_2" },
      ],
    };

    const result = resolveConfigSecretRefs(config as Record<string, unknown>, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolved = result.value as { tokens: string[] };
      expect(resolved.tokens).toEqual(["val-1", "plain-token", "val-2"]);
    }
  });
});
