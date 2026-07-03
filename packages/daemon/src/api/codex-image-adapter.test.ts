// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the per-call-bearer Codex image adapter (codex-image-adapter.ts).
 *
 * The adapter is an `ImageGenerationPort` that resolves the OAuth bearer PER
 * `execute()` via `oauthManager.getApiKey("openai-codex", {oauthProfiles})`
 * (so an expired token refreshes inside getApiKey), builds the CF
 * headers from that same freshly-resolved JWT, and drives the ONE
 * `generateImages()` call site.
 *
 * Determinism: the `OAuthTokenManager` is a `vi.fn()` mock (that IS the refresh
 * seam — refresh internals are tested in oauth-token-manager.test.ts). A FAKE
 * `openai-codex-images` transport is registered in `beforeEach` (capturing its
 * `options.{apiKey,headers}`) so `generateImages` dispatches to it WITHOUT a
 * network call. NEVER the network,
 * NEVER a real ChatGPT login.
 * @module
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { type AssistantImages, type ProviderImagesOptions } from "@earendil-works/pi-ai";
import { registerImagesApiProvider } from "@earendil-works/pi-ai/compat";
import type { OAuthError, OAuthTokenManager } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { makeMockLogger } from "../../../../test/support/mock-logger.js";
import { createCodexImageAdapter, CODEX_IMAGE_MODEL } from "./codex-image-adapter.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ACCOUNT_ID = "acct_123";

/** A codex JWT carrying `chatgpt_account_id: "acct_123"`. */
const VALID_BEARER = (() => {
  const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64url({ alg: "none", typ: "JWT" });
  const body = b64url({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } });
  return `${header}.${body}.sig`;
})();

/** Base64 of "PNG" — proves the buffer round-trip through toImageGenOutput. */
const PNG_B64 = Buffer.from("PNG").toString("base64");

/** Captured options from the fake transport (the round-trip assertion seam). */
interface CapturedTransport {
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * Register a fake `openai-codex-images` transport returning `result`, capturing
 * the `{apiKey,headers}` the adapter forwarded. Re-registering overwrites the
 * prior entry (registry is a Map keyed by api).
 */
function registerFakeTransport(
  result: Partial<AssistantImages>,
  captured: CapturedTransport,
): void {
  registerImagesApiProvider({
    api: "openai-codex-images",
    generateImages: async (model, _context, options?: ProviderImagesOptions) => {
      captured.apiKey = options?.apiKey;
      captured.headers = options?.headers;
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [],
        stopReason: "stop",
        timestamp: Date.now(),
        ...result,
      } as AssistantImages;
    },
  });
}

/** Build a mock OAuthTokenManager whose getApiKey is a vi.fn() (the refresh seam). */
function mockOauth(
  getApiKeyImpl: () => Promise<Result<string, OAuthError>>,
  hasCreds = true,
): { manager: OAuthTokenManager; getApiKey: ReturnType<typeof vi.fn> } {
  const getApiKey = vi.fn(getApiKeyImpl);
  const manager = {
    getApiKey,
    hasCredentials: () => hasCreds,
  } as unknown as OAuthTokenManager;
  return { manager, getApiKey };
}

let captured: CapturedTransport;
let logger: ReturnType<typeof makeMockLogger>;

beforeEach(() => {
  vi.clearAllMocks();
  captured = {};
  logger = makeMockLogger();
  // Default fake: a successful PNG. Individual tests re-register as needed.
  registerFakeTransport(
    { stopReason: "stop", output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] },
    captured,
  );
});

// ---------------------------------------------------------------------------
// Per-call getApiKey + refresh seam
// ---------------------------------------------------------------------------

