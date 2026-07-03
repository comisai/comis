// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createEnvHandlers, type EnvHandlerDeps } from "./env-handlers.js";
import type { ComisLogger } from "@comis/infra";
import type { SecretStorePort, AppContainer } from "@comis/core";
import { createSecretManagerWithMutableHandle } from "@comis/core";
import { ok, err } from "@comis/shared";
import { readFileSync, statSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
function createMockContainer(
  eventBus = createMockEventBus(),
  storageMode: "encrypted" | "file" | "env" = "encrypted",
): AppContainer {
  return {
    eventBus,
    config: { tenantId: "test-tenant", security: { storage: storageMode } },
    // has() returns false by default (new key) so pre-existing tests stay green;
    // additive-restart tests override via createSecretManagerWithMutableHandle for full behavior.
    secretManager: { get: vi.fn(), has: vi.fn(() => false) },
  } as unknown as AppContainer;
}

function createMockSecretStore(): SecretStorePort {
  return {
    set: vi.fn(() => ok(undefined)),
    getDecrypted: vi.fn(() => ok(undefined)),
    decryptAll: vi.fn(() => ok(new Map())),
    list: vi.fn(() => ok([])),
    delete: vi.fn(() => ok(true)),
    close: vi.fn(),
  } as unknown as SecretStorePort;
}

function createTempEnvDir(): { dir: string; envPath: string; cleanup: () => void } {
  const dir = join(tmpdir(), `comis-env-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    envPath: join(dir, ".env"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeDeps(overrides: Partial<EnvHandlerDeps> = {}): EnvHandlerDeps {
  return {
    // secretStore is always wired.
    // Default to a mock that returns ok for reads and set.
    secretStore: createMockSecretStore(),
    envFilePath: "/tmp/test-nonexistent/.env",
    container: createMockContainer(),
    logger: createMockLogger(),
    // Default mutableSecretManager (no-op stubs); additive-restart tests use real handles.
    mutableSecretManager: { upsert: vi.fn(), remove: vi.fn(() => false) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("env.set handler", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Trust enforcement
  // -----------------------------------------------------------------------

  it("rejects non-admin trust level", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "MY_KEY", value: "secret", _trustLevel: "user" }),
    ).rejects.toThrow("Admin access required for env.set");
  });

  it("rejects guest trust level", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "MY_KEY", value: "secret", _trustLevel: "guest" }),
    ).rejects.toThrow("Admin access required for env.set");
  });

  it("rejects when trust level is missing", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "MY_KEY", value: "secret" }),
    ).rejects.toThrow("Admin access required for env.set");
  });

  // -----------------------------------------------------------------------
  // Key validation
  // -----------------------------------------------------------------------

  it("rejects lowercase key", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "lowercase", value: "secret", _trustLevel: "admin" }),
    ).rejects.toThrow("Invalid key format");
  });

  it("rejects empty key string in env.set request per parameter validation contract", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "", value: "secret", _trustLevel: "admin" }),
    ).rejects.toThrow("Missing required parameter: key");
  });

  it("rejects key starting with digit", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "123START", value: "secret", _trustLevel: "admin" }),
    ).rejects.toThrow("Invalid key format");
  });

  it("rejects key with space", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "HAS SPACE", value: "secret", _trustLevel: "admin" }),
    ).rejects.toThrow("Invalid key format");
  });

  it("rejects env.set request missing the key parameter entirely per validation contract", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ value: "secret", _trustLevel: "admin" }),
    ).rejects.toThrow("Missing required parameter: key");
  });

  // -----------------------------------------------------------------------
  // Value validation
  // -----------------------------------------------------------------------

  it("rejects empty value string in env.set request per parameter validation contract", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "MY_KEY", value: "", _trustLevel: "admin" }),
    ).rejects.toThrow("Value must not be empty");
  });

  it("rejects missing value", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "MY_KEY", _trustLevel: "admin" }),
    ).rejects.toThrow("Missing required parameter: value");
  });

  it("rejects non-string value", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "MY_KEY", value: 12345, _trustLevel: "admin" }),
    ).rejects.toThrow("Missing required parameter: value (must be a string)");
  });

  it("refuses to persist the literal [REDACTED] placeholder", async () => {
    const secretStore = createMockSecretStore();
    const deps = makeDeps({ secretStore });
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "CLOUDFLARE_ACCOUNT_ID", value: "[REDACTED]", _trustLevel: "admin" }),
    ).rejects.toThrow(/session-redaction placeholder/);
    expect(secretStore.set).not.toHaveBeenCalled();
  });

  it("refuses to persist bracketed redaction variants", async () => {
    const secretStore = createMockSecretStore();
    const deps = makeDeps({ secretStore });
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "API_TOKEN", value: "[REDACTED-VALUE]", _trustLevel: "admin" }),
    ).rejects.toThrow(/session-redaction placeholder/);
    expect(secretStore.set).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // SecretStore backend (encrypted mode)
  // -----------------------------------------------------------------------

  it("writes to secret store when available", async () => {
    const secretStore = createMockSecretStore();
    const deps = makeDeps({ secretStore });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.set"]!({ key: "OPENAI_API_KEY", value: "sk-abc123", _trustLevel: "admin" });

    expect(secretStore.set).toHaveBeenCalledWith("OPENAI_API_KEY", "sk-abc123");
    // restarting depends on has(): mock returns false (new key) → restarting:false
    expect(result).toEqual(
      expect.objectContaining({ set: true, key: "OPENAI_API_KEY", storage: "encrypted", restarting: false }),
    );
  });

  it("throws when secret store returns error", async () => {
    const secretStore = createMockSecretStore();
    (secretStore.set as ReturnType<typeof vi.fn>).mockReturnValue(err(new Error("Encryption failed")));
    const deps = makeDeps({ secretStore });
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "MY_KEY", value: "secret", _trustLevel: "admin" }),
    ).rejects.toThrow("Secret store write failed: Encryption failed");
  });

  // -----------------------------------------------------------------------
  // Env-mode adapter rejection (the adapter err surfaces as a throw)
  // -----------------------------------------------------------------------
  //
  // secretStore is always wired. The env-mode adapter returns err
  // from set() with an actionable message. The !setResult.ok handler
  // throws that message. Test with a mock adapter returning err("read-only").

  it("rejects env.set when adapter returns err (env-mode read-only adapter)", async () => {
    const secretStore = createMockSecretStore();
    (secretStore.set as ReturnType<typeof vi.fn>).mockReturnValue(
      err(new Error("Storage mode is 'env' (read-only). Switch to file or encrypted.")),
    );
    const deps = makeDeps({ secretStore });
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "MY_KEY", value: "my-value", _trustLevel: "admin" }),
    ).rejects.toThrow("read-only");
  });

  // -----------------------------------------------------------------------
  // Value never logged
  // -----------------------------------------------------------------------

  it("never logs the secret value", async () => {
    const secretStore = createMockSecretStore();
    const logger = createMockLogger();
    const deps = makeDeps({ secretStore, logger });
    const handlers = createEnvHandlers(deps);

    await handlers["env.set"]!({ key: "SECRET_KEY", value: "super-secret-value-12345", _trustLevel: "admin" });

    // Check all logger calls -- none should contain the secret value
    const allCalls = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];

    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("super-secret-value-12345");
    }
  });

  it("never logs value on failure", async () => {
    const secretStore = createMockSecretStore();
    (secretStore.set as ReturnType<typeof vi.fn>).mockReturnValue(err(new Error("DB error")));
    const logger = createMockLogger();
    const deps = makeDeps({ secretStore, logger });
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ key: "SECRET_KEY", value: "another-secret-456", _trustLevel: "admin" }),
    ).rejects.toThrow();

    const allCalls = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];

    for (const call of allCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("another-secret-456");
    }
  });

  // -----------------------------------------------------------------------
  // Audit event without value
  // -----------------------------------------------------------------------

  it("emits audit event without value in metadata", async () => {
    const secretStore = createMockSecretStore();
    const eventBus = createMockEventBus();
    const container = createMockContainer(eventBus);
    const deps = makeDeps({ secretStore, container });
    const handlers = createEnvHandlers(deps);

    await handlers["env.set"]!({ key: "MY_API_KEY", value: "secret-val", _trustLevel: "admin" });

    // Find the audit:event call
    const auditCalls = eventBus.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === "audit:event",
    );
    expect(auditCalls.length).toBeGreaterThanOrEqual(1);

    const auditPayload = auditCalls[0]![1] as Record<string, unknown>;
    expect(auditPayload.actionType).toBe("env.set");
    expect(auditPayload.outcome).toBe("success");

    const metadata = auditPayload.metadata as Record<string, unknown>;
    expect(metadata.key).toBe("MY_API_KEY");
    // CRITICAL: value must NOT be in metadata
    expect(metadata).not.toHaveProperty("value");
    expect(JSON.stringify(metadata)).not.toContain("secret-val");
  });

  // -----------------------------------------------------------------------
  // Restart scheduling
  // -----------------------------------------------------------------------

  it("env.set on EXISTING key live-applies (no SIGUSR2, restarting:false)", async () => {
    const secretStore = createMockSecretStore();
    // Use a container where has() returns true (existing key — rotation).
    const container = createMockContainer(createMockEventBus(), "encrypted");
    (container.secretManager.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const deps = makeDeps({ secretStore, container });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.set"]!({ key: "MY_KEY", value: "val", _trustLevel: "admin" }) as Record<string, unknown>;

    // Rotation live-applies — no SIGUSR2, restarting:false always.
    vi.advanceTimersByTime(500);
    expect(killSpy).not.toHaveBeenCalled();
    expect(result.restarting).toBe(false);
  });

  // -----------------------------------------------------------------------
  // storage field reflects config.security.storage (not hardcoded "encrypted")
  // -----------------------------------------------------------------------

  it("env.set returns storage:'file' when config.security.storage is 'file'", async () => {
    const secretStore = createMockSecretStore();
    const container = createMockContainer(createMockEventBus(), "file");
    const deps = makeDeps({ secretStore, container });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.set"]!({ key: "OPENAI_API_KEY", value: "sk-test", _trustLevel: "admin" });

    // storage reflects config.security.storage, not hardcoded "encrypted"
    // restarting:false for new key (has() returns false by default)
    expect(result).toMatchObject({ set: true, storage: "file", restarting: false });
  });

  it("env.set with env-mode adapter returning err surfaces the adapter error message", async () => {
    const secretStore = createMockSecretStore();
    (secretStore.set as ReturnType<typeof vi.fn>).mockReturnValue(
      err(new Error("Storage mode is 'env' (read-only). To persist secrets, set security.storage: file or encrypted.")),
    );
    const deps = makeDeps({ secretStore });
    const handlers = createEnvHandlers(deps);

    // The adapter's err result surfaces via the !setResult.ok throw block.
    await expect(
      handlers["env.set"]!({ key: "MY_KEY", value: "val", _trustLevel: "admin" }),
    ).rejects.toThrow("read-only");
  });

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  it("rate limits after 5 calls", async () => {
    const secretStore = createMockSecretStore();
    const deps = makeDeps({ secretStore });
    const handlers = createEnvHandlers(deps);

    // 5 successful calls
    for (let i = 0; i < 5; i++) {
      await handlers["env.set"]!({ key: `KEY_${i}`, value: `val-${i}`, _trustLevel: "admin" });
    }

    // 6th call should be rate limited
    await expect(
      handlers["env.set"]!({ key: "KEY_6", value: "val-6", _trustLevel: "admin" }),
    ).rejects.toThrow("Env set rate limit exceeded");
  });
});

// ---------------------------------------------------------------------------
// env.list handler -- read-only secret NAME enumeration
// ---------------------------------------------------------------------------

/**
 * Build a container where SecretManager.keys() returns the given names
 * and get() maps name -> value (used by the value-leak canary test).
 */
function makeContainerWithSecrets(
  entries: Record<string, string>,
  eventBus = createMockEventBus(),
): AppContainer {
  return {
    eventBus,
    config: { tenantId: "test-tenant" },
    secretManager: {
      keys: vi.fn(() => Object.keys(entries)),
      get: vi.fn((k: string) => entries[k]),
      has: vi.fn((k: string) => k in entries),
      require: vi.fn((k: string) => {
        const v = entries[k];
        if (v === undefined) throw new Error(`not set: ${k}`);
        return v;
      }),
    },
  } as unknown as AppContainer;
}

describe("env.list handler", () => {
  // -----------------------------------------------------------------------
  // Trust enforcement
  // -----------------------------------------------------------------------

  it("rejects non-admin trust level", async () => {
    const deps = makeDeps({ container: makeContainerWithSecrets({ ALPHA: "a" }) });
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.list"]!({ _trustLevel: "user" }),
    ).rejects.toThrow("Admin access required for env.list");
  });

  it("rejects guest trust level", async () => {
    const deps = makeDeps({ container: makeContainerWithSecrets({ ALPHA: "a" }) });
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.list"]!({ _trustLevel: "guest" }),
    ).rejects.toThrow("Admin access required for env.list");
  });

  it("rejects when trust level is missing", async () => {
    const deps = makeDeps({ container: makeContainerWithSecrets({ ALPHA: "a" }) });
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.list"]!({}),
    ).rejects.toThrow("Admin access required for env.list");
  });

  // -----------------------------------------------------------------------
  // Basic name enumeration
  // -----------------------------------------------------------------------

  it("returns all configured secret names as envfile source with no store", async () => {
    const deps = makeDeps({
      container: makeContainerWithSecrets({ ALPHA: "av", BETA: "bv" }),
    });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.list"]!({ _trustLevel: "admin" }) as {
      secrets: Array<{ name: string; source: string }>;
      total: number;
      truncated: boolean;
    };

    expect(result.secrets.map((s) => s.name).sort()).toEqual(["ALPHA", "BETA"]);
    for (const entry of result.secrets) {
      expect(entry.source).toBe("envfile");
      expect(entry).not.toHaveProperty("value");
      expect(entry).not.toHaveProperty("plaintext");
      expect(entry).not.toHaveProperty("ciphertext");
      expect(entry).not.toHaveProperty("secret");
    }
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Value-leak canary -- the single most important assertion
  // -----------------------------------------------------------------------

  it("never returns secret values anywhere in the response (canary test)", async () => {
    const CANARY_VALUE = "SECRETVALUE_abc123";
    const deps = makeDeps({
      container: makeContainerWithSecrets({
        TEST_CANARY: CANARY_VALUE,
        OTHER_KEY: "not-the-canary",
      }),
    });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.list"]!({ _trustLevel: "admin" });

    // CRITICAL: the serialized response must NOT contain the value substring
    // under any field name. This catches accidental future leaks even if a
    // new field is added that we forgot to audit.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CANARY_VALUE);
  });

  // -----------------------------------------------------------------------
  // Filter param
  // -----------------------------------------------------------------------

  it("filters names by glob pattern", async () => {
    const deps = makeDeps({
      container: makeContainerWithSecrets({
        OPENAI_API_KEY: "v1",
        OPENAI_ORG: "v2",
        ANTHROPIC_API_KEY: "v3",
      }),
    });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.list"]!({ _trustLevel: "admin", filter: "OPENAI_*" }) as {
      secrets: Array<{ name: string }>;
      total: number;
    };

    expect(result.secrets.map((s) => s.name).sort()).toEqual(["OPENAI_API_KEY", "OPENAI_ORG"]);
    expect(result.total).toBe(2);
  });

  it("filter is case-insensitive", async () => {
    const deps = makeDeps({
      container: makeContainerWithSecrets({ GEMINI_API_KEY: "v", OTHER: "x" }),
    });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.list"]!({ _trustLevel: "admin", filter: "gemini*" }) as {
      secrets: Array<{ name: string }>;
    };

    expect(result.secrets.map((s) => s.name)).toEqual(["GEMINI_API_KEY"]);
  });

  // -----------------------------------------------------------------------
  // SecretStorePort enrichment
  // -----------------------------------------------------------------------

  it("enriches names from SecretStorePort with metadata (never values)", async () => {
    const secretStore = createMockSecretStore();
    (secretStore.list as ReturnType<typeof vi.fn>).mockReturnValue(
      ok([
        {
          name: "STORED_KEY",
          provider: "openai",
          description: "test",
          createdAt: 1000,
          updatedAt: 2000,
          expiresAt: undefined,
        },
      ]),
    );
    const deps = makeDeps({
      secretStore,
      container: makeContainerWithSecrets({ STORED_KEY: "v1", PLAIN_KEY: "v2" }),
    });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.list"]!({ _trustLevel: "admin" }) as {
      secrets: Array<{
        name: string;
        source: string;
        provider?: string;
        createdAt?: number;
      }>;
    };

    const stored = result.secrets.find((s) => s.name === "STORED_KEY")!;
    const plain = result.secrets.find((s) => s.name === "PLAIN_KEY")!;

    expect(stored.source).toBe("secretstore");
    expect(stored.provider).toBe("openai");
    expect(stored.createdAt).toBe(1000);

    expect(plain.source).toBe("envfile");
    expect(plain).not.toHaveProperty("provider");
    expect(plain).not.toHaveProperty("createdAt");
  });

  // -----------------------------------------------------------------------
  // Rate limit (30 per 60s)
  // -----------------------------------------------------------------------

  it("rate limits after 30 calls", async () => {
    const deps = makeDeps({ container: makeContainerWithSecrets({ ALPHA: "a" }) });
    const handlers = createEnvHandlers(deps);

    for (let i = 0; i < 30; i++) {
      await handlers["env.list"]!({ _trustLevel: "admin" });
    }

    await expect(
      handlers["env.list"]!({ _trustLevel: "admin" }),
    ).rejects.toThrow("Env list rate limit exceeded");
  });

  // -----------------------------------------------------------------------
  // Limit clamp
  // -----------------------------------------------------------------------

  it("clamps limit to 500 and marks truncated when total exceeds limit", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 600; i++) {
      many[`KEY_${String(i).padStart(4, "0")}`] = `v${i}`;
    }
    const deps = makeDeps({ container: makeContainerWithSecrets(many) });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.list"]!({ _trustLevel: "admin", limit: 10000 }) as {
      secrets: Array<{ name: string }>;
      total: number;
      truncated: boolean;
    };

    expect(result.secrets.length).toBe(500);
    expect(result.total).toBe(600);
    expect(result.truncated).toBe(true);
  });

  it("respects explicit limit smaller than total", async () => {
    const deps = makeDeps({
      container: makeContainerWithSecrets({ A: "1", B: "2", C: "3" }),
    });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.list"]!({ _trustLevel: "admin", limit: 2 }) as {
      secrets: Array<{ name: string }>;
      total: number;
      truncated: boolean;
    };

    expect(result.secrets.length).toBe(2);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Audit event
  // -----------------------------------------------------------------------

  it("emits audit event with count and filter, no names in metadata values", async () => {
    const eventBus = createMockEventBus();
    const container = makeContainerWithSecrets({ A: "1", B: "2" }, eventBus);
    const deps = makeDeps({ container });
    const handlers = createEnvHandlers(deps);

    await handlers["env.list"]!({ _trustLevel: "admin", filter: "A*" });

    const auditCalls = eventBus.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === "audit:event",
    );
    expect(auditCalls.length).toBe(1);

    const payload = auditCalls[0]![1] as Record<string, unknown>;
    expect(payload.actionType).toBe("env.list");
    expect(payload.classification).toBe("read");
    expect(payload.outcome).toBe("success");

    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.count).toBe(1);
    expect(metadata.total).toBe(1);
    expect(metadata.filter).toBe("A*");
  });

  // -----------------------------------------------------------------------
  // Logging never leaks values
  // -----------------------------------------------------------------------

  it("never logs secret values at any level", async () => {
    const CANARY_VALUE = "LEAK_PROBE_xyz789";
    const logger = createMockLogger();
    const deps = makeDeps({
      logger,
      container: makeContainerWithSecrets({ PROBE: CANARY_VALUE }),
    });
    const handlers = createEnvHandlers(deps);

    await handlers["env.list"]!({ _trustLevel: "admin" });

    const allCalls = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];

    for (const call of allCalls) {
      expect(JSON.stringify(call)).not.toContain(CANARY_VALUE);
    }
  });
});

// ---------------------------------------------------------------------------
// Additive restart rule (a new key never schedules a restart)
// ---------------------------------------------------------------------------

describe("additive restart rule (env.set)", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeContainerWithManager(
    initialEnv: Record<string, string> = {},
    eventBus = createMockEventBus(),
  ): AppContainer {
    const { secretManager, mutableHandle: _mutableHandle } = createSecretManagerWithMutableHandle(initialEnv);
    return {
      eventBus,
      config: { tenantId: "test-tenant", security: { storage: "encrypted" } },
      secretManager,
    } as unknown as AppContainer;
  }

  it("env.set on a key not in secretManager returns restarting false and does not call SIGUSR2", async () => {
    const eventBus = createMockEventBus();
    const container = makeContainerWithManager({}, eventBus);
    const mutableSecretManager = createSecretManagerWithMutableHandle({}).mutableHandle;
    const deps = makeDeps({ container, mutableSecretManager } as unknown as Partial<EnvHandlerDeps>);
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.set"]!({ key: "BRAND_NEW_KEY", value: "new-value", _trustLevel: "admin" }) as Record<string, unknown>;

    expect(result.restarting).toBe(false);
    vi.advanceTimersByTime(200);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("env.set on a key already in secretManager live-applies (restarting:false, no SIGUSR2)", async () => {
    const eventBus = createMockEventBus();
    const container = makeContainerWithManager({ EXISTING_KEY: "old-value" }, eventBus);
    const mutableSecretManager = createSecretManagerWithMutableHandle({}).mutableHandle;
    const deps = makeDeps({ container, mutableSecretManager } as unknown as Partial<EnvHandlerDeps>);
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.set"]!({ key: "EXISTING_KEY", value: "new-value", _trustLevel: "admin" }) as Record<string, unknown>;

    // Rotation live-applies — restarting:false, no SIGUSR2.
    expect(result.restarting).toBe(false);
    vi.advanceTimersByTime(500);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("env.set on new key emits secret:changed with action upserted and no value field", async () => {
    const eventBus = createMockEventBus();
    const container = makeContainerWithManager({}, eventBus);
    const mutableSecretManager = createSecretManagerWithMutableHandle({}).mutableHandle;
    const deps = makeDeps({ container, mutableSecretManager } as unknown as Partial<EnvHandlerDeps>);
    const handlers = createEnvHandlers(deps);

    await handlers["env.set"]!({ key: "BRAND_NEW_KEY_2", value: "some-secret-val", _trustLevel: "admin" });

    const changedCalls = (eventBus.emit.mock.calls as Array<[string, unknown]>).filter(
      (c) => c[0] === "secret:changed",
    );
    expect(changedCalls.length).toBeGreaterThanOrEqual(1);
    const payload = changedCalls[0]![1] as Record<string, unknown>;
    expect(payload.name).toBe("BRAND_NEW_KEY_2");
    expect(payload.action).toBe("upserted");
    expect(payload).not.toHaveProperty("value");
    expect(JSON.stringify(payload)).not.toContain("some-secret-val");
  });
});

// ---------------------------------------------------------------------------
// Rotation must live-apply (restarting:false, no SIGUSR2)
// ---------------------------------------------------------------------------

describe("env.set rotation: restarting:false, upsert called, no SIGUSR2", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeContainerWithManager(
    initialEnv: Record<string, string> = {},
    eventBus = createMockEventBus(),
  ): AppContainer {
    const { secretManager } = createSecretManagerWithMutableHandle(initialEnv);
    return {
      eventBus,
      config: { tenantId: "test-tenant", security: { storage: "encrypted" } },
      secretManager,
    } as unknown as AppContainer;
  }

  it("env.set rotation: returns restarting:false", async () => {
    const eventBus = createMockEventBus();
    const container = makeContainerWithManager({ EXISTING_KEY: "old-value" }, eventBus);
    const { mutableHandle: mutableSecretManager } = createSecretManagerWithMutableHandle({});
    const deps = makeDeps({ container, mutableSecretManager } as unknown as Partial<EnvHandlerDeps>);
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.set"]!({ key: "EXISTING_KEY", value: "new-value", _trustLevel: "admin" }) as Record<string, unknown>;

    expect(result.restarting).toBe(false);
  });

  it("env.set rotation: calls mutableSecretManager.upsert with key and new value", async () => {
    const eventBus = createMockEventBus();
    const container = makeContainerWithManager({ EXISTING_KEY: "old-value" }, eventBus);
    const upsertSpy = vi.fn();
    const mutableSecretManager = { upsert: upsertSpy, remove: vi.fn() };
    const deps = makeDeps({ container, mutableSecretManager } as unknown as Partial<EnvHandlerDeps>);
    const handlers = createEnvHandlers(deps);

    await handlers["env.set"]!({ key: "EXISTING_KEY", value: "new-value", _trustLevel: "admin" });

    expect(upsertSpy).toHaveBeenCalledWith("EXISTING_KEY", "new-value");
  });

  it("env.set rotation: does not call process.kill (no SIGUSR2)", async () => {
    const eventBus = createMockEventBus();
    const container = makeContainerWithManager({ EXISTING_KEY: "old-value" }, eventBus);
    const { mutableHandle: mutableSecretManager } = createSecretManagerWithMutableHandle({});
    const deps = makeDeps({ container, mutableSecretManager } as unknown as Partial<EnvHandlerDeps>);
    const handlers = createEnvHandlers(deps);

    await handlers["env.set"]!({ key: "EXISTING_KEY", value: "new-value", _trustLevel: "admin" });
    vi.advanceTimersByTime(500);

    expect(killSpy).not.toHaveBeenCalled();
  });
});
