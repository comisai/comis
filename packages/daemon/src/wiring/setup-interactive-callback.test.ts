// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the signing-secret lifecycle helper.
 *
 * `resolveInteractiveCallbackSigningSecret` is the daemon composition-root seam
 * that supplies the 32-byte `activity.interactiveCallbackSigningSecret` backing
 * every signed channel callback:
 *
 *   - encrypted store ENABLED: generate once via SecretStorePort.set, read back
 *     via getDecrypted on subsequent starts → STABLE across restart.
 *   - store DISABLED (`undefined`, the default — schema-secrets enabled:false):
 *     an in-memory secret is generated per process (regenerated each start) — a
 *     documented fallback; in-flight 5-min approvals invalidate across restart.
 *   - the secret value never appears in any log line.
 *
 * The store is SYNCHRONOUS (SecretStorePort.set/getDecrypted return Result, not
 * Promise) so the resolver is synchronous.
 */
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@comis/shared";
import type {
  SecretStorePort,
  ComisLogger,
  ApprovalGate,
  ApprovalRequest,
  ActivityEvent,
  AppConfig,
} from "@comis/core";
import {
  resolveInteractiveCallbackSigningSecret,
  createInteractiveCallbackWiring,
} from "./setup-interactive-callback.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

const SECRET_NAME = "activity.interactiveCallbackSigningSecret";

function makeLogger(): ComisLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as ComisLogger;
}

/** A fake encrypted store backed by an in-memory map (sync, like the real port). */
function makeStubStore(overrides: Partial<SecretStorePort> = {}): {
  store: SecretStorePort;
  backing: Map<string, string>;
} {
  const backing = new Map<string, string>();
  const store = {
    set: vi.fn((name: string, plaintext: string) => {
      backing.set(name, plaintext);
      return ok(undefined);
    }),
    getDecrypted: vi.fn((name: string) => ok(backing.get(name))),
    decryptAll: vi.fn(() => ok(new Map(backing))),
    list: vi.fn(() => ok([])),
    delete: vi.fn((name: string) => ok(backing.delete(name))),
    close: vi.fn(),
    ...overrides,
  } as unknown as SecretStorePort;
  return { store, backing };
}

describe("resolveInteractiveCallbackSigningSecret", () => {
  it("generates a 32-byte base64url secret and persists it via set when the store is enabled and empty", () => {
    const { store, backing } = makeStubStore();
    const logger = makeLogger();

    const secret = resolveInteractiveCallbackSigningSecret(store, logger);

    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(0);
    // base64url alphabet only ([A-Za-z0-9_-]); 32 bytes → 43 chars unpadded.
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(store.set).toHaveBeenCalledWith(SECRET_NAME, secret);
    expect(backing.get(SECRET_NAME)).toBe(secret);
  });

  it("reads the SAME secret back on a subsequent start (stable across restart, enabled store)", () => {
    const { store } = makeStubStore();
    const logger = makeLogger();

    const first = resolveInteractiveCallbackSigningSecret(store, logger);
    // Restart: same backing store, secret already present → no regeneration.
    (store.set as ReturnType<typeof vi.fn>).mockClear();
    const second = resolveInteractiveCallbackSigningSecret(store, logger);

    expect(second).toBe(first);
    // The second start must NOT re-set (it reads the existing secret).
    expect(store.set).not.toHaveBeenCalled();
  });

  it("generates an in-memory secret when the store is disabled (undefined) — regenerated per process", () => {
    const logger = makeLogger();

    const a = resolveInteractiveCallbackSigningSecret(undefined, logger);
    const b = resolveInteractiveCallbackSigningSecret(undefined, logger);

    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]+$/);
    // Per-process random — two disabled-store resolutions are different secrets
    // (the documented fallback; in-flight approvals invalidate across restart).
    expect(a).not.toBe(b);
  });

  it("never writes the secret value into any log line", () => {
    const { store } = makeStubStore();
    const logger = makeLogger();

    const secret = resolveInteractiveCallbackSigningSecret(store, logger);
    const inMem = resolveInteractiveCallbackSigningSecret(undefined, logger);

    const allCalls = [
      ...(logger.trace as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const serialised = JSON.stringify(allCalls);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain(inMem);
  });

  it("falls back to a fresh in-memory secret when getDecrypted errors (corrupted/wrong-key store)", () => {
    const { store } = makeStubStore({
      getDecrypted: vi.fn(() => err(new Error("AEAD tag mismatch"))),
    });
    const logger = makeLogger();

    const secret = resolveInteractiveCallbackSigningSecret(store, logger);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThan(0);
  });

  it("treats an EMPTY-STRING store value as absent and regenerates (never key HMAC with an empty secret)", () => {
    // A degenerate/hand-edited store row decrypts to "". HMAC accepts an empty
    // key, so an empty secret would not break verification — but it collapses the
    // keyspace to a publicly-computable constant, making EVERY callback forgeable.
    // The resolver must treat "" the same as undefined: regenerate + persist.
    const { store, backing } = makeStubStore({
      getDecrypted: vi.fn(() => ok("")),
    });
    const logger = makeLogger();

    const secret = resolveInteractiveCallbackSigningSecret(store, logger);

    // A real 32-byte base64url secret, NOT the empty string read from the store.
    expect(secret.length).toBeGreaterThan(0);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    // The regenerate-and-persist branch ran (the empty value was rejected).
    expect(store.set).toHaveBeenCalledWith(SECRET_NAME, secret);
    expect(backing.get(SECRET_NAME)).toBe(secret);
  });
});

