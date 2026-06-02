// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SecretStorePort, AppContainer, SecretMetadata } from "@comis/core";
import { createSecretManagerWithMutableHandle } from "@comis/core";
import { ok, err } from "@comis/shared";
import { createSecretsHandlers } from "./secrets-handlers.js";
import type { SecretsHandlerDeps } from "./secrets-handlers.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockSecretStore(
  overrides?: Partial<SecretStorePort>,
): SecretStorePort {
  return {
    set: vi.fn(() => ok(undefined)),
    getDecrypted: vi.fn(() => ok(undefined)),
    decryptAll: vi.fn(() => ok(new Map<string, string>())),
    list: vi.fn(() => ok([] as SecretMetadata[])),
    delete: vi.fn(() => ok(false)),
    close: vi.fn(),
    ...overrides,
  } as unknown as SecretStorePort;
}

interface MakeDepsResult {
  handlers: ReturnType<typeof createSecretsHandlers>;
  capturedAuditEvents: unknown[];
  loggerSpy: ReturnType<typeof createMockLogger>;
}

function makeMockedDeps(
  secretStoreOverrides?: Partial<SecretStorePort>,
): MakeDepsResult {
  const capturedAuditEvents: unknown[] = [];
  const eventBus = createMockEventBus({
    emit: vi.fn((kind: string, evt: unknown) => {
      if (kind === "audit:event") capturedAuditEvents.push(evt);
      return false;
    }),
  });
  const logger = createMockLogger();
  const container = {
    config: { tenantId: "test-tenant" } as Record<string, unknown>,
    eventBus,
    // has() returns false by default (new key) so existing tests stay green.
    secretManager: { has: vi.fn(() => false) },
  } as unknown as AppContainer;
  // After Plan 02-04: secretStore is always wired (REQ-04).
  const secretStore = createMockSecretStore(secretStoreOverrides);
  // Default mutableSecretManager (no-op stubs); 03-03 tests use real handles.
  const mutableSecretManager = { upsert: vi.fn(), remove: vi.fn(() => false) };
  const handlers = createSecretsHandlers({ secretStore, container, logger, mutableSecretManager } as unknown as SecretsHandlerDeps);
  return { handlers, capturedAuditEvents, loggerSpy: logger };
}

/**
 * Collect all logger payloads/messages across info/warn/error/debug spies into
 * a single string for substring-leakage assertions.
 */
