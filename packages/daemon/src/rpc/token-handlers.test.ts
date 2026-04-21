// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenHandlers, createTokenRegistry } from "./token-handlers.js";
import type { TokenHandlerDeps } from "./token-handlers.js";
import type { PersistToConfigDeps } from "./persist-to-config.js";

// ---------------------------------------------------------------------------
// Mock persist-to-config module to avoid real filesystem operations
// ---------------------------------------------------------------------------

vi.mock("./persist-to-config.js", () => ({
  persistToConfig: vi.fn().mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } }),
}));

import { persistToConfig } from "./persist-to-config.js";
const mockPersistToConfig = vi.mocked(persistToConfig);

// ---------------------------------------------------------------------------
// Helper: create isolated deps per test to avoid shared state
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<TokenHandlerDeps>): TokenHandlerDeps {
  return {
    tokenRegistry: createTokenRegistry([
      { id: "test-token", scopes: ["rpc", "admin"] },
    ]),
    addToTokenStore: vi.fn(),
    removeFromTokenStore: vi.fn(),
    ...overrides,
  };
}

function makePersistDeps(): PersistToConfigDeps {
  return {
    container: {
      config: {
        tenantId: "test",
        gateway: { tokens: [{ id: "test-token", secret: "existing-secret-padded-to-meet-32-chars", scopes: ["rpc", "admin"] }] },
      },
      eventBus: { emit: vi.fn() },
    },
    configPaths: ["/tmp/test-config.yaml"],
    defaultConfigPaths: ["/tmp/default-config.yaml"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
  } as unknown as PersistToConfigDeps;
}

// ---------------------------------------------------------------------------
// Tests for createTokenRegistry
// ---------------------------------------------------------------------------

describe("createTokenRegistry", () => {
  it("list returns seeded tokens without secrets", () => {
    const registry = createTokenRegistry([
      { id: "tok-1", scopes: ["rpc"] },
      { id: "tok-2", scopes: ["admin", "ws"] },
    ]);

    const entries = registry.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe("tok-1");
    expect(entries[1]!.id).toBe("tok-2");

    // Verify no secret field exists on any entry
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("secret");
    }
  });

  it("create adds new token and returns it", () => {
    const registry = createTokenRegistry([]);

    const entry = registry.create("new-tok", "secret-value", ["rpc", "ws"]);
    expect(entry.id).toBe("new-tok");
    expect(entry.scopes).toEqual(["rpc", "ws"]);
    expect(entry.createdAt).toEqual(expect.any(Number));
    expect(entry.revoked).toBe(false);

    // Verify the entry does NOT contain the secret
    expect(entry).not.toHaveProperty("secret");

    // Verify it appears in list
    expect(registry.list()).toHaveLength(1);
  });

  it("revoke marks token as revoked and subsequent list excludes it", () => {
    const registry = createTokenRegistry([
      { id: "tok-1", scopes: ["rpc"] },
      { id: "tok-2", scopes: ["admin"] },
    ]);

    const revoked = registry.revoke("tok-1");
    expect(revoked).toBe(true);

    // list should only return the non-revoked token
    const entries = registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("tok-2");
  });

  it("revoke returns false for non-existent token", () => {
    const registry = createTokenRegistry([]);

    const revoked = registry.revoke("non-existent");
    expect(revoked).toBe(false);
  });

  it("revoke returns false for already-revoked token", () => {
    const registry = createTokenRegistry([
      { id: "tok-1", scopes: ["rpc"] },
    ]);

    registry.revoke("tok-1");
    const secondRevoke = registry.revoke("tok-1");
    expect(secondRevoke).toBe(false);
  });

  it("get returns token entry by id", () => {
    const registry = createTokenRegistry([
      { id: "tok-1", scopes: ["rpc", "ws"] },
    ]);

    const entry = registry.get("tok-1");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe("tok-1");
    expect(entry!.scopes).toEqual(["rpc", "ws"]);
  });

  it("get returns undefined for non-existent token", () => {
    const registry = createTokenRegistry([]);

    const entry = registry.get("non-existent");
    expect(entry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests for the 4 token management RPC handlers
// ---------------------------------------------------------------------------

describe("createTokenHandlers - token management", () => {
  beforeEach(() => {
    mockPersistToConfig.mockClear();
    mockPersistToConfig.mockResolvedValue({ ok: true, value: { configPath: "/tmp/test-config.yaml" } } as never);
  });

  // -------------------------------------------------------------------------
  // tokens.list (admin required)
  // -------------------------------------------------------------------------

  describe("tokens.list", () => {
    it("returns token entries without secrets", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      const result = (await handlers["tokens.list"]!({ _trustLevel: "admin" })) as {
        tokens: Array<{ id: string; scopes: readonly string[]; createdAt: number }>;
      };

      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0]!.id).toBe("test-token");
      expect(result.tokens[0]!.scopes).toEqual(["rpc", "admin"]);
      expect(result.tokens[0]!.createdAt).toEqual(expect.any(Number));

      // Verify NO secret field in list results
      for (const token of result.tokens) {
        expect(token).not.toHaveProperty("secret");
      }
    });

    it("returns empty array when no tokens", async () => {
      const deps = makeDeps({
        tokenRegistry: createTokenRegistry([]),
      });
      const handlers = createTokenHandlers(deps);

      const result = (await handlers["tokens.list"]!({ _trustLevel: "admin" })) as {
        tokens: unknown[];
      };

      expect(result.tokens).toHaveLength(0);
    });

    it("rejects without _trustLevel (H-1)", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(handlers["tokens.list"]!({})).rejects.toThrow(
        "Admin access required for token listing",
      );
    });

    it("rejects with non-admin _trustLevel (H-1)", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.list"]!({ _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required for token listing");
    });
  });

  // -------------------------------------------------------------------------
  // tokens.create (admin required)
  // -------------------------------------------------------------------------

  describe("tokens.create", () => {
    it("rejects tokens.create without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.create"]!({ scopes: ["admin"], _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects tokens.create without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.create"]!({ scopes: ["admin"] }),
      ).rejects.toThrow("Admin access required");
    });

    it("returns id, secret, scopes, createdAt and calls addToTokenStore", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      const result = (await handlers["tokens.create"]!({
        scopes: ["rpc", "ws"],
        _trustLevel: "admin",
      })) as {
        id: string;
        secret: string;
        scopes: readonly string[];
        createdAt: number;
        message: string;
      };

      expect(result.id).toEqual(expect.any(String));
      // secret is 64-char base64url (384 bits entropy)
      expect(result.secret).toHaveLength(64);
      expect(result.secret).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result.scopes).toEqual(["rpc", "ws"]);
      expect(result.createdAt).toEqual(expect.any(Number));
      expect(result.message).toContain("Token created");

      // Verify addToTokenStore was called with the generated token
      expect(deps.addToTokenStore).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.id,
          secret: result.secret,
          scopes: ["rpc", "ws"],
        }),
      );
    });

    it("generates UUID id when none provided", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      const result = (await handlers["tokens.create"]!({
        scopes: ["rpc"],
        _trustLevel: "admin",
      })) as { id: string };

      // UUID format: 8-4-4-4-12 hex chars
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    it("uses explicit id when provided", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      const result = (await handlers["tokens.create"]!({
        id: "my-custom-token",
        scopes: ["admin"],
        _trustLevel: "admin",
      })) as { id: string };

      expect(result.id).toBe("my-custom-token");
    });

    it("throws when scopes is missing", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.create"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow("Missing or empty required parameter: scopes");
    });

    it("throws when scopes is empty array", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.create"]!({ scopes: [], _trustLevel: "admin" }),
      ).rejects.toThrow("Missing or empty required parameter: scopes");
    });
  });

  // -------------------------------------------------------------------------
  // tokens.revoke (admin required)
  // -------------------------------------------------------------------------

  describe("tokens.revoke", () => {
    it("rejects tokens.revoke without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.revoke"]!({ id: "test-token", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects tokens.revoke without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.revoke"]!({ id: "test-token" }),
      ).rejects.toThrow("Admin access required");
    });

    it("revokes token and calls removeFromTokenStore", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      const result = (await handlers["tokens.revoke"]!({
        id: "test-token",
        _trustLevel: "admin",
      })) as { id: string; revoked: boolean; message: string };

      expect(result.id).toBe("test-token");
      expect(result.revoked).toBe(true);
      expect(result.message).toBe("Token revoked");
      expect(deps.removeFromTokenStore).toHaveBeenCalledWith("test-token");
    });

    it("throws for non-existent token", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.revoke"]!({ id: "non-existent", _trustLevel: "admin" }),
      ).rejects.toThrow("Token not found or already revoked");
    });

    it("throws when id is missing", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.revoke"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow("Missing required parameter: id");
    });
  });

  // -------------------------------------------------------------------------
  // tokens.rotate (admin required)
  // -------------------------------------------------------------------------

  describe("tokens.rotate", () => {
    it("rejects tokens.rotate without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.rotate"]!({ id: "test-token", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects tokens.rotate without any trust level", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.rotate"]!({ id: "test-token" }),
      ).rejects.toThrow("Admin access required");
    });

    it("revokes old and creates new with rotated id", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      const result = (await handlers["tokens.rotate"]!({
        id: "test-token",
        _trustLevel: "admin",
      })) as {
        oldId: string;
        newId: string;
        newSecret: string;
        scopes: readonly string[];
        createdAt: number;
        message: string;
      };

      expect(result.oldId).toBe("test-token");
      // rotation ID uses random suffix, not Date.now()
      expect(result.newId).toMatch(/^test-token-[A-Za-z0-9_-]+$/);
      expect(result.newId).not.toMatch(/rotated-\d+$/);
      // secret is 64-char base64url
      expect(result.newSecret).toHaveLength(64);
      expect(result.newSecret).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result.scopes).toEqual(["rpc", "admin"]);
      expect(result.message).toContain("Token rotated");
    });

    it("throws when original token not found", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.rotate"]!({ id: "non-existent", _trustLevel: "admin" }),
      ).rejects.toThrow("Token not found or already revoked");
    });

    it("calls addToTokenStore for new token and removeFromTokenStore for old", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      const result = (await handlers["tokens.rotate"]!({
        id: "test-token",
        _trustLevel: "admin",
      })) as { newId: string; newSecret: string };

      // removeFromTokenStore called for old token
      expect(deps.removeFromTokenStore).toHaveBeenCalledWith("test-token");

      // addToTokenStore called for new token
      expect(deps.addToTokenStore).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.newId,
          secret: result.newSecret,
          scopes: ["rpc", "admin"],
        }),
      );
    });

    it("throws when id is missing", async () => {
      const deps = makeDeps();
      const handlers = createTokenHandlers(deps);

      await expect(
        handlers["tokens.rotate"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow("Missing required parameter: id");
    });
  });

  // -------------------------------------------------------------------------
  // Persistence wiring tests
  // -------------------------------------------------------------------------

  describe("persistence wiring", () => {
    it("tokens.create calls persistToConfig with secret-free gateway.tokens patch", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createTokenHandlers(deps);

      await handlers["tokens.create"]!({ scopes: ["ws"], _trustLevel: "admin" });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0]!;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.actionType).toBe("tokens.create");
      const tokensArray = (callOpts.patch as { gateway: { tokens: Array<{ id: string; scopes: string[] }> } }).gateway.tokens;
      // existing "test-token" + newly created token = 2
      expect(tokensArray).toHaveLength(2);
      expect(tokensArray[tokensArray.length - 1]!.scopes).toEqual(["ws"]);
      // NO secret field in ANY persisted token entry
      for (const tok of tokensArray) {
        expect(tok).not.toHaveProperty("secret");
      }
    });

    it("tokens.revoke calls persistToConfig with secret-free filtered gateway.tokens", async () => {
      // Add a second token to verify secret stripping when tokens remain after revoke
      const persistDeps = makePersistDeps();
      (persistDeps.container.config.gateway as any).tokens = [
        { id: "test-token", secret: "existing-secret-padded-to-meet-32-chars", scopes: ["rpc", "admin"] },
        { id: "other-token", secret: "another-secret-padded-to-meet-32-chars", scopes: ["ws"] },
      ];
      const deps = makeDeps({
        persistDeps,
        tokenRegistry: createTokenRegistry([
          { id: "test-token", scopes: ["rpc", "admin"] },
          { id: "other-token", scopes: ["ws"] },
        ]),
      });
      const handlers = createTokenHandlers(deps);

      await handlers["tokens.revoke"]!({ id: "test-token", _trustLevel: "admin" });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0]!;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.actionType).toBe("tokens.revoke");
      const tokensArray = (callOpts.patch as { gateway: { tokens: Array<{ id: string }> } }).gateway.tokens;
      // test-token was revoked, only other-token remains
      expect(tokensArray).toHaveLength(1);
      expect(tokensArray[0]!.id).toBe("other-token");
      // NO secret field in persisted token
      expect(tokensArray[0]).not.toHaveProperty("secret");
    });

    it("tokens.rotate calls persistToConfig with secret-free patch and random rotation ID", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createTokenHandlers(deps);

      await handlers["tokens.rotate"]!({ id: "test-token", _trustLevel: "admin" });

      expect(mockPersistToConfig).toHaveBeenCalledOnce();
      const [callDeps, callOpts] = mockPersistToConfig.mock.calls[0]!;
      expect(callDeps).toBe(persistDeps);
      expect(callOpts.actionType).toBe("tokens.rotate");
      // entityId uses random suffix, not Date.now()
      expect(callOpts.entityId).toMatch(/^test-token -> test-token-[A-Za-z0-9_-]+$/);
      expect(callOpts.entityId).not.toMatch(/rotated-\d+$/);
      const tokensArray = (callOpts.patch as { gateway: { tokens: Array<{ id: string }> } }).gateway.tokens;
      // Old removed, new appended = 1 entry
      expect(tokensArray).toHaveLength(1);
      expect(tokensArray[0]!.id).toMatch(/^test-token-[A-Za-z0-9_-]+$/);
      // NO secret field in persisted token
      expect(tokensArray[0]).not.toHaveProperty("secret");
    });

    it("tokens.create succeeds even if persistToConfig fails (best-effort)", async () => {
      mockPersistToConfig.mockResolvedValue({ ok: false, error: "disk full" } as never);
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createTokenHandlers(deps);

      const result = (await handlers["tokens.create"]!({
        scopes: ["rpc"],
        _trustLevel: "admin",
      })) as { id: string; secret: string; message: string };

      // Handler still succeeds -- persistence is best-effort
      expect(result.id).toEqual(expect.any(String));
      expect(result.secret).toEqual(expect.any(String));
      expect(result.message).toContain("Token created");
      // Persistence failure was logged
      expect(persistDeps.logger.warn).toHaveBeenCalled();
    });

    it("tokens.list does not call persistToConfig", async () => {
      const persistDeps = makePersistDeps();
      const deps = makeDeps({ persistDeps });
      const handlers = createTokenHandlers(deps);

      await handlers["tokens.list"]!({ _trustLevel: "admin" });

      expect(mockPersistToConfig).not.toHaveBeenCalled();
    });
  });
});
