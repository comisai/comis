// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for createAuthHandlers (auth.list + auth.logout).
 *
 * The two daemon-side handlers gate the encrypted-mode CLI auth subcommands.
 * The single non-negotiable invariant is that `access`/`refresh`/`accountId`
 * from OAuthProfile NEVER cross the daemon -> CLI boundary -- the canary
 * tests below assert that.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type {
  AppContainer,
  OAuthCredentialStorePort,
  OAuthProfile,
} from "@comis/core";
import { ok, err } from "@comis/shared";
import { createAuthHandlers } from "./auth-handlers.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockOAuthStore(
  overrides?: Partial<OAuthCredentialStorePort>,
): OAuthCredentialStorePort {
  return {
    get: vi.fn(async () => ok(undefined)),
    set: vi.fn(async () => ok(undefined)),
    delete: vi.fn(async () => ok(false)),
    list: vi.fn(async () => ok([] as OAuthProfile[])),
    has: vi.fn(async () => ok(false)),
    ...overrides,
  } as unknown as OAuthCredentialStorePort;
}

interface MakeDepsResult {
  handlers: ReturnType<typeof createAuthHandlers>;
  capturedAuditEvents: unknown[];
  loggerSpy: ReturnType<typeof createMockLogger>;
  oauthCredentialStore: OAuthCredentialStorePort;
}

function makeMockedDeps(
  storeOverrides?: Partial<OAuthCredentialStorePort>,
  options?: { withoutStore?: boolean },
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
  const oauthCredentialStore = options?.withoutStore
    ? undefined
    : createMockOAuthStore(storeOverrides);
  const handlers = createAuthHandlers({
    oauthCredentialStore,
    container,
    logger,
  });
  return {
    handlers,
    capturedAuditEvents,
    loggerSpy: logger,
    oauthCredentialStore: oauthCredentialStore!,
  };
}

function loggerCallsAsString(logger: ReturnType<typeof createMockLogger>): string {
  const collected: unknown[] = [];
  for (const level of ["info", "warn", "error", "debug", "trace", "fatal"] as const) {
    const fn = logger[level] as unknown as { mock?: { calls: unknown[][] } };
    const calls = fn.mock?.calls ?? [];
    for (const c of calls) collected.push(c);
  }
  return JSON.stringify(collected);
}

