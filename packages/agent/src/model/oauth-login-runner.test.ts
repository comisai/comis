// SPDX-License-Identifier: Apache-2.0
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  loginOpenAICodexOAuth,
  type RunnerPrompter,
} from "./oauth-login-runner.js";

// vi.mock MUST be hoisted — vitest hoists vi.mock calls so the module under
// test sees the mock, NOT the real implementation.
vi.mock("@mariozechner/pi-ai/oauth", () => ({
  loginOpenAICodex: vi.fn(),
}));

import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal JWT with the chatgpt_account_id claim pi-ai requires + email
 * claim Phase 7's resolveCodexAuthIdentity reads. Exp is far-future.
 */
function makeFixtureJwt(payload: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      sub: "user_test_001",
      "https://api.openai.com/profile": { email: "fixture@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_001" },
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...payload,
    }),
  ).toString("base64url");
  return `${header}.${body}.signature_placeholder`;
}

function makeMockPrompter(opts: {
  textResponses?: string[];
} = {}): RunnerPrompter & { text: ReturnType<typeof vi.fn> } {
  const queue = [...(opts.textResponses ?? [])];
  const text = vi.fn(async (_opts: { message: string; placeholder?: string }) => {
    return queue.shift() ?? "http://localhost:1455/cb?code=fake&state=fake";
  });
  return {
    text,
    spinner: () => ({
      start: vi.fn(),
      update: vi.fn(),
      stop: vi.fn(),
    }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.mocked(loginOpenAICodex).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// SPEC R1 acceptance — 5 cases
// ---------------------------------------------------------------------------

describe("loginOpenAICodexOAuth — R1 acceptance", () => {
  it("local mode openUrl is called with the authorize URL (R1.a)", async () => {
    const openUrl = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({} as never);
    vi.mocked(loginOpenAICodex).mockImplementation(async (cb: any) => {
      await cb.onAuth({ url: "https://auth.openai.com/oauth/authorize?state=abc" });
      return {
        access: makeFixtureJwt(),
        refresh: "rt_test",
        expires: Date.now() + 3_600_000,
      };
    });
    const result = await loginOpenAICodexOAuth({
      prompter: makeMockPrompter(),
      isRemote: false,
      openUrl,
    });
    expect(result.ok).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      expect.stringContaining("auth.openai.com/oauth/authorize"),
    );
  });

  it("remote mode no openUrl is called; manual paste prompt fires (R1.b)", async () => {
    const openUrl = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({} as never);
    const prompter = makeMockPrompter({
      textResponses: ["http://localhost:1455/cb?code=X&state=abc"],
    });
    vi.mocked(loginOpenAICodex).mockImplementation(async (cb: any) => {
      await cb.onAuth({ url: "https://auth.openai.com/oauth/authorize?state=abc" });
      // Pi-ai consumes the manual paste via onPrompt; trigger it.
      await cb.onPrompt({ message: "Paste the redirect URL" });
      return {
        access: makeFixtureJwt(),
        refresh: "rt_test",
        expires: Date.now() + 3_600_000,
      };
    });
    const result = await loginOpenAICodexOAuth({
      prompter,
      isRemote: true,
      openUrl,
    });
    expect(result.ok).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Open this URL in your LOCAL browser"),
    );
    expect(prompter.text).toHaveBeenCalled();
  });

  it("manual-paste timing fires at 15_000ms + 1_000ms grace (R1.c)", async () => {
    vi.useFakeTimers();
    const openUrl = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({} as never);
    const prompter = makeMockPrompter({
      textResponses: ["http://localhost:1455/cb?code=X&state=abc"],
    });
    // Pi-ai never settles → onManualCodeInput must fire after the timing race.
    vi.mocked(loginOpenAICodex).mockImplementation(async (cb: any) => {
      await cb.onAuth({ url: "https://auth.openai.com/oauth/authorize?state=abc" });
      // Simulate pi-ai calling onManualCodeInput (the runner-built handler)
      // when the local callback fails to arrive within the timing budget.
      const code = await cb.onManualCodeInput!();
      expect(code).toContain("code=X");
      return {
        access: makeFixtureJwt(),
        refresh: "rt_test",
        expires: Date.now() + 3_600_000,
      };
    });
    const promise = loginOpenAICodexOAuth({
      prompter,
      isRemote: false,
      openUrl,
    });
    // Advance past 15s + 1s grace boundary.
    await vi.advanceTimersByTimeAsync(15_001);
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await promise;
    expect(result.ok).toBe(true);
    // Manual-paste prompt fired.
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Paste the authorization code"),
      }),
    );
  });

  it("unsupported region maps to LoginError code:'unsupported_region' with HTTPS_PROXY hint (R1.d)", async () => {
    vi.mocked(loginOpenAICodex).mockRejectedValue(
      new Error("unsupported_country_region_territory"),
    );
    const result = await loginOpenAICodexOAuth({
      prompter: makeMockPrompter(),
      isRemote: false,
      openUrl: vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({} as never),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported_region");
    expect(result.error.hint).toContain("HTTPS_PROXY");
  });

  it("state mismatch maps to LoginError code:'callback_validation_failed' (R1.e)", async () => {
    vi.mocked(loginOpenAICodex).mockRejectedValue(new Error("state mismatch"));
    const result = await loginOpenAICodexOAuth({
      prompter: makeMockPrompter(),
      isRemote: false,
      openUrl: vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({} as never),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("callback_validation_failed");
  });
});

// ---------------------------------------------------------------------------
// Edge cases (per VALIDATION.md)
// ---------------------------------------------------------------------------

describe("loginOpenAICodexOAuth — edge cases", () => {
  it("port busy fallback: pi-ai pre-fires onManualCodeInput when callback unavailable", async () => {
    const prompter = makeMockPrompter({
      textResponses: ["http://localhost:1455/cb?code=Y&state=abc"],
    });
    vi.mocked(loginOpenAICodex).mockImplementation(async (cb: any) => {
      // No onAuth call (browser callback was unavailable per RESEARCH §Pitfall 3),
      // jump straight to manual paste.
      const code = await cb.onManualCodeInput!();
      expect(code).toContain("code=Y");
      return {
        access: makeFixtureJwt(),
        refresh: "rt_test",
        expires: Date.now() + 3_600_000,
      };
    });
    const result = await loginOpenAICodexOAuth({
      prompter,
      isRemote: false,
      openUrl: vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({} as never),
    });
    expect(result.ok).toBe(true);
    expect(prompter.text).toHaveBeenCalled();
  });

  it("malformed JWT (identity decode fails) returns LoginError code:'identity_decode_failed'", async () => {
    // Pi-ai itself can throw "Failed to extract accountId from token" if the
    // JWT lacks chatgpt_account_id (RESEARCH §Pitfall 2).
    vi.mocked(loginOpenAICodex).mockRejectedValue(
      new Error("Failed to extract accountId from token"),
    );
    const result = await loginOpenAICodexOAuth({
      prompter: makeMockPrompter(),
      isRemote: false,
      openUrl: vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({} as never),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("identity_decode_failed");
  });

  it("originator 'comis' is passed to pi-ai (RESEARCH §Pitfall 4)", async () => {
    vi.mocked(loginOpenAICodex).mockResolvedValue({
      access: makeFixtureJwt(),
      refresh: "rt_test",
      expires: Date.now() + 3_600_000,
    });
    await loginOpenAICodexOAuth({
      prompter: makeMockPrompter(),
      isRemote: false,
      openUrl: vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({} as never),
    });
    expect(loginOpenAICodex).toHaveBeenCalledWith(
      expect.objectContaining({ originator: "comis" }),
    );
  });

  it("success returns profileId 'openai-codex:<email>' derived from JWT", async () => {
    vi.mocked(loginOpenAICodex).mockResolvedValue({
      access: makeFixtureJwt({
        "https://api.openai.com/profile": { email: "alice@example.com" },
      }),
      refresh: "rt_test",
      expires: Date.now() + 3_600_000,
    });
    const result = await loginOpenAICodexOAuth({
      prompter: makeMockPrompter(),
      isRemote: false,
      openUrl: vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({} as never),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profileId).toBe("openai-codex:alice@example.com");
    expect(result.value.email).toBe("alice@example.com");
  });
});

// ---------------------------------------------------------------------------
// Phase 11 SC11-1 — method: "device-code" dispatch
// ---------------------------------------------------------------------------

describe("loginOpenAICodexOAuth — method: 'device-code' dispatch (Phase 11 SC11-1)", () => {
  it("when method is 'device-code' it does NOT call pi-ai's loginOpenAICodex (browser path)", async () => {
    // Stub pi-ai's loginOpenAICodex; if the device-code branch dispatches
    // correctly, this mock is never invoked. The device-code module makes
    // network requests via globalThis.fetch — without a fetchFn injection
    // those will fail; what we assert is purely that the browser path is
    // NOT taken when method === "device-code".
    vi.mocked(loginOpenAICodex).mockResolvedValue({
      access: makeFixtureJwt(),
      refresh: "rt_test",
      expires: Date.now() + 3_600_000,
    });

    // Force globalThis.fetch to reject so the device-code path returns err
    // immediately (we don't have a mock OAuth server in unit tests — that's
    // covered by the integration test in test/integration/oauth-device-code.test.ts).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    try {
      const result = await loginOpenAICodexOAuth({
        prompter: makeMockPrompter(),
        isRemote: false,
        openUrl: vi
          .fn<(url: string) => Promise<unknown>>()
          .mockResolvedValue({} as never),
        method: "device-code",
      });
      // Browser-path mock must NOT have been called.
      expect(loginOpenAICodex).not.toHaveBeenCalled();
      // Device-code path either returned err or threw; either way result.ok === false.
      expect(result.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("when method is 'browser' (or omitted) it preserves the existing browser-path behavior", async () => {
    // Backward-compatibility: method default is "browser". Existing browser
    // tests above already exhaust that path with method omitted; this test
    // is a pin asserting that explicit method:"browser" goes the browser way.
    vi.mocked(loginOpenAICodex).mockResolvedValue({
      access: makeFixtureJwt(),
      refresh: "rt_test",
      expires: Date.now() + 3_600_000,
    });
    const result = await loginOpenAICodexOAuth({
      prompter: makeMockPrompter(),
      isRemote: false,
      openUrl: vi
        .fn<(url: string) => Promise<unknown>>()
        .mockResolvedValue({} as never),
      method: "browser",
    });
    expect(result.ok).toBe(true);
    expect(loginOpenAICodex).toHaveBeenCalledTimes(1);
  });
});