// ---------------------------------------------------------------------------
// createInteractiveCallbackWiring — the email-link mint → resolve roundtrip
// ---------------------------------------------------------------------------

const SHORT_ID = "abcDEF123456";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_K = "tenant:user_a:inbox-1:thread:thread-1";
const CREATED_AT = 1_000_000;
const TIMEOUT_MS = 300_000;

function makeFakeGate(seed: ApprovalRequest[]): {
  gate: ApprovalGate;
  resolveCalls: Array<{ requestId: string; approved: boolean }>;
} {
  const byShortId = new Map<string, ApprovalRequest>();
  const byRequestId = new Map<string, ApprovalRequest>();
  for (const r of seed) {
    byShortId.set(r.shortId, r);
    byRequestId.set(r.requestId, r);
  }
  const resolveCalls: Array<{ requestId: string; approved: boolean }> = [];
  const gate: ApprovalGate = {
    requestApproval: () => {
      throw new Error("not used");
    },
    resolveApproval: (requestId, approved) => {
      resolveCalls.push({ requestId, approved });
      const req = byRequestId.get(requestId);
      if (req) {
        byRequestId.delete(requestId);
        byShortId.delete(req.shortId);
      }
    },
    pending: () => Array.from(byRequestId.values()),
    getRequest: (requestId) => byRequestId.get(requestId),
    getRequestByShortId: (shortId) => byShortId.get(shortId),
    pendingForSession: (sessionKey) =>
      Array.from(byRequestId.values()).filter((r) => r.sessionKey === sessionKey),
    clearDenialCache: () => {},
    clearApprovalCache: () => {},
    serializePending: () => [],
    restorePending: () => 0,
    serializeApprovalCache: () => [],
    restoreApprovalCache: () => 0,
    dispose: () => {},
  };
  return { gate, resolveCalls };
}

function makeApprovalRequest(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: REQUEST_ID,
    shortId: SHORT_ID,
    toolName: "shell",
    action: "shell.exec",
    params: {},
    agentId: "main",
    sessionKey: SESSION_K,
    trustLevel: "untrusted",
    callbackOwner: {
      tenantId: "tenant",
      userId: "user_a",
      channelType: "email",
      channelKey: "inbox-1",
      threadId: "thread-1",
    },
    createdAt: CREATED_AT,
    timeoutMs: TIMEOUT_MS,
    ...over,
  } as ApprovalRequest;
}

function makeApprovalEvent(): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "00000000-0000-0000-0000-000000000000",
    sessionKey: SESSION_K,
    agentId: "main",
    traceId: "trace-a",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "start",
    status: "running",
    kind: "approval",
    semanticPhase: "queued",
    toolName: "shell",
    defaultLabel: "approval required: shell",
    approval: {
      shortId: SHORT_ID,
      expiresAt: CREATED_AT + TIMEOUT_MS,
      choices: [
        { id: "approve", defaultLabel: "Approve", style: "primary" },
        { id: "deny", defaultLabel: "Deny", style: "danger" },
      ],
    },
  } as ActivityEvent;
}

function makeConfig(): AppConfig {
  return {
    gateway: { host: "127.0.0.1", port: 4766 },
  } as unknown as AppConfig;
}

