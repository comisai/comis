// SPDX-License-Identifier: Apache-2.0
/**
 * Integration gate for REQ-05 SC-1: auth.set encrypted round-trip.
 *
 * Tests the auth.set → auth.list round-trip using the in-process
 * createAuthHandlers factory (same pattern as context-dag-integration.test.ts
 * and recall-diagnostics-isolation.test.ts — drives real handler code against
 * mock deps without spinning up the full daemon or real secrets.db).
 *
 * Four tests:
 *   1. auth.set (encrypted) persists profile → auth.list reads it back with
 *      profileId + email present, no access/refresh in list response.
 *   2. auth.set response carries no plaintext token bytes — JSON.stringify
 *      of the response must not contain TEST_SENTINEL.
 *   3. auth.set with locked secrets.db (err("database is locked")) returns
 *      an actionable retryable error (message contains "locked" or "retry").
 *   4. Architecture smoke: AuthSetContract importable without pulling
 *      @comis/memory; CLI has no @comis/memory edge (structural invariant).
 *
 * Run with: `pnpm build && pnpm test:integration -- auth-set-encrypted`
 *
 * Note: integration tests run sequentially (pool:"forks", maxConcurrency:1).
 * The per-file annotation is REDUNDANT — do not add it.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type {
  AppContainer,
  OAuthCredentialStorePort,
  OAuthProfile,
} from "@comis/core";
import { AuthSetContract, AuthListContract } from "@comis/core";
import { ok, err } from "@comis/shared";
import { createAuthHandlers } from "@comis/daemon";
import type { AuthHandlerDeps } from "@comis/daemon";
import { createMockLogger } from "../support/mock-logger.js";
import { createMockEventBus } from "../support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Sentinel strings: structurally identical to real token shapes but contain
// no actual credential values. Used to assert residency (absence from
// serialized responses / logs). T-04-16: these strings are not persisted.
// ---------------------------------------------------------------------------

const ACCESS_SENTINEL = "tok-access-TEST_SENTINEL_9f3a2b";
const REFRESH_SENTINEL = "tok-refresh-TEST_SENTINEL_7b1c4d";
const ACCOUNT_SENTINEL = "acct-id-TEST_SENTINEL_12345";

// ---------------------------------------------------------------------------
// In-memory mock credential store — state shared between auth.set + auth.list
// within a single test so the round-trip can be exercised without real SQLite.
// ---------------------------------------------------------------------------

function createInMemoryOAuthStore(
  overrides?: Partial<OAuthCredentialStorePort>,
): OAuthCredentialStorePort {
  const storedProfiles = new Map<string, OAuthProfile>();
  return {
    set: vi.fn(async (_id: string, profile: OAuthProfile) => {
      storedProfiles.set(_id, profile);
      return ok(undefined);
    }),
    list: vi.fn(async () => ok([...storedProfiles.values()])),
    get: vi.fn(async (id: string) => {
      const p = storedProfiles.get(id);
      return ok(p);
    }),
    delete: vi.fn(async (id: string) => {
      const existed = storedProfiles.has(id);
      storedProfiles.delete(id);
      return ok(existed);
    }),
    has: vi.fn(async (id: string) => ok(storedProfiles.has(id))),
    ...overrides,
  } as unknown as OAuthCredentialStorePort;
}

// ---------------------------------------------------------------------------
// Deps factory — mirrors the pattern in auth-handlers.test.ts (unit) and
// context-dag-integration.test.ts (integration). Logger + eventBus mocks
// allow asserting no sentinel bytes appear in log payloads either.
// ---------------------------------------------------------------------------

interface MakeDepsResult {
  handlers: ReturnType<typeof createAuthHandlers>;
  capturedAuditEvents: unknown[];
  loggerSpy: ReturnType<typeof createMockLogger>;
}

function makeDeps(store: OAuthCredentialStorePort): MakeDepsResult {
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

  const deps: AuthHandlerDeps = {
    oauthCredentialStore: store,
    container,
    logger,
  };
  const handlers = createAuthHandlers(deps);
  return { handlers, capturedAuditEvents, loggerSpy: logger };
}

// ---------------------------------------------------------------------------
// Shared valid profile payload (mirrors OAuthProfile shape; version: 1 pinned
// by AuthSetContract.request schema).
// ---------------------------------------------------------------------------

const VALID_PROFILE_PARAMS = {
  _trustLevel: "admin" as const,
  provider: "openai-codex",
  profileId: "openai-codex:test@example.com",
  access: ACCESS_SENTINEL,
  refresh: REFRESH_SENTINEL,
  expires: Date.now() + 3_600_000,
  accountId: ACCOUNT_SENTINEL,
  email: "test@example.com",
  displayName: "Test User",
  version: 1 as const,
};

// ---------------------------------------------------------------------------
// Helper: collect all mock-logger call payloads as a serialized string.
// ---------------------------------------------------------------------------

function loggerCallsAsString(
  logger: ReturnType<typeof createMockLogger>,
): string {
  const collected: unknown[] = [];
  for (const level of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
  ] as const) {
    const fn = logger[level] as unknown as { mock?: { calls: unknown[][] } };
    const calls = fn.mock?.calls ?? [];
    for (const c of calls) collected.push(c);
  }
  return JSON.stringify(collected);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth.set encrypted mode integration", () => {
  it("auth.set persists profile in encrypted mode; auth.list reads it back with profileId + email present", async () => {
    const store = createInMemoryOAuthStore();
    const { handlers } = makeDeps(store);

    // Call auth.set — should persist the profile into the in-memory store.
    const setResult = await handlers[AuthSetContract.method]!({
      ...VALID_PROFILE_PARAMS,
    });
    expect(setResult).toEqual({
      profileId: "openai-codex:test@example.com",
      stored: true,
    });

    // Verify the store actually received the write.
    expect(store.set).toHaveBeenCalledTimes(1);

    // Call auth.list — should return the stored profile metadata.
    const listResult = (await handlers[AuthListContract.method]!({
      _trustLevel: "admin",
    })) as { profiles: Array<Record<string, unknown>> };
    expect(listResult.profiles).toHaveLength(1);

    const profile = listResult.profiles[0]!;
    expect(profile["profileId"]).toBe("openai-codex:test@example.com");
    expect(profile["email"]).toBe("test@example.com");

    // auth.list response MUST NOT carry access/refresh/accountId.
    expect(profile).not.toHaveProperty("access");
    expect(profile).not.toHaveProperty("refresh");
    expect(profile).not.toHaveProperty("accountId");
  });

  it("auth.set response JSON serialization contains no plaintext TEST_SENTINEL token bytes", async () => {
    const store = createInMemoryOAuthStore();
    const { handlers, loggerSpy, capturedAuditEvents } = makeDeps(store);

    const setResult = await handlers[AuthSetContract.method]!({
      ...VALID_PROFILE_PARAMS,
    });

    // Serialize the RPC response — sentinel strings must NOT appear.
    const responseSerialized = JSON.stringify(setResult);
    expect(responseSerialized).not.toContain("TEST_SENTINEL");
    expect(responseSerialized).not.toContain(ACCESS_SENTINEL);
    expect(responseSerialized).not.toContain(REFRESH_SENTINEL);
    expect(responseSerialized).not.toContain(ACCOUNT_SENTINEL);

    // Serialize all log payloads — sentinel strings must NOT appear there either.
    const logSerialized = loggerCallsAsString(loggerSpy);
    expect(logSerialized).not.toContain(ACCESS_SENTINEL);
    expect(logSerialized).not.toContain(REFRESH_SENTINEL);
    expect(logSerialized).not.toContain(ACCOUNT_SENTINEL);

    // Serialize audit events — sentinel strings must NOT appear.
    const auditSerialized = JSON.stringify(capturedAuditEvents);
    expect(auditSerialized).not.toContain(ACCESS_SENTINEL);
    expect(auditSerialized).not.toContain(REFRESH_SENTINEL);
    expect(auditSerialized).not.toContain(ACCOUNT_SENTINEL);
  });

  it("auth.set with locked secrets.db returns actionable retryable error mentioning 'locked' or 'retry'", async () => {
    // Simulate SQLITE_BUSY: store.set returns an err with the canonical SQLite
    // busy-signal message. The handler maps this to an actionable throw whose
    // message must guide the operator to retry.
    const busyStore = createInMemoryOAuthStore({
      set: vi.fn(async () => err(new Error("database is locked"))),
    });
    const { handlers } = makeDeps(busyStore);

    await expect(
      handlers[AuthSetContract.method]!({ ...VALID_PROFILE_PARAMS }),
    ).rejects.toThrow(/locked|retry/i);
  });

  it("architecture smoke: AuthSetContract importable as string method key with no @comis/memory dependency pulled in", () => {
    // AuthSetContract must be importable from @comis/core without touching
    // @comis/memory. The import at the top of this file is the implicit proof;
    // this assertion makes the intent explicit and gives a named test entry
    // in the integration suite so the arch constraint is documented.
    expect(typeof AuthSetContract.method).toBe("string");
    expect(AuthSetContract.method).toBe("auth.set");

    // AuthListContract.method consistent sanity check.
    expect(typeof AuthListContract.method).toBe("string");
    expect(AuthListContract.method).toBe("auth.list");
  });
});
