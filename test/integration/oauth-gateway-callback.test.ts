// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 11 gateway OAuth callback integration tests (SC11-2 / SC11-4).
 *
 * Run with: `pnpm test:integration -- oauth-gateway-callback` (after `pnpm build`).
 *
 * Strategy:
 * - SC11-2: seed the pending-flow map directly (no /oauth/start RPC in this
 *   phase per RESEARCH Q1 / Assumption A2), invoke the Hono sub-app via
 *   app.request(), assert store.set + auth:profile_bootstrapped + 200 HTML.
 * - SC11-4: assert pendingFlows.has(state) === false after success, after
 *   exchange failure, and after the 5-minute timeout fires.
 *
 * Status: RED scaffold (Wave 0). Imports `createOAuthCallbackRoute` and
 * `insertPendingFlow` from `@comis/gateway`; both are not yet exported, so
 * tests fail at the call site (the imports resolve to undefined). Plan 03
 * creates the module + adds exports; Plan 05 turns this file GREEN.
 */

import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import type { TypedEventBus } from "@comis/core";
import { createOAuthCredentialStoreFile } from "@comis/agent";
import {
  createOAuthCallbackRoute,
  insertPendingFlow,
  type PendingFlow,
} from "@comis/gateway";
import {
  createMockOAuthServer,
  type MockOAuthServer,
} from "../support/mock-oauth-server.js";

let mockServer: MockOAuthServer;
let mockBaseUrl: string;
let originalFetch: typeof globalThis.fetch;

beforeAll(async () => {
  mockServer = createMockOAuthServer();
  const { baseUrl } = await mockServer.start();
  mockBaseUrl = baseUrl;
  originalFetch = globalThis.fetch;
});

afterAll(async () => {
  if (mockServer) await mockServer.stop();
  if (originalFetch) globalThis.fetch = originalFetch;
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("https://auth.openai.com/")) {
        const suffix = url.replace("https://auth.openai.com", "");
        return originalFetch(`${mockBaseUrl}${suffix}`, init);
      }
      return originalFetch(input as RequestInfo, init);
    },
  );
  mockServer.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function freshTmpDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "comis-oauth-gateway-callback-"));
}

function cleanupTmpDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function makeMockLogger(): {
  debug: (..._a: unknown[]) => void;
  info: (..._a: unknown[]) => void;
  warn: (..._a: unknown[]) => void;
  error: (..._a: unknown[]) => void;
} {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("SC11-2 gateway callback end-to-end", () => {
  it("validates state, exchanges code, stores profile, emits auth:profile_bootstrapped, returns 200 HTML", async () => {
    const tmpDir = freshTmpDataDir();
    try {
      const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });
      const emittedEvents: Array<{ name: string; payload: unknown }> = [];
      const eventBus = {
        emit: vi.fn((name: string, payload: unknown) => {
          emittedEvents.push({ name, payload });
        }),
      } as unknown as TypedEventBus;
      const logger = makeMockLogger();
      const pendingFlows = new Map<string, PendingFlow>();
      const state = "test-state-" + randomBytes(8).toString("hex");
      insertPendingFlow(
        pendingFlows,
        state,
        { verifier: "test-verifier", provider: "openai-codex", createdAt: Date.now() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock logger
        logger as any,
      );

      const app = createOAuthCallbackRoute({
        credentialStore: store,
        eventBus,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock logger
        logger: logger as any,
        pendingFlows,
      });
      const res = await app.request(
        `/callback/openai-codex?code=test-code&state=${state}`,
        { method: "GET" },
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Login Successful");

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value.length).toBe(1);
      expect(listResult.value[0]!.profileId).toMatch(/^openai-codex:.+/);

      const bootstrapped = emittedEvents.find((e) => e.name === "auth:profile_bootstrapped");
      expect(bootstrapped).toBeDefined();

      // SC11-4 cleanup on success.
      expect(pendingFlows.has(state)).toBe(false);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});

describe("SC11-4 pending-flow cleanup", () => {
  it("removes entry on exchange failure (mock server returns 500 on /oauth/token)", async () => {
    const tmpDir = freshTmpDataDir();
    try {
      // Force the existing /oauth/token branch to error.
      mockServer.setNextResponse({ status: 500, body: { error: "server_error" } });

      const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });
      const eventBus = { emit: vi.fn() } as unknown as TypedEventBus;
      const logger = makeMockLogger();
      const pendingFlows = new Map<string, PendingFlow>();
      const state = "test-state-fail-" + randomBytes(8).toString("hex");
      insertPendingFlow(
        pendingFlows,
        state,
        { verifier: "test-verifier", provider: "openai-codex", createdAt: Date.now() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock logger
        logger as any,
      );

      const app = createOAuthCallbackRoute({
        credentialStore: store,
        eventBus,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock logger
        logger: logger as any,
        pendingFlows,
      });
      const res = await app.request(
        `/callback/openai-codex?code=fail-code&state=${state}`,
        { method: "GET" },
      );

      // Server-side exchange failed -> 500-class HTML response.
      expect(res.status).toBeGreaterThanOrEqual(500);
      // SC11-4: state still removed (cleanup happens BEFORE exchange attempt).
      expect(pendingFlows.has(state)).toBe(false);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  it("removes entry after 5-minute timeout via insertPendingFlow", async () => {
    vi.useFakeTimers();
    try {
      const pendingFlows = new Map<string, PendingFlow>();
      const logger = makeMockLogger();
      insertPendingFlow(
        pendingFlows,
        "timeout-state",
        { verifier: "v", provider: "openai-codex", createdAt: Date.now() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock logger
        logger as any,
      );
      expect(pendingFlows.has("timeout-state")).toBe(true);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      expect(pendingFlows.has("timeout-state")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SC11-2 state validation 400 paths", () => {
  it("returns 400 with no store mutation when state is unknown", async () => {
    const tmpDir = freshTmpDataDir();
    try {
      const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });
      const eventBus = { emit: vi.fn() } as unknown as TypedEventBus;
      const logger = makeMockLogger();
      const pendingFlows = new Map<string, PendingFlow>();
      // Do NOT seed pendingFlows.

      const app = createOAuthCallbackRoute({
        credentialStore: store,
        eventBus,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock logger
        logger: logger as any,
        pendingFlows,
      });

      const res = await app.request(
        `/callback/openai-codex?code=anything&state=unknown-state`,
        { method: "GET" },
      );

      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid or expired state");

      // No mutation:
      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value.length).toBe(0);
      expect(eventBus.emit).not.toHaveBeenCalled();
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  it("returns 400 when state and provider mismatch (preserves entry for legitimate provider)", async () => {
    const tmpDir = freshTmpDataDir();
    try {
      const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });
      const eventBus = { emit: vi.fn() } as unknown as TypedEventBus;
      const logger = makeMockLogger();
      const pendingFlows = new Map<string, PendingFlow>();
      // Seed for openai-codex.
      insertPendingFlow(
        pendingFlows,
        "shared-state",
        { verifier: "v", provider: "openai-codex", createdAt: Date.now() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock logger
        logger as any,
      );

      const app = createOAuthCallbackRoute({
        credentialStore: store,
        eventBus,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock logger
        logger: logger as any,
        pendingFlows,
      });

      // Wrong provider in URL.
      const res = await app.request(
        `/callback/anthropic?code=any&state=shared-state`,
        { method: "GET" },
      );
      expect(res.status).toBe(400);

      // Entry PRESERVED — the legitimate openai-codex callback can still consume it.
      expect(pendingFlows.has("shared-state")).toBe(true);
      expect(eventBus.emit).not.toHaveBeenCalled();

      // Cleanup the timer so vitest does not complain about open handles.
      for (const f of pendingFlows.values()) clearTimeout(f.timer);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});