function loggerCallsAsString(logger: ReturnType<typeof createMockLogger>): string {
  const collected: unknown[] = [];
  for (const level of ["info", "warn", "error", "debug", "trace", "fatal"] as const) {
    const fn = logger[level] as unknown as { mock?: { calls: unknown[][] } };
    const calls = fn.mock?.calls ?? [];
    for (const c of calls) collected.push(c);
  }
  return JSON.stringify(collected);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSecretsHandlers", () => {
  // -------------------------------------------------------------------------
  // secrets.get
  // -------------------------------------------------------------------------

  describe("secrets.get", () => {
    it("returns plaintext on success; canary value never appears in audit events or logs", async () => {
      const CANARY = "secret-canary-9f3a2-plaintext-MUST-NOT-LEAK";
      const { handlers, capturedAuditEvents, loggerSpy } = makeMockedDeps({
        getDecrypted: vi.fn(() => ok(CANARY)),
      });

      const result = await handlers["secrets.get"]!({
        _trustLevel: "admin",
        name: "OPENAI_API_KEY",
      });
      expect(result).toEqual({
        name: "OPENAI_API_KEY",
        value: CANARY,
        exists: true,
      });
      // Audit event(s) must NOT contain the canary plaintext anywhere.
      expect(capturedAuditEvents).toHaveLength(1);
      expect(JSON.stringify(capturedAuditEvents)).not.toContain(CANARY);
      // Logger calls must NOT contain the canary plaintext.
      expect(loggerCallsAsString(loggerSpy)).not.toContain(CANARY);
    });

    it("rejects when _trustLevel is not 'admin'", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["secrets.get"]!({ _trustLevel: "rpc", name: "FOO" }),
      ).rejects.toThrow(/Admin access required/);
    });

    it("returns exists:false for a name not in the adapter (env-mode empty snapshot)", async () => {
      // After Plan 02-04: secretStore is always wired; env-mode getDecrypted returns
      // ok(undefined) for unknown names — adapter never rejects on reads.
      const { handlers } = makeMockedDeps({ getDecrypted: vi.fn(() => ok(undefined)) });
      const result = (await handlers["secrets.get"]!({ _trustLevel: "admin", name: "NONEXISTENT_KEY" })) as {
        exists: boolean;
      };
      expect(result.exists).toBe(false);
    });

    it("rejects malformed name (does not echo any value)", async () => {
      const { handlers, loggerSpy } = makeMockedDeps();
      await expect(
        handlers["secrets.get"]!({
          _trustLevel: "admin",
          name: "lowercase_name",
        }),
      ).rejects.toThrow(/Invalid name format/);
      // The malformed name itself is allowed in error text; verify there is
      // no leakage of an unexpected "value" substring from any source.
      expect(loggerCallsAsString(loggerSpy)).not.toContain("plaintext-MUST-NOT-LEAK");
    });

    it("reports decryption_failed without leaking value on backend error", async () => {
      const { handlers, capturedAuditEvents } = makeMockedDeps({
        getDecrypted: vi.fn(() => err(new Error("AEAD tag mismatch"))),
      });
      await expect(
        handlers["secrets.get"]!({ _trustLevel: "admin", name: "BAD_KEY" }),
      ).rejects.toThrow(/Decryption failed/);
      expect(capturedAuditEvents).toHaveLength(1);
      const audit = capturedAuditEvents[0] as Record<string, unknown>;
      expect((audit.metadata as Record<string, unknown>).error).toBe(
        "decryption_failed",
      );
      // Outcome marker
      expect(audit.outcome).toBe("failure");
    });
  });

  // -------------------------------------------------------------------------
  // secrets.set
  // -------------------------------------------------------------------------

  describe("secrets.set", () => {
    it("stores secret; value parameter never leaks into audit events or logs", async () => {
      const CANARY = "plaintext-canary-set-3e-MUST-NOT-LEAK";
      const { handlers, capturedAuditEvents, loggerSpy } = makeMockedDeps();
      const result = await handlers["secrets.set"]!({
        _trustLevel: "admin",
        name: "ANTHROPIC_API_KEY",
        value: CANARY,
        provider: "anthropic",
      });
      // After 03-03: result also includes restarting:boolean; use toMatchObject to be forward-compat.
      expect(result).toMatchObject({ name: "ANTHROPIC_API_KEY", stored: true });
      expect(JSON.stringify(capturedAuditEvents)).not.toContain(CANARY);
      expect(loggerCallsAsString(loggerSpy)).not.toContain(CANARY);
    });

    it("rejects redaction-placeholder values", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["secrets.set"]!({
          _trustLevel: "admin",
          name: "FOO",
          value: "[REDACTED]",
        }),
      ).rejects.toThrow(/redaction placeholder/);
      await expect(
        handlers["secrets.set"]!({
          _trustLevel: "admin",
          name: "FOO",
          value: "[REDACTED:foo]",
        }),
      ).rejects.toThrow(/redaction placeholder/);
    });

    it("requires admin trust level", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["secrets.set"]!({ name: "FOO", value: "x" }),
      ).rejects.toThrow(/Admin access required/);
    });

    it("rejects malformed name", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["secrets.set"]!({
          _trustLevel: "admin",
          name: "bad-name",
          value: "x",
        }),
      ).rejects.toThrow(/Invalid name format/);
    });

    it("rejects empty value string in secrets.set request per parameter validation contract", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["secrets.set"]!({
          _trustLevel: "admin",
          name: "FOO",
          value: "",
        }),
      ).rejects.toThrow(/Value cannot be empty/);
    });

    it("emits destructive audit event on store failure (no value leak)", async () => {
      const CANARY = "plaintext-fail-canary-MUST-NOT-LEAK";
      const { handlers, capturedAuditEvents, loggerSpy } = makeMockedDeps({
        set: vi.fn(() => err(new Error("disk full"))),
      });
      await expect(
        handlers["secrets.set"]!({
          _trustLevel: "admin",
          name: "FAIL_KEY",
          value: CANARY,
        }),
      ).rejects.toThrow(/Failed to store secret/);
      const audit = capturedAuditEvents[0] as Record<string, unknown>;
      expect(audit.classification).toBe("destructive");
      expect(audit.outcome).toBe("failure");
      expect(JSON.stringify(capturedAuditEvents)).not.toContain(CANARY);
      expect(loggerCallsAsString(loggerSpy)).not.toContain(CANARY);
    });
  });

  // -------------------------------------------------------------------------
  // secrets.list
  // -------------------------------------------------------------------------

  describe("secrets.list", () => {
    it("returns metadata array; no value field anywhere", async () => {
      const { handlers } = makeMockedDeps({
        list: vi.fn(() =>
          ok([
            {
              name: "X",
              provider: "openai",
              createdAt: 1,
              updatedAt: 1,
            },
          ] as SecretMetadata[]),
        ),
      });
      const result = (await handlers["secrets.list"]!({ _trustLevel: "admin" })) as {
        secrets: Record<string, unknown>[];
      };
      expect(result.secrets).toHaveLength(1);
      expect(result.secrets[0]).not.toHaveProperty("value");
      expect(result.secrets[0]).not.toHaveProperty("plaintext");
    });

    it("returns empty array when store has no entries (env-mode with no sensitive vars)", async () => {
      // After Plan 02-04: secretStore is always wired; env-mode adapter's list()
      // returns an empty array when no sensitive vars are in the snapshot.
      const { handlers } = makeMockedDeps({ list: vi.fn(() => ok([])) });
      const result = (await handlers["secrets.list"]!({ _trustLevel: "admin" })) as {
        secrets: unknown[];
      };
      expect(result.secrets).toEqual([]);
    });

    it("requires admin trust level", async () => {
      const { handlers } = makeMockedDeps();
      await expect(handlers["secrets.list"]!({})).rejects.toThrow(
        /Admin access required/,
      );
    });

    it("propagates store list failure as generic error", async () => {
      const { handlers } = makeMockedDeps({
        list: vi.fn(() => err(new Error("db corrupt"))),
      });
      await expect(
        handlers["secrets.list"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow(/Failed to list secrets/);
    });
  });

  // -------------------------------------------------------------------------
  // secrets.delete
  // -------------------------------------------------------------------------

  describe("secrets.delete", () => {
    it("emits destructive audit event on success", async () => {
      const { handlers, capturedAuditEvents } = makeMockedDeps({
        delete: vi.fn(() => ok(true)),
      });
      const result = await handlers["secrets.delete"]!({
        _trustLevel: "admin",
        name: "TO_DELETE",
      });
      // After 03-03: result also includes restarting:boolean; use toMatchObject to be forward-compat.
      expect(result).toMatchObject({ name: "TO_DELETE", deleted: true });
      const audit = capturedAuditEvents[0] as Record<string, unknown>;
      expect(audit.classification).toBe("destructive");
      expect(audit.outcome).toBe("success");
      expect((audit.metadata as Record<string, unknown>).existed).toBe(true);
    });

    it("requires admin trust level", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["secrets.delete"]!({ name: "X" }),
      ).rejects.toThrow(/Admin access required/);
    });

    it("rejects malformed name", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["secrets.delete"]!({
          _trustLevel: "admin",
          name: "bad-name",
        }),
      ).rejects.toThrow(/Invalid name format/);
    });

    it("emits audit failure event on store delete error", async () => {
      const { handlers, capturedAuditEvents } = makeMockedDeps({
        delete: vi.fn(() => err(new Error("locked"))),
      });
      await expect(
        handlers["secrets.delete"]!({
          _trustLevel: "admin",
          name: "STUCK",
        }),
      ).rejects.toThrow(/Failed to delete secret/);
      const audit = capturedAuditEvents[0] as Record<string, unknown>;
      expect(audit.classification).toBe("destructive");
      expect(audit.outcome).toBe("failure");
    });
  });
});