describe("createCodexImageAdapter — per-call bearer", () => {
  it("resolves the bearer per execute() via getApiKey('openai-codex', {oauthProfiles})", async () => {
    const { manager, getApiKey } = mockOauth(async () => ok(VALID_BEARER));
    const adapter = createCodexImageAdapter({
      oauthManager: manager,
      oauthProfiles: { "openai-codex": "default" },
      logger: logger as never,
    });

    await adapter.execute({ prompt: "x" });

    expect(getApiKey).toHaveBeenCalledWith("openai-codex", {
      oauthProfiles: { "openai-codex": "default" },
    });
    // The refreshed bearer reached the transport (proves the await ordering).
    expect(captured.apiKey).toBe(VALID_BEARER);
  });

  it("threads a refreshed bearer through to the transport", async () => {
    const refreshed = (() => {
      const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
      return `${b64url({ alg: "none" })}.${b64url({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_refreshed" } })}.sig`;
    })();
    const { manager } = mockOauth(async () => ok(refreshed));
    const adapter = createCodexImageAdapter({ oauthManager: manager, logger: logger as never });

    const result = await adapter.execute({ prompt: "x" });

    expect(result.ok).toBe(true);
    expect(captured.apiKey).toBe(refreshed);
    expect(captured.headers?.["ChatGPT-Account-ID"]).toBe("acct_refreshed");
  });
});

// ---------------------------------------------------------------------------
// 401 / no-cred → auth_required + hint
// ---------------------------------------------------------------------------

