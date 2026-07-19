// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for openai-codex-browser-login.ts.
 *
 * DI-seam tests (fetchFn + listenPort) in the oauth-device-code.test.ts
 * style — NO vi.mock. The callback server binds an ephemeral port in tests;
 * the test drives the browser-callback path by fetching the local server
 * directly with the state captured from onAuth's authorize URL.
 *
 * Coverage:
 *   1. parseAuthorizationInput: full URL / "code#state" / query-string / bare code / empty
 *   2. Authorize URL carries originator=comis + PKCE S256 challenge derived from the verifier
 *   3. Browser-callback happy path: callback hit → token exchange → credentials + accountId
 *   4. State mismatch on the callback is rejected (server keeps waiting), manual paste still works
 *   5. Manual-input race: pasted "code#state" wins when no callback arrives
 *   6. onPrompt fallback used when neither callback nor manual input produced a code
 *   7. Token exchange: missing accountId claim → throws the identity-derivation error
 *   8. Token exchange: HTTP error body propagates in the thrown message
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  loginOpenAICodexBrowser,
  parseAuthorizationInput,
} from "./openai-codex-browser-login.js";

/** Base64url-encode a UTF-8 string (JWT segment helper). */
function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Build an unsigned JWT with the given payload object. */
function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(payload))}.sig`;
}

const ACCESS_JWT = makeJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-42" },
});

/** Capturing fetch stub for the token-exchange POST. */
function makeExchangeFetch(
  response: { status: number; body: object | string },
  captured: { url?: string; body?: URLSearchParams },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.body = new URLSearchParams(String(init?.body));
    const bodyText =
      typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    return new Response(bodyText, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const GOOD_TOKEN_BODY = {
  access_token: ACCESS_JWT,
  refresh_token: "refresh-1",
  expires_in: 3600,
};

describe("parseAuthorizationInput", () => {
  it("extracts code+state from a full redirect URL", () => {
    expect(
      parseAuthorizationInput("http://localhost:1455/auth/callback?code=abc&state=st1"),
    ).toEqual({ code: "abc", state: "st1" });
  });

  it("splits the code#state paste format", () => {
    expect(parseAuthorizationInput("abc#st1")).toEqual({ code: "abc", state: "st1" });
  });

  it("parses a bare query-string paste", () => {
    expect(parseAuthorizationInput("code=abc&state=st1")).toEqual({ code: "abc", state: "st1" });
  });

  it("treats anything else as a bare code", () => {
    expect(parseAuthorizationInput("  abc  ")).toEqual({ code: "abc" });
  });

  it("returns empty for whitespace-only input", () => {
    expect(parseAuthorizationInput("   ")).toEqual({});
  });
});

describe("loginOpenAICodexBrowser", () => {
  it("browser-callback happy path: originator=comis, S256 challenge, exchange, accountId", async () => {
    const captured: { url?: string; body?: URLSearchParams } = {};
    let authUrl = "";
    let serverPort = 0;

    const creds = await loginOpenAICodexBrowser({
      fetchFn: makeExchangeFetch({ status: 200, body: GOOD_TOKEN_BODY }, captured),
      listenPort: 0,
      onListening: (port) => {
        serverPort = port;
      },
      onAuth: (info) => {
        authUrl = info.url;
        // Drive the callback exactly as the browser redirect would.
        const state = new URL(authUrl).searchParams.get("state") ?? "";
        void fetch(`http://127.0.0.1:${serverPort}/auth/callback?code=cb-code&state=${state}`);
      },
      onPrompt: vi.fn(async () => {
        throw new Error("onPrompt must not be reached on the callback path");
      }),
    });

    // Authorize URL contract — wire-visible client identity + PKCE S256.
    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("originator")).toBe("comis");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);

    // The challenge must be BASE64URL(SHA-256(verifier)) of the verifier sent on exchange.
    const verifier = captured.body?.get("code_verifier") ?? "";
    const expectedChallenge = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);

    // Exchange contract.
    expect(captured.url).toBe("https://auth.openai.com/oauth/token");
    expect(captured.body?.get("grant_type")).toBe("authorization_code");
    expect(captured.body?.get("code")).toBe("cb-code");

    // Credential mapping.
    expect(creds.access).toBe(ACCESS_JWT);
    expect(creds.refresh).toBe("refresh-1");
    expect(creds.accountId).toBe("acct-42");
    expect(creds.expires).toBeGreaterThan(Date.now());
  });

  it("rejects a state-mismatched callback and accepts manual paste instead", async () => {
    const captured: { url?: string; body?: URLSearchParams } = {};
    let serverPort = 0;
    let realState = "";

    const creds = await loginOpenAICodexBrowser({
      fetchFn: makeExchangeFetch({ status: 200, body: GOOD_TOKEN_BODY }, captured),
      listenPort: 0,
      onListening: (port) => {
        serverPort = port;
      },
      onAuth: (info) => {
        realState = new URL(info.url).searchParams.get("state") ?? "";
        void fetch(`http://127.0.0.1:${serverPort}/auth/callback?code=evil&state=WRONG`);
      },
      onManualCodeInput: async () => {
        // Give the mismatched callback a beat to be rejected first.
        await new Promise((r) => setTimeout(r, 150));
        return `manual-code#${realState}`;
      },
      onPrompt: vi.fn(async () => {
        throw new Error("onPrompt must not be reached when manual input succeeds");
      }),
    });

    expect(captured.body?.get("code")).toBe("manual-code");
    expect(creds.accountId).toBe("acct-42");
  });

  it("falls back to onPrompt when the manual input is empty and no callback arrives", async () => {
    const captured: { url?: string; body?: URLSearchParams } = {};
    let realState = "";

    const creds = await loginOpenAICodexBrowser({
      fetchFn: makeExchangeFetch({ status: 200, body: GOOD_TOKEN_BODY }, captured),
      listenPort: 0,
      onAuth: (info) => {
        realState = new URL(info.url).searchParams.get("state") ?? "";
      },
      onManualCodeInput: async () => "",
      onPrompt: async () => `prompt-code#${realState}`,
    });

    expect(captured.body?.get("code")).toBe("prompt-code");
    expect(creds.refresh).toBe("refresh-1");
  });

  it("throws a state-mismatch error when the manual paste carries a foreign state", async () => {
    await expect(
      loginOpenAICodexBrowser({
        fetchFn: makeExchangeFetch({ status: 200, body: GOOD_TOKEN_BODY }, {}),
        listenPort: 0,
        onAuth: () => {},
        onManualCodeInput: async () => "some-code#not-the-state",
        onPrompt: vi.fn(async () => "unused"),
      }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it("throws the identity-derivation error when the access token has no accountId claim", async () => {
    const noAccountJwt = makeJwt({ sub: "user-1" });
    await expect(
      loginOpenAICodexBrowser({
        fetchFn: makeExchangeFetch(
          {
            status: 200,
            body: { access_token: noAccountJwt, refresh_token: "r", expires_in: 60 },
          },
          {},
        ),
        listenPort: 0,
        onAuth: () => {},
        onManualCodeInput: async () => "code-1#",
        onPrompt: vi.fn(async () => "unused"),
      }),
    ).rejects.toThrow("Failed to extract accountId from token");
  });

  it("propagates the token-endpoint error body on HTTP failure", async () => {
    await expect(
      loginOpenAICodexBrowser({
        fetchFn: makeExchangeFetch({ status: 400, body: { error: "invalid_grant" } }, {}),
        listenPort: 0,
        onAuth: () => {},
        onManualCodeInput: async () => "code-1#",
        onPrompt: vi.fn(async () => "unused"),
      }),
    ).rejects.toThrow(/exchange failed \(400\).*invalid_grant/s);
  });
});