// ---------------------------------------------------------------------------
// 03-03 — secrets restart-truth and event emit (RED: handlers don't implement yet)
// ---------------------------------------------------------------------------

describe("03-03 — secrets restart-truth and event emit", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeHandlersWithSecretManager(
    initialEnv: Record<string, string> = {},
    secretStoreOverrides?: Partial<SecretStorePort>,
  ): { handlers: ReturnType<typeof createSecretsHandlers>; eventBus: ReturnType<typeof createMockEventBus> } {
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle(initialEnv);
    const capturedEvents: unknown[] = [];
    const eventBus = createMockEventBus({
      emit: vi.fn((kind: string, evt: unknown) => {
        if (kind === "audit:event" || kind === "secret:changed") capturedEvents.push({ kind, evt });
        return false;
      }),
    });
    const container = {
      config: { tenantId: "test-tenant" },
      eventBus,
      secretManager,
    } as unknown as AppContainer;
    const secretStore = createMockSecretStore(secretStoreOverrides);
    const deps: SecretsHandlerDeps = {
      secretStore,
      container,
      logger: createMockLogger(),
      mutableSecretManager: mutableHandle,
    } as unknown as SecretsHandlerDeps;
    const handlers = createSecretsHandlers(deps);
    return { handlers, eventBus };
  }

  it("secrets.set on a new name returns restarting false with stored true", async () => {
    const { handlers } = makeHandlersWithSecretManager({});
    const result = await handlers["secrets.set"]!({
      _trustLevel: "admin",
      name: "BRAND_NEW_SECRET",
      value: "top-secret-value",
    }) as Record<string, unknown>;

    expect(result.stored).toBe(true);
    expect(result.restarting).toBe(false);
  });

  it("06-02: secrets.set on an existing name live-applies (restarting:false)", async () => {
    const { handlers } = makeHandlersWithSecretManager({ EXISTING_SECRET: "old-val" });
    const result = await handlers["secrets.set"]!({
      _trustLevel: "admin",
      name: "EXISTING_SECRET",
      value: "new-val",
    }) as Record<string, unknown>;

    // P4b/06-02: rotation live-applies — restarting:false always.
    expect(result.restarting).toBe(false);
  });

  it("06-02: secrets.set on existing name does not schedule SIGUSR2 restart", async () => {
    const { handlers } = makeHandlersWithSecretManager({ EXISTING_SECRET: "old-val" });

    await handlers["secrets.set"]!({
      _trustLevel: "admin",
      name: "EXISTING_SECRET",
      value: "new-val",
    });

    vi.advanceTimersByTime(500);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("06-02: secrets.delete on an existing name live-applies (restarting:false)", async () => {
    const { handlers } = makeHandlersWithSecretManager({ TO_DELETE: "val" }, {
      delete: vi.fn(() => ok(true)),
    });
    const result = await handlers["secrets.delete"]!({
      _trustLevel: "admin",
      name: "TO_DELETE",
    }) as Record<string, unknown>;

    // P4b/06-02: delete live-applies — restarting:false always.
    expect(result.restarting).toBe(false);
  });

  it("secrets.delete on a name not in secretManager returns restarting false and deleted false", async () => {
    const { handlers } = makeHandlersWithSecretManager({}, {
      delete: vi.fn(() => ok(false)),
    });
    const result = await handlers["secrets.delete"]!({
      _trustLevel: "admin",
      name: "NONEXISTENT_SECRET",
    }) as Record<string, unknown>;

    expect(result.deleted).toBe(false);
    expect(result.restarting).toBe(false);
    vi.advanceTimersByTime(200);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("secrets.delete on existing name emits secret:changed with action removed", async () => {
    const { handlers, eventBus } = makeHandlersWithSecretManager({ DELETE_ME: "val" }, {
      delete: vi.fn(() => ok(true)),
    });

    await handlers["secrets.delete"]!({
      _trustLevel: "admin",
      name: "DELETE_ME",
    });

    const changedCalls = (eventBus.emit.mock.calls as Array<[string, unknown]>).filter(
      (c) => c[0] === "secret:changed",
    );
    expect(changedCalls.length).toBeGreaterThanOrEqual(1);
    const payload = changedCalls[0]![1] as Record<string, unknown>;
    expect(payload.name).toBe("DELETE_ME");
    expect(payload.action).toBe("removed");
  });

  it("secrets.set new name emits secret:changed with action upserted", async () => {
    const { handlers, eventBus } = makeHandlersWithSecretManager({});

    await handlers["secrets.set"]!({
      _trustLevel: "admin",
      name: "FRESH_SECRET",
      value: "new-secret-val",
    });

    const changedCalls = (eventBus.emit.mock.calls as Array<[string, unknown]>).filter(
      (c) => c[0] === "secret:changed",
    );
    expect(changedCalls.length).toBeGreaterThanOrEqual(1);
    const payload = changedCalls[0]![1] as Record<string, unknown>;
    expect(payload.name).toBe("FRESH_SECRET");
    expect(payload.action).toBe("upserted");
    expect(payload).not.toHaveProperty("value");
  });

  it("secrets.delete no-op does not emit secret:changed when name not in secretManager", async () => {
    const { handlers, eventBus } = makeHandlersWithSecretManager({}, {
      delete: vi.fn(() => ok(false)),
    });

    await handlers["secrets.delete"]!({
      _trustLevel: "admin",
      name: "ABSENT_KEY",
    });

    const changedCalls = (eventBus.emit.mock.calls as Array<[string, unknown]>).filter(
      (c) => c[0] === "secret:changed",
    );
    expect(changedCalls).toHaveLength(0);
  });

  // WR-02: deleted/restarting consistency — derive deleted from existed||delResult.value
  // so Map-store desync (e.g. secret in store but absent from Map due to prior WR-01 bug)
  // cannot produce contradictory { deleted: false, restarting: true } or
  // { deleted: true, restarting: false } where the CLI shows "Secret not found"
  // while SIGUSR2 fires.
  it("secrets.delete: deleted=true when store delete returns true regardless of existed (WR-02 consistency)", async () => {
    // Simulate the WR-01 desync: secret is in store (store.delete returns true)
    // but NOT in the shared Map (existed = false). After WR-01 fix this can't
    // happen in practice for newly extracted secrets, but the invariant must
    // still hold for any legacy state.
    const { handlers } = makeHandlersWithSecretManager(
      {}, // Map is empty — existed will be false
      { delete: vi.fn(() => ok(true)) }, // store says it deleted something
    );

    const result = await handlers["secrets.delete"]!({
      _trustLevel: "admin",
      name: "LEGACY_STORE_ONLY_KEY",
    }) as Record<string, unknown>;

    // deleted must reflect the store truth (or Map truth) — never false when
    // the store actually deleted something.
    expect(result.deleted).toBe(true);
    // restarting: false because existed=false (secret was never live in the Map)
    expect(result.restarting).toBe(false);
  });

  it("secrets.delete: deleted=true when secret is in both Map and store (normal case)", async () => {
    const { handlers } = makeHandlersWithSecretManager(
      { BOTH_KEY: "val" }, // Map has it — existed=true
      { delete: vi.fn(() => ok(true)) }, // store also deletes it
    );

    const result = await handlers["secrets.delete"]!({
      _trustLevel: "admin",
      name: "BOTH_KEY",
    }) as Record<string, unknown>;

    expect(result.deleted).toBe(true);
    // P4b/06-02: restarting:false always — live-applies without restart.
    expect(result.restarting).toBe(false);
  });

  it("secrets.delete: deleted=true (not false) when Map had key (existed=true) even if store.delete returns false (WR-02 soft-delete regression guard)", async () => {
    // Simulates a hypothetical store soft-delete regression: existed=true (Map has it)
    // but store.delete returns false. Without the fix, this produces
    // { deleted: false } — CLI shows "Secret not found" even though Map tracked it.
    // With existed||delResult.value the deleted field is consistent.
    const { handlers } = makeHandlersWithSecretManager(
      { SOFT_DELETE_KEY: "val" }, // Map has it — existed=true
      { delete: vi.fn(() => ok(false)) }, // store soft-delete returns false (regression scenario)
    );

    const result = await handlers["secrets.delete"]!({
      _trustLevel: "admin",
      name: "SOFT_DELETE_KEY",
    }) as Record<string, unknown>;

    // deleted must be true because Map had the key (existed=true) — the Map is
    // authoritative for what was live-tracked (existed || delResult.value).
    expect(result.deleted).toBe(true);
    // P4b/06-02: restarting:false always — live-applies without restart.
    expect(result.restarting).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 06-02 — rotation/delete must live-apply (restarting:false, no SIGUSR2) — RED phase
// ---------------------------------------------------------------------------

describe("06-02 — secrets rotation/delete: restarting:false, upsert/remove called, no SIGUSR2", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeHandlersForRotation(
    initialEnv: Record<string, string> = {},
    secretStoreOverrides?: Partial<SecretStorePort>,
  ): { handlers: ReturnType<typeof createSecretsHandlers>; eventBus: ReturnType<typeof createMockEventBus> } {
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle(initialEnv);
    const eventBus = createMockEventBus();
    const container = {
      config: { tenantId: "test-tenant" },
      eventBus,
      secretManager,
    } as unknown as AppContainer;
    const secretStore = createMockSecretStore(secretStoreOverrides);
    const deps: SecretsHandlerDeps = {
      secretStore,
      container,
      logger: createMockLogger(),
      mutableSecretManager: mutableHandle,
    } as unknown as SecretsHandlerDeps;
    const handlers = createSecretsHandlers(deps);
    return { handlers, eventBus };
  }

  it("secrets.set rotation: returns restarting:false", async () => {
    const { handlers } = makeHandlersForRotation({ EXISTING_SECRET: "old-val" });
    const result = await handlers["secrets.set"]!({
      _trustLevel: "admin",
      name: "EXISTING_SECRET",
      value: "new-val",
    }) as Record<string, unknown>;

    expect(result.restarting).toBe(false);
  });

  it("secrets.set rotation: calls mutableSecretManager.upsert unconditionally", async () => {
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({ EXISTING_SECRET: "old-val" });
    const upsertSpy = vi.fn();
    const eventBus = createMockEventBus();
    const container = {
      config: { tenantId: "test-tenant" },
      eventBus,
      secretManager,
    } as unknown as AppContainer;
    const deps: SecretsHandlerDeps = {
      secretStore: createMockSecretStore(),
      container,
      logger: createMockLogger(),
      mutableSecretManager: { upsert: upsertSpy, remove: mutableHandle.remove.bind(mutableHandle) },
    } as unknown as SecretsHandlerDeps;
    const handlers = createSecretsHandlers(deps);

    await handlers["secrets.set"]!({
      _trustLevel: "admin",
      name: "EXISTING_SECRET",
      value: "new-val",
    });

    expect(upsertSpy).toHaveBeenCalledWith("EXISTING_SECRET", "new-val");
  });

  it("secrets.set rotation: does not call process.kill (no SIGUSR2)", async () => {
    const { handlers } = makeHandlersForRotation({ EXISTING_SECRET: "old-val" });

    await handlers["secrets.set"]!({
      _trustLevel: "admin",
      name: "EXISTING_SECRET",
      value: "new-val",
    });
    vi.advanceTimersByTime(500);

    expect(killSpy).not.toHaveBeenCalled();
  });

  it("secrets.delete: returns restarting:false", async () => {
    const { handlers } = makeHandlersForRotation({ TO_DELETE: "val" }, {
      delete: vi.fn(() => ok(true)),
    });
    const result = await handlers["secrets.delete"]!({
      _trustLevel: "admin",
      name: "TO_DELETE",
    }) as Record<string, unknown>;

    expect(result.restarting).toBe(false);
  });

  it("secrets.delete: does not call process.kill after remove (no SIGUSR2)", async () => {
    const { handlers } = makeHandlersForRotation({ TO_DELETE: "val" }, {
      delete: vi.fn(() => ok(true)),
    });

    await handlers["secrets.delete"]!({
      _trustLevel: "admin",
      name: "TO_DELETE",
    });
    vi.advanceTimersByTime(500);

    expect(killSpy).not.toHaveBeenCalled();
  });
});