describe("createCodexImageAdapter — auth failures", () => {
  const codes: OAuthError["code"][] = [
    "REFRESH_FAILED",
    "NO_CREDENTIALS",
    "PROFILE_NOT_FOUND",
    "NO_PROVIDER",
    "STORE_FAILED",
  ];

  for (const code of codes) {
    it(`maps a getApiKey err(${code}) to ImageGenError(auth_required) with a 'comis auth login' hint`, async () => {
      const { manager } = mockOauth(async () =>
        err({ code, message: "nope", providerId: "openai-codex" }),
      );
      const adapter = createCodexImageAdapter({ oauthManager: manager, logger: logger as never });

      const result = await adapter.execute({ prompt: "x" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.name).toBe("ImageGenError");
      expect((result.error as { imageErrorKind?: string }).imageErrorKind).toBe("auth_required");
      expect((result.error as { hint?: string }).hint).toContain("comis auth login");
      // No transport call when auth fails.
      expect(captured.apiKey).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// CF headers reach the transport from the resolved JWT
// ---------------------------------------------------------------------------

describe("createCodexImageAdapter — CF headers", () => {
  it("forwards originator + ChatGPT-Account-ID + codex User-Agent built from the bearer JWT", async () => {
    const { manager } = mockOauth(async () => ok(VALID_BEARER));
    const adapter = createCodexImageAdapter({ oauthManager: manager, logger: logger as never });

    await adapter.execute({ prompt: "x" });

    expect(captured.headers?.originator).toBe("codex_cli_rs");
    expect(captured.headers?.["ChatGPT-Account-ID"]).toBe(ACCOUNT_ID);
    expect(captured.headers?.["User-Agent"]).toMatch(/^codex_cli_rs\//);
  });
});

// ---------------------------------------------------------------------------
// Success / empty mapping (reuses the shipped toImageGenOutput)
// ---------------------------------------------------------------------------

describe("createCodexImageAdapter — result mapping", () => {
  it("maps a successful image to {buffer, mimeType} via the reused toImageGenOutput", async () => {
    const { manager } = mockOauth(async () => ok(VALID_BEARER));
    registerFakeTransport(
      { stopReason: "stop", output: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] },
      captured,
    );
    const adapter = createCodexImageAdapter({ oauthManager: manager, logger: logger as never });

    const result = await adapter.execute({ prompt: "x" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe("image/png");
    expect(result.value.buffer.toString()).toBe("PNG");
  });

  it("maps an empty_response transport result to ImageGenError(empty_response)", async () => {
    const { manager } = mockOauth(async () => ok(VALID_BEARER));
    registerFakeTransport(
      { stopReason: "error", errorMessage: "empty_response: no image in stream", output: [] },
      captured,
    );
    const adapter = createCodexImageAdapter({ oauthManager: manager, logger: logger as never });

    const result = await adapter.execute({ prompt: "x" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { imageErrorKind?: string }).imageErrorKind).toBe("empty_response");
  });

  it("surfaces the transport's raw failure cause (e.g. an HTTP status) at WARN so it is diagnosable from logs", async () => {
    const { manager } = mockOauth(async () => ok(VALID_BEARER));
    // The transport saw a fast non-2xx → errorMessage "codex 400": the REAL
    // cause the shipped classifier collapses into a generic "non-image response"
    // (the "returned no image twice" incident — the status was never logged).
    registerFakeTransport({ stopReason: "error", errorMessage: "codex 400", output: [] }, captured);
    const adapter = createCodexImageAdapter({ oauthManager: manager, logger: logger as never });

    await adapter.execute({ prompt: "x" });

    // The raw cause must now be visible in the logs (was the obs gap).
    const logged = JSON.stringify(logger._calls());
    expect(logged).toContain("codex 400");
    expect(logged).toContain("codex_image_failed");
  });

  // A response.failed message surfaced by the transport must
  // classify to the CAUSE-specific ImageErrorKind via the shipped
  // classifyImageError — NOT a generic empty_response. These assert the full
  // chain (transport errorMessage -> toImageGenOutput -> classifyImageError).
  const failureCases: { label: string; message: string; kind: string }[] = [
    { label: "content policy block", message: "Your request was rejected by the content policy", kind: "content_blocked" },
    { label: "quota / rate limit", message: "You exceeded your current quota, please check your plan", kind: "quota_exceeded" },
    { label: "auth / 401", message: "401 Unauthorized: invalid bearer", kind: "auth_required" },
    // A live HTTP 400 incident: a permanent contract 4xx (invalid model / missing
    // instructions / store) must classify NON-retryable (bad_request), NOT the
    // retryable empty_response — else the agent retries a permanent error
    // (verified live: "the provider returned no image twice").
    {
      label: "permanent 4xx contract error",
      message: 'codex 400: {"detail":"Instructions are required"}',
      kind: "bad_request",
    },
  ];
  for (const { label, message, kind } of failureCases) {
    it(`maps a response.failed "${label}" message to ImageGenError(${kind})`, async () => {
      const { manager } = mockOauth(async () => ok(VALID_BEARER));
      // The transport surfaces response.error.message verbatim as errorMessage.
      registerFakeTransport({ stopReason: "error", errorMessage: message, output: [] }, captured);
      const adapter = createCodexImageAdapter({ oauthManager: manager, logger: logger as never });

      const result = await adapter.execute({ prompt: "x" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as { imageErrorKind?: string }).imageErrorKind).toBe(kind);
    });
  }
});

// ---------------------------------------------------------------------------
// timeoutMs must wire a real AbortSignal — a hung stream
// must time out, not block forever.
// ---------------------------------------------------------------------------

describe("createCodexImageAdapter — timeout", () => {
  it("aborts a hung transport after timeoutMs and maps it to timeout", async () => {
    vi.useFakeTimers();
    try {
      // A transport that NEVER completes until its abort signal fires — the
      // hung-stream failure mode this suite guards against. It resolves only when
      // the adapter's timeout AbortController aborts the passed signal.
      registerImagesApiProvider({
        api: "openai-codex-images",
        generateImages: (model, _context, options?: ProviderImagesOptions) =>
          new Promise<AssistantImages>((resolve) => {
            const signal = options?.signal;
            const onAbort = () =>
              resolve({
                api: model.api,
                provider: model.provider,
                model: model.id,
                output: [],
                // Mirrors the real transport: an aborted signal → "aborted".
                stopReason: "aborted",
                timestamp: Date.now(),
              });
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort);
          }),
      });
      const { manager } = mockOauth(async () => ok(VALID_BEARER));
      const adapter = createCodexImageAdapter({
        oauthManager: manager,
        timeoutMs: 50,
        logger: logger as never,
      });

      const resultPromise = adapter.execute({ prompt: "x" });
      // Let the per-call getApiKey microtask + the generateImages dispatch run,
      // THEN advance past the 50ms timeout so the AbortController fires.
      await vi.advanceTimersByTimeAsync(60);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as { imageErrorKind?: string }).imageErrorKind).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout timer on the success path (no dangling timer)", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = mockOauth(async () => ok(VALID_BEARER));
      // Default fake transport resolves immediately with a PNG.
      const adapter = createCodexImageAdapter({
        oauthManager: manager,
        timeoutMs: 10_000,
        logger: logger as never,
      });

      const result = await adapter.execute({ prompt: "x" });

      expect(result.ok).toBe(true);
      // The success path must have cleared the pending timeout — otherwise a
      // 10s timer would keep the loop alive.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// isAvailable + the hand-built model
// ---------------------------------------------------------------------------

describe("createCodexImageAdapter — isAvailable + model", () => {
  it("returns oauthManager.hasCredentials('openai-codex') from isAvailable", () => {
    const present = createCodexImageAdapter({
      oauthManager: mockOauth(async () => ok(VALID_BEARER), true).manager,
      logger: logger as never,
    });
    const absent = createCodexImageAdapter({
      oauthManager: mockOauth(async () => ok(VALID_BEARER), false).manager,
      logger: logger as never,
    });
    expect(present.isAvailable()).toBe(true);
    expect(absent.isAvailable()).toBe(false);
    expect(present.id).toBe("openai-codex");
  });

  it("isAvailable() prefers the store-aware credentialsAvailable snapshot over the cold-cache hasCredentials", () => {
    // Cold cache (hasCredentials=false) but the boot store-probe found the
    // logged-in profile → the adapter MUST report available (the cold-cache fix).
    const coldButLoggedIn = createCodexImageAdapter({
      oauthManager: mockOauth(async () => ok(VALID_BEARER), false).manager,
      credentialsAvailable: true,
      logger: logger as never,
    });
    expect(coldButLoggedIn.isAvailable()).toBe(true);
    // An explicit store-aware false is respected even over a stale-true cache.
    const storeSaysNo = createCodexImageAdapter({
      oauthManager: mockOauth(async () => ok(VALID_BEARER), true).manager,
      credentialsAvailable: false,
      logger: logger as never,
    });
    expect(storeSaysNo.isAvailable()).toBe(false);
  });

  it("exports a hand-built codex ImagesModel pointing at the ChatGPT backend", () => {
    expect(CODEX_IMAGE_MODEL.api).toBe("openai-codex-images");
    expect(CODEX_IMAGE_MODEL.provider).toBe("openai-codex");
    expect(CODEX_IMAGE_MODEL.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(CODEX_IMAGE_MODEL.id).toBe("gpt-image-1");
  });
});

// ---------------------------------------------------------------------------
// No secret in any log payload
// ---------------------------------------------------------------------------

describe("createCodexImageAdapter — secret-logging discipline", () => {
  it("never logs the bearer / account-id / headers object on the auth failure path", async () => {
    const { manager } = mockOauth(async () =>
      err({ code: "REFRESH_FAILED", message: "x", providerId: "openai-codex" }),
    );
    const adapter = createCodexImageAdapter({ oauthManager: manager, logger: logger as never });

    await adapter.execute({ prompt: "x" });

    const serialized = JSON.stringify(logger._calls());
    expect(serialized).not.toContain(VALID_BEARER);
    expect(serialized).not.toContain(ACCOUNT_ID);
    expect(serialized).not.toContain("Bearer ");
  });

  it("never logs the bearer / account-id on a generic (empty_response) failure", async () => {
    const { manager } = mockOauth(async () => ok(VALID_BEARER));
    registerFakeTransport(
      { stopReason: "error", errorMessage: "empty_response: no image in stream", output: [] },
      captured,
    );
    const adapter = createCodexImageAdapter({ oauthManager: manager, logger: logger as never });

    await adapter.execute({ prompt: "x" });

    const serialized = JSON.stringify(logger._calls());
    expect(serialized).not.toContain(VALID_BEARER);
    expect(serialized).not.toContain(ACCOUNT_ID);
  });
});
