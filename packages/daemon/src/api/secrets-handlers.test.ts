// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { SecretStorePort, AppContainer, SecretMetadata } from "@comis/core";
import { ok, err } from "@comis/shared";
import { createSecretsHandlers } from "./secrets-handlers.js";
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
    exists: vi.fn(() => false),
    list: vi.fn(() => ok([] as SecretMetadata[])),
    delete: vi.fn(() => ok(false)),
    recordUsage: vi.fn(),
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
  options?: { withoutSecretStore?: boolean },
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
  } as unknown as AppContainer;
  const secretStore = options?.withoutSecretStore
    ? undefined
    : createMockSecretStore(secretStoreOverrides);
  const handlers = createSecretsHandlers({ secretStore, container, logger });
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

describe("createSecretsHandlers (MEM-CTX-PORTS-13)", () => {
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

    it("rejects when secrets store is not configured", async () => {
      const { handlers } = makeMockedDeps(undefined, { withoutSecretStore: true });
      await expect(
        handlers["secrets.get"]!({ _trustLevel: "admin", name: "FOO" }),
      ).rejects.toThrow(/Encrypted secrets store not configured/);
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
      expect(result).toEqual({ name: "ANTHROPIC_API_KEY", stored: true });
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
              usageCount: 0,
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

    it("returns empty array when secretStore is undefined (no master key)", async () => {
      const { handlers } = makeMockedDeps(undefined, {
        withoutSecretStore: true,
      });
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
      expect(result).toEqual({ name: "TO_DELETE", deleted: true });
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
