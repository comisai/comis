import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createEnvHandlers, type EnvHandlerDeps } from "./env-handlers.js";
import type { ComisLogger } from "@comis/infra";
import type { SecretStorePort, AppContainer } from "@comis/core";
import { ok, err } from "@comis/shared";
import { readFileSync, statSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
function createMockContainer(eventBus = createMockEventBus()): AppContainer {
  return {
    eventBus,
    config: { tenantId: "test-tenant" },
    secretManager: { get: vi.fn() },
  } as unknown as AppContainer;
}

function createMockSecretStore(): SecretStorePort {
  return {
    set: vi.fn(() => ok(undefined)),
    getDecrypted: vi.fn(() => ok(undefined)),
    decryptAll: vi.fn(() => ok(new Map())),
    exists: vi.fn(() => false),
    list: vi.fn(() => ok([])),
    delete: vi.fn(() => ok(true)),
    recordUsage: vi.fn(),
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
    secretStore: undefined,
    envFilePath: "/tmp/test-nonexistent/.env",
    container: createMockContainer(),
    logger: createMockLogger(),
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

  it("rejects empty key", async () => {
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

  it("rejects missing key", async () => {
    const deps = makeDeps();
    const handlers = createEnvHandlers(deps);

    await expect(
      handlers["env.set"]!({ value: "secret", _trustLevel: "admin" }),
    ).rejects.toThrow("Missing required parameter: key");
  });

  // -----------------------------------------------------------------------
  // Value validation
  // -----------------------------------------------------------------------

  it("rejects empty value", async () => {
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

  // -----------------------------------------------------------------------
  // SecretStore backend (encrypted mode)
  // -----------------------------------------------------------------------

  it("writes to secret store when available", async () => {
    const secretStore = createMockSecretStore();
    const deps = makeDeps({ secretStore });
    const handlers = createEnvHandlers(deps);

    const result = await handlers["env.set"]!({ key: "OPENAI_API_KEY", value: "sk-abc123", _trustLevel: "admin" });

    expect(secretStore.set).toHaveBeenCalledWith("OPENAI_API_KEY", "sk-abc123");
    expect(result).toEqual(
      expect.objectContaining({ set: true, key: "OPENAI_API_KEY", storage: "encrypted", restarting: true }),
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
  // .env file backend (legacy mode)
  // -----------------------------------------------------------------------

  describe(".env file backend", () => {
    let temp: ReturnType<typeof createTempEnvDir>;

    beforeEach(() => {
      temp = createTempEnvDir();
    });

    afterEach(() => {
      temp.cleanup();
    });

    it("writes to .env file when no secret store", async () => {
      const deps = makeDeps({ envFilePath: temp.envPath });
      const handlers = createEnvHandlers(deps);

      const result = await handlers["env.set"]!({ key: "MY_KEY", value: "my-value", _trustLevel: "admin" });

      expect(result).toEqual(
        expect.objectContaining({ set: true, key: "MY_KEY", storage: "envfile", restarting: true }),
      );

      const content = readFileSync(temp.envPath, "utf-8");
      expect(content).toContain("MY_KEY=my-value");
    });

    it("sets .env file to 0o600 permissions", async () => {
      const deps = makeDeps({ envFilePath: temp.envPath });
      const handlers = createEnvHandlers(deps);

      await handlers["env.set"]!({ key: "MY_KEY", value: "secret", _trustLevel: "admin" });

      const stat = statSync(temp.envPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("appends to existing .env without duplicating", async () => {
      writeFileSync(temp.envPath, "EXISTING_KEY=old-value\n", "utf-8");
      const deps = makeDeps({ envFilePath: temp.envPath });
      const handlers = createEnvHandlers(deps);

      // Add a new key
      await handlers["env.set"]!({ key: "NEW_KEY", value: "new-value", _trustLevel: "admin" });

      const content = readFileSync(temp.envPath, "utf-8");
      expect(content).toContain("EXISTING_KEY=old-value");
      expect(content).toContain("NEW_KEY=new-value");
    });

    it("replaces existing key value without duplicating lines", async () => {
      writeFileSync(temp.envPath, "MY_KEY=old-value\nOTHER=keep\n", "utf-8");
      const deps = makeDeps({ envFilePath: temp.envPath });
      const handlers = createEnvHandlers(deps);

      await handlers["env.set"]!({ key: "MY_KEY", value: "new-value", _trustLevel: "admin" });

      const content = readFileSync(temp.envPath, "utf-8");
      // Should have exactly one MY_KEY line with new value
      const myKeyLines = content.split("\n").filter((l: string) => l.startsWith("MY_KEY="));
      expect(myKeyLines).toHaveLength(1);
      expect(myKeyLines[0]).toBe("MY_KEY=new-value");
      // Other keys preserved
      expect(content).toContain("OTHER=keep");
    });

    it("creates .env file if it does not exist", async () => {
      const newEnvPath = join(temp.dir, "new-dir", ".env");
      // Do NOT create the directory -- let the file write handle it.
      // Actually env-handlers writes to the path directly so the dir must exist.
      mkdirSync(join(temp.dir, "new-dir"), { recursive: true });

      const deps = makeDeps({ envFilePath: newEnvPath });
      const handlers = createEnvHandlers(deps);

      await handlers["env.set"]!({ key: "BRAND_NEW", value: "fresh", _trustLevel: "admin" });

      const content = readFileSync(newEnvPath, "utf-8");
      expect(content).toContain("BRAND_NEW=fresh");
    });
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

  it("schedules SIGUSR2 restart after successful set", async () => {
    const secretStore = createMockSecretStore();
    const deps = makeDeps({ secretStore });
    const handlers = createEnvHandlers(deps);

    await handlers["env.set"]!({ key: "MY_KEY", value: "val", _trustLevel: "admin" });

    // Advance timers to trigger the 200ms setTimeout
    vi.advanceTimersByTime(200);

    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR2");
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
