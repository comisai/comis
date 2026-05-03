// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 11 device-code OAuth integration tests (SC11-1 / SC11-3).
 *
 * Note: test/vitest.config.ts already enforces maxConcurrency: 1 +
 * pool: "forks" + retry: 1 — sequential annotation is REDUNDANT.
 *
 * Run with: `pnpm test:integration -- oauth-device-code` (after `pnpm build`).
 *
 * Strategy:
 * - SC11-1: call loginOpenAICodexDeviceCode directly with mock fetch routing
 *   https://auth.openai.com/* to mock-oauth-server device-code endpoints.
 * - SC11-3: assert profileId shape and that the resulting profile lands in
 *   the Phase 7 OAuthCredentialStorePort (file adapter) under canonical ID.
 *
 * Status: RED scaffold (Wave 0). Imports `loginOpenAICodexDeviceCode` and
 * `resolveCodexAuthIdentity` from `@comis/agent`; the device-code module
 * does not exist yet, so the dist/index.js export resolves to undefined and
 * tests fail at the call site. Plans 02-04 wire the export. Plan 05 turns
 * this file GREEN end-to-end.
 */

import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
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
import type { OAuthProfile } from "@comis/core";
import {
  createOAuthCredentialStoreFile,
  loginOpenAICodexDeviceCode,
  resolveCodexAuthIdentity,
} from "@comis/agent";
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
  return mkdtempSync(path.join(os.tmpdir(), "comis-oauth-device-code-"));
}

function cleanupTmpDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

describe("SC11-1 device-code flow end-to-end (mock OAuth server)", () => {
  it("completes 3-step flow: usercode -> poll (2x 403, 1x 200) -> exchange -> tokens", async () => {
    mockServer.setDeviceCodePollsUntilSuccess(2);
    const onVerification = vi.fn();
    const onProgress = vi.fn();
    const result = await loginOpenAICodexDeviceCode({
      onVerification,
      onProgress,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value.access).toBe("string");
    expect(result.value.access.length).toBeGreaterThan(0);
    expect(typeof result.value.refresh).toBe("string");
    expect(typeof result.value.expires).toBe("number");

    // Mock-server counters confirm the 3-step protocol.
    expect(mockServer.getRequestCount("deviceauth/usercode")).toBe(1);
    expect(mockServer.getRequestCount("deviceauth/token")).toBe(3);
    expect(mockServer.getRequestCount("authorization_code")).toBe(1);

    // onVerification was called once with a populated prompt.
    expect(onVerification).toHaveBeenCalledOnce();
    const prompt = onVerification.mock.calls[0]![0] as {
      verificationUrl: string;
      userCode: string;
      expiresInMs: number;
    };
    expect(prompt.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(prompt.userCode).toBe("TEST-1234");
    expect(prompt.expiresInMs).toBe(15 * 60_000);

    // onProgress fired during polling (>=1 stage label).
    expect(onProgress).toHaveBeenCalled();
  });

  it("SC11-3: persists profile to Phase 7 store with canonical openai-codex:<email> profileId", async () => {
    const tmpDir = freshTmpDataDir();
    try {
      mockServer.setDeviceCodePollsUntilSuccess(0); // succeed on first poll
      const result = await loginOpenAICodexDeviceCode({
        onVerification: vi.fn(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Identity derivation matches the Phase 8 runner pattern.
      const identity = resolveCodexAuthIdentity({ accessToken: result.value.access });
      const identityKey = identity.email ?? identity.profileName ?? "env-bootstrap";
      const profileId = `openai-codex:${identityKey}`;

      const store = createOAuthCredentialStoreFile({ dataDir: tmpDir });
      const profile: OAuthProfile = {
        provider: "openai-codex",
        profileId,
        access: result.value.access,
        refresh: result.value.refresh,
        expires: result.value.expires,
        email: identity.email,
        displayName: identity.profileName,
        version: 1,
      };
      const writeResult = await store.set(profileId, profile);
      expect(writeResult.ok).toBe(true);

      const listResult = await store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value.length).toBe(1);
      expect(listResult.value[0]!.profileId).toMatch(/^openai-codex:.+/);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  it("SC11-3 robustness: two consecutive device-code logins succeed independently", async () => {
    mockServer.setDeviceCodePollsUntilSuccess(0);

    const r1 = await loginOpenAICodexDeviceCode({ onVerification: vi.fn() });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = await loginOpenAICodexDeviceCode({ onVerification: vi.fn() });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // The mock server uses crypto.randomBytes for refresh tokens — each
    // login produces a distinct refresh string. Access tokens may share
    // the JWT payload but differ by signature placeholder.
    expect(r1.value.refresh).not.toBe(r2.value.refresh);

    // Mock server saw 2x usercode + 2x exchange + ≥2 polls.
    expect(mockServer.getRequestCount("deviceauth/usercode")).toBe(2);
    expect(mockServer.getRequestCount("authorization_code")).toBe(2);
  });
});