function makeProfile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    provider: "openai-codex",
    profileId: "openai-codex:test@example.com",
    access: "ACCESS-CANARY-9f3a2",
    refresh: "REFRESH-CANARY-7b1c4",
    expires: Date.now() + 3_600_000,
    accountId: "ACCOUNTID-CANARY-12345",
    email: "test@example.com",
    displayName: "Test User",
    version: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAuthHandlers", () => {
  // -------------------------------------------------------------------------
  // auth.list (token-stripping projection)
  // -------------------------------------------------------------------------

  describe("auth.list", () => {
    it("returns profiles WITHOUT access/refresh/accountId fields", async () => {
      const profile = makeProfile();
      const { handlers } = makeMockedDeps({
        list: vi.fn(async () => ok([profile])),
      });
      const result = (await handlers["auth.list"]!({ _trustLevel: "admin" })) as {
        profiles: Array<Record<string, unknown>>;
      };
      expect(result.profiles).toHaveLength(1);
      const row = result.profiles[0]!;
      // Strip-on-return: these fields MUST NOT appear in the response.
      expect(row).not.toHaveProperty("access");
      expect(row).not.toHaveProperty("refresh");
      expect(row).not.toHaveProperty("accountId");
      // Kept fields:
      expect(row.provider).toBe("openai-codex");
      expect(row.profileId).toBe("openai-codex:test@example.com");
      expect(row.expires).toBe(profile.expires);
      expect(row.email).toBe("test@example.com");
      expect(row.displayName).toBe("Test User");
    });

    it("response JSON.stringify does NOT contain canary access/refresh/accountId values (residency canary)", async () => {
      const profile = makeProfile();
      const { handlers, loggerSpy } = makeMockedDeps({
        list: vi.fn(async () => ok([profile])),
      });
      const result = await handlers["auth.list"]!({ _trustLevel: "admin" });
      const json = JSON.stringify(result);
      expect(json).not.toContain("ACCESS-CANARY-9f3a2");
      expect(json).not.toContain("REFRESH-CANARY-7b1c4");
      expect(json).not.toContain("ACCOUNTID-CANARY-12345");
      // Logs also clean (defense-in-depth -- the projection happens before
      // any logger call that takes the profile payload).
      const logJson = loggerCallsAsString(loggerSpy);
      expect(logJson).not.toContain("ACCESS-CANARY-9f3a2");
      expect(logJson).not.toContain("REFRESH-CANARY-7b1c4");
      expect(logJson).not.toContain("ACCOUNTID-CANARY-12345");
    });

    it("rejects when _trustLevel is not \"admin\"", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["auth.list"]!({ _trustLevel: "rpc" }),
      ).rejects.toThrow(/Admin access required/);
    });

    it("returns empty array when oauthCredentialStore is undefined (file-mode daemon)", async () => {
      const { handlers } = makeMockedDeps(undefined, { withoutStore: true });
      const result = (await handlers["auth.list"]!({ _trustLevel: "admin" })) as {
        profiles: unknown[];
      };
      expect(result.profiles).toEqual([]);
    });

    it("forwards provider filter to the port", async () => {
      const listMock = vi.fn(async () => ok([] as OAuthProfile[]));
      const { handlers } = makeMockedDeps({ list: listMock });
      await handlers["auth.list"]!({
        _trustLevel: "admin",
        provider: "openai-codex",
      });
      expect(listMock).toHaveBeenCalledWith({ provider: "openai-codex" });
    });

    it("calls list() with undefined filter when provider param is absent", async () => {
      const listMock = vi.fn(async () => ok([] as OAuthProfile[]));
      const { handlers } = makeMockedDeps({ list: listMock });
      await handlers["auth.list"]!({ _trustLevel: "admin" });
      expect(listMock).toHaveBeenCalledWith(undefined);
    });

    it("propagates store list failure as generic error", async () => {
      const { handlers } = makeMockedDeps({
        list: vi.fn(async () => err(new Error("db locked"))),
      });
      await expect(
        handlers["auth.list"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow(/Failed to list OAuth profiles/);
    });
  });

  // -------------------------------------------------------------------------
  // auth.set (daemon-assisted OAuth login RPC — admin-gated, audited persistence)
  // -------------------------------------------------------------------------

  describe("auth.set handler", () => {
    it("rejects non-admin callers before any other logic (trustLevel !== admin)", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["auth.set"]!({
          _trustLevel: "rpc",
          provider: "openai-codex",
          profileId: "openai-codex:x@y.com",
          access: "tok",
          refresh: "ref",
          expires: Date.now(),
          version: 1,
        }),
      ).rejects.toThrow("Admin access required for auth.set");
    });

    it("throws actionable config error when oauthCredentialStore is missing (Daemon must be running)", async () => {
      const { handlers } = makeMockedDeps(undefined, { withoutStore: true });
      await expect(
        handlers["auth.set"]!({
          _trustLevel: "admin",
          provider: "openai-codex",
          profileId: "openai-codex:x@y.com",
          access: "tok",
          refresh: "ref",
          expires: Date.now(),
          version: 1,
        }),
      ).rejects.toThrow(/Daemon must be running|security\.storage/);
    });

    it("calls oauthCredentialStore.set exactly once with correct profile shape including version:1", async () => {
      const setMock = vi.fn(async () => ok(undefined as void));
      const { handlers, oauthCredentialStore } = makeMockedDeps({ set: setMock });
      const expires = Date.now() + 3_600_000;
      await handlers["auth.set"]!({
        _trustLevel: "admin",
        provider: "openai-codex",
        profileId: "openai-codex:test@example.com",
        access: "tok-access",
        refresh: "tok-refresh",
        expires,
        accountId: "acct-123",
        email: "test@example.com",
        displayName: "Test User",
        version: 1,
      });
      expect(oauthCredentialStore.set).toHaveBeenCalledTimes(1);
      expect(oauthCredentialStore.set).toHaveBeenCalledWith(
        "openai-codex:test@example.com",
        expect.objectContaining({
          provider: "openai-codex",
          profileId: "openai-codex:test@example.com",
          access: "tok-access",
          refresh: "tok-refresh",
          expires,
          accountId: "acct-123",
          email: "test@example.com",
          displayName: "Test User",
          version: 1,
        }),
      );
    });

    it("returns { profileId, stored: true } — token-free response", async () => {
      const setMock = vi.fn(async () => ok(undefined as void));
      const { handlers } = makeMockedDeps({ set: setMock });
      const result = await handlers["auth.set"]!({
        _trustLevel: "admin",
        provider: "openai-codex",
        profileId: "openai-codex:test@example.com",
        access: "tok-access",
        refresh: "tok-refresh",
        expires: Date.now() + 3_600_000,
        version: 1,
      });
      expect(result).toEqual({
        profileId: "openai-codex:test@example.com",
        stored: true,
      });
    });

    it("RESIDENCY CANARY — response contains no access, refresh, or accountId; JSON.stringify contains no LEAK_SENTINEL", async () => {
      const setMock = vi.fn(async () => ok(undefined as void));
      const { handlers } = makeMockedDeps({ set: setMock });
      const result = (await handlers["auth.set"]!({
        _trustLevel: "admin",
        provider: "openai-codex",
        profileId: "openai-codex:test@example.com",
        access: "LEAK_SENTINEL_ACCESS",
        refresh: "LEAK_SENTINEL_REFRESH",
        expires: Date.now() + 3_600_000,
        accountId: "LEAK_SENTINEL_ACCOUNT",
        email: "test@example.com",
        displayName: "Test",
        version: 1,
      })) as Record<string, unknown>;
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("LEAK_SENTINEL");
      expect(result).not.toHaveProperty("access");
      expect(result).not.toHaveProperty("refresh");
      expect(result).not.toHaveProperty("accountId");
      expect(result).toEqual({ profileId: "openai-codex:test@example.com", stored: true });
    });

    it("SQLITE_BUSY — maps database is locked error to actionable retryable hint (locked or retry in message)", async () => {
      const { handlers } = makeMockedDeps({
        set: vi.fn(async () => err(new Error("database is locked"))),
      });
      await expect(
        handlers["auth.set"]!({
          _trustLevel: "admin",
          provider: "openai-codex",
          profileId: "openai-codex:test@example.com",
          access: "tok",
          refresh: "ref",
          expires: Date.now() + 3_600_000,
          version: 1,
        }),
      ).rejects.toThrow(/locked|retry/i);
    });
  });

  // -------------------------------------------------------------------------
  // auth.logout
  // -------------------------------------------------------------------------

  describe("auth.logout", () => {
    it("deletes a profile and emits destructive audit event on success", async () => {
      const deleteMock = vi.fn(async () => ok(true));
      const { handlers, capturedAuditEvents } = makeMockedDeps({
        delete: deleteMock,
      });
      const result = await handlers["auth.logout"]!({
        _trustLevel: "admin",
        profileId: "openai-codex:test@example.com",
      });
      expect(result).toEqual({
        profileId: "openai-codex:test@example.com",
        deleted: true,
      });
      expect(deleteMock).toHaveBeenCalledWith("openai-codex:test@example.com");
      const audit = capturedAuditEvents[0] as Record<string, unknown>;
      expect(audit.classification).toBe("destructive");
      expect(audit.outcome).toBe("success");
      expect(audit.actionType).toBe("auth.logout");
      const meta = audit.metadata as Record<string, unknown>;
      expect(meta.profileId).toBe("openai-codex:test@example.com");
      expect(meta.existed).toBe(true);
    });

    it("returns deleted: false (no-op) when the profile does not exist", async () => {
      const { handlers } = makeMockedDeps({
        delete: vi.fn(async () => ok(false)),
      });
      const result = await handlers["auth.logout"]!({
        _trustLevel: "admin",
        profileId: "missing:nobody",
      });
      expect(result).toEqual({ profileId: "missing:nobody", deleted: false });
    });

    it("rejects when _trustLevel is not \"admin\"", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["auth.logout"]!({ profileId: "X:Y" }),
      ).rejects.toThrow(/Admin access required/);
    });

    it("rejects when profileId is missing", async () => {
      const { handlers } = makeMockedDeps();
      await expect(
        handlers["auth.logout"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow(/profileId/);
    });

    it("rejects when oauthCredentialStore is undefined", async () => {
      const { handlers } = makeMockedDeps(undefined, { withoutStore: true });
      await expect(
        handlers["auth.logout"]!({
          _trustLevel: "admin",
          profileId: "openai-codex:test@example.com",
        }),
      ).rejects.toThrow(/Encrypted OAuth store not configured/);
    });

    it("emits destructive failure audit on backend delete error", async () => {
      const { handlers, capturedAuditEvents } = makeMockedDeps({
        delete: vi.fn(async () => err(new Error("disk full"))),
      });
      await expect(
        handlers["auth.logout"]!({
          _trustLevel: "admin",
          profileId: "stuck:profile",
        }),
      ).rejects.toThrow(/Failed to delete OAuth profile/);
      const audit = capturedAuditEvents[0] as Record<string, unknown>;
      expect(audit.classification).toBe("destructive");
      expect(audit.outcome).toBe("failure");
      const meta = audit.metadata as Record<string, unknown>;
      expect(meta.profileId).toBe("stuck:profile");
      expect(meta.error).toBe("delete_failed");
    });
  });
});