describe("createInteractiveCallbackWiring (email link → router roundtrip)", () => {
  it("mints an opaque link to the gateway /approve route (no signed HMAC wire form in the URL)", () => {
    const { gate } = makeFakeGate([makeApprovalRequest()]);
    const wiring = createInteractiveCallbackWiring({
      signingSecret: "test-signing-secret-32-bytes-aaaaaaaaaaaa",
      approvalGate: gate,
      clock: createFakeClock(CREATED_AT),
      config: makeConfig(),
      logger: makeLogger(),
    });

    const link = wiring.mintApprovalLink(makeApprovalEvent());
    expect(link).toBeDefined();
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:4766\/approve\//);
    // The opaque token — never the v1.<choice>.<shortId>.<hmac> signed payload.
    expect(link).not.toMatch(/v1\.(approve|deny|details)\./);
    expect(link).not.toContain(SHORT_ID);
    expect(wiring.tokens.size).toBe(1);
    const [entry] = Array.from(wiring.tokens.values());
    expect(entry).toMatchObject({
      sessionKey: SESSION_K,
      channelType: "email",
      channelKey: "inbox-1",
      agentId: "main",
    });
  });

  it("resolves the approval exactly once when the minted token is consumed (resolveApproval)", async () => {
    const { gate, resolveCalls } = makeFakeGate([makeApprovalRequest()]);
    const wiring = createInteractiveCallbackWiring({
      signingSecret: "test-signing-secret-32-bytes-aaaaaaaaaaaa",
      approvalGate: gate,
      clock: createFakeClock(CREATED_AT),
      config: makeConfig(),
      logger: makeLogger(),
    });

    wiring.mintApprovalLink(makeApprovalEvent());
    const [entry] = Array.from(wiring.tokens.values());
    expect(entry).toBeDefined();

    const resolved = await wiring.resolveApproval(entry!);
    expect(resolved).toBe(true);
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]!.requestId).toBe(REQUEST_ID);
    expect(resolveCalls[0]!.approved).toBe(true);
  });

  it("returns false (not resolved) when the underlying approval is already gone (replay after resolve)", async () => {
    const { gate, resolveCalls } = makeFakeGate([makeApprovalRequest()]);
    const wiring = createInteractiveCallbackWiring({
      signingSecret: "test-signing-secret-32-bytes-aaaaaaaaaaaa",
      approvalGate: gate,
      clock: createFakeClock(CREATED_AT),
      config: makeConfig(),
      logger: makeLogger(),
    });
    wiring.mintApprovalLink(makeApprovalEvent());
    const [entry] = Array.from(wiring.tokens.values());

    const first = await wiring.resolveApproval(entry!);
    const second = await wiring.resolveApproval(entry!);
    expect(first).toBe(true);
    expect(second).toBe(false); // pending entry already removed by the gate
    expect(resolveCalls).toHaveLength(1); // exactly once
  });

  it("rejects an owner-bound email token replayed through another channel or thread", async () => {
    const { gate, resolveCalls } = makeFakeGate([makeApprovalRequest()]);
    const wiring = createInteractiveCallbackWiring({
      signingSecret: "test-signing-secret-32-bytes-aaaaaaaaaaaa",
      approvalGate: gate,
      clock: createFakeClock(CREATED_AT),
      config: makeConfig(),
      logger: makeLogger(),
    });
    wiring.mintApprovalLink(makeApprovalEvent());
    const [entry] = Array.from(wiring.tokens.values());
    expect(entry).toBeDefined();

    await expect(wiring.resolveApproval({ ...entry!, channelType: "telegram" }))
      .resolves.toBe(false);
    await expect(wiring.resolveApproval({
      ...entry!,
      sessionKey: "tenant:user_a:inbox-1:thread:thread-2",
    })).resolves.toBe(false);
    expect(resolveCalls).toHaveLength(0);

    await expect(wiring.resolveApproval(entry!)).resolves.toBe(true);
    expect(resolveCalls).toHaveLength(1);
  });

  it("binds signCallbackData to the resolved secret (the renderer signer matches the router)", () => {
    const { gate } = makeFakeGate([makeApprovalRequest()]);
    const wiring = createInteractiveCallbackWiring({
      signingSecret: "test-signing-secret-32-bytes-aaaaaaaaaaaa",
      approvalGate: gate,
      clock: createFakeClock(CREATED_AT),
      config: makeConfig(),
      logger: makeLogger(),
    });
    const tag = wiring.signCallbackData("approve", SHORT_ID);
    // The signer produces the 16-char base64url HMAC tag the router verifies.
    expect(tag).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});
