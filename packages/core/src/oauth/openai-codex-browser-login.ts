// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Protocol steps fail closed; the login runner boundary converts throws into Result values.
/**
 * OpenAI Codex browser OAuth flow (PKCE + localhost callback), owned by Comis.
 *
 * Comis owns this protocol implementation so the wire-visible `originator`
 * parameter names this product ("comis") on the authorization request —
 * the same client identity the sibling device-code flow sends. The flow is
 * protocol-compatible with the ChatGPT OAuth service used by Codex clients:
 * S256 PKCE, an authorization redirect to 127.0.0.1:1455/auth/callback, and
 * an authorization-code exchange at the token endpoint.
 *
 * UX belongs to the caller (oauth-login-runner): browser-open vs manual
 * paste, spinner text, error rewriting. This module races the local
 * callback server against an optional manual paste and falls back to a
 * final prompt, mirroring the runner's long-standing callback contract.
 *
 * @module
 */

import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { systemNowMs } from "../runtime/system-time.js";

// -------- Constants --------

const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${OPENAI_AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${OPENAI_AUTH_BASE_URL}/oauth/token`;
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CALLBACK_PORT = 1455;
const CALLBACK_HOST = "127.0.0.1";
const SCOPE = "openid profile email offline_access";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
/** Wire-visible client identifier sent to OpenAI — must name this product. */
const ORIGINATOR = "comis" as const;

// -------- Public types --------

/** Credentials returned on successful login. */
export interface CodexBrowserLoginCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

/** Options / DI seams for loginOpenAICodexBrowser. */
export interface LoginOpenAICodexBrowserOptions {
  /** Called once with the authorization URL when the flow starts. */
  onAuth: (info: { url: string; instructions?: string }) => void;
  /** Final fallback prompt when neither the callback nor manual input produced a code. */
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  /**
   * Optional manual paste input racing the browser callback — whichever
   * produces an authorization code first wins. Resolving with an empty
   * string abandons the manual path without failing the flow.
   */
  onManualCodeInput?: () => Promise<string>;
  /** Optional progress messages. */
  onProgress?: (message: string) => void;
  /** Dependency-injected fetch — defaults to globalThis.fetch. Used by tests. */
  fetchFn?: typeof fetch;
  /** Callback-server port. Production uses the registered 1455; tests pass 0. */
  listenPort?: number;
  /** Fires with the bound port once the callback server is listening. Test seam. */
  onListening?: (port: number) => void;
}

// -------- Helpers --------

/**
 * Parse a pasted authorization input: a full redirect URL, a "code#state"
 * pair, a bare query string, or a bare code.
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Generate an S256 PKCE verifier/challenge pair. */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", ORIGINATOR);
  return url.toString();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const decoded = Buffer.from(parts[1] ?? "", "base64").toString("utf8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract the ChatGPT account id claim from a Codex access token.
 * Shared with the OAuth token manager's refresh path, which recovers the
 * accountId from a refreshed access token.
 */
export function extractCodexAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[JWT_AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

interface TokenResponse {
  access: string;
  refresh: string;
  expires: number;
}

async function exchangeAuthorizationCode(
  fetchFn: typeof fetch,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`,
    );
  }
  const json = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number"
  ) {
    throw new Error(
      `OpenAI Codex token exchange response missing fields: ${JSON.stringify(json)}`,
    );
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: systemNowMs() + json.expires_in * 1000,
  };
}

function credentialsFromToken(token: TokenResponse): CodexBrowserLoginCredentials {
  const accountId = extractCodexAccountId(token.access);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token");
  }
  return { ...token, accountId };
}

interface CallbackServer {
  port: number;
  close(): void;
  cancelWait(): void;
  waitForCode(): Promise<{ code: string } | null>;
}

const CALLBACK_OK_HTML =
  "<!doctype html><body><p>OpenAI authentication completed. You can close this window.</p></body>";

function callbackErrorHtml(message: string): string {
  return `<!doctype html><body><p>${message}</p></body>`;
}

/**
 * Start the local OAuth callback server. A request with a mismatched state
 * or missing code is answered with an error page and does NOT settle the
 * wait — the legitimate redirect (or manual paste) can still land.
 */
function startCallbackServer(state: string, port: number): Promise<CallbackServer> {
  let settleWait: ((value: { code: string } | null) => void) | undefined;
  const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(callbackErrorHtml("Callback route not found."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(callbackErrorHtml("State mismatch."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(callbackErrorHtml("Missing authorization code."));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(CALLBACK_OK_HTML);
      settleWait?.({ code });
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(callbackErrorHtml("Internal error while processing OAuth callback."));
    }
  });

  return new Promise((resolve, reject) => {
    server
      .listen(port, CALLBACK_HOST, () => {
        const address = server.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        resolve({
          port: boundPort,
          close: () => server.close(),
          cancelWait: () => settleWait?.(null),
          waitForCode: () => waitForCodePromise,
        });
      })
      .on("error", (error) => {
        reject(
          new Error(
            `OAuth callback server failed to listen on ${CALLBACK_HOST}:${port}: ${error.message}`,
          ),
        );
      });
  });
}

// -------- Public flow --------

/**
 * Run the OpenAI Codex browser OAuth login: PKCE authorize URL → local
 * callback server raced against optional manual paste → code exchange.
 *
 * @throws Error on state mismatch, missing authorization code, token
 *   endpoint failure, or missing account identity in the access token.
 */
export async function loginOpenAICodexBrowser(
  options: LoginOpenAICodexBrowserOptions,
): Promise<CodexBrowserLoginCredentials> {
  const fetchFn = options.fetchFn ?? fetch;
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl(challenge, state);

  const server = await startCallbackServer(state, options.listenPort ?? CALLBACK_PORT);
  options.onListening?.(server.port);
  options.onAuth({
    url: authorizeUrl,
    instructions: "A browser window should open. Complete login to finish.",
  });

  const parseManualInput = (input: string): string | undefined => {
    const parsed = parseAuthorizationInput(input);
    if (parsed.state && parsed.state !== state) {
      throw new Error("State mismatch");
    }
    return parsed.code;
  };

  let code: string | undefined;
  try {
    if (options.onManualCodeInput) {
      // Race the browser callback against manual paste — first code wins.
      let manualCode: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((error: unknown) => {
          manualError = error instanceof Error ? error : new Error(String(error));
          server.cancelWait();
        });

      const result = await server.waitForCode();
      if (manualError) throw manualError;
      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        code = parseManualInput(manualCode);
      }
      if (!code) {
        await manualPromise;
        if (manualError) throw manualError;
        if (manualCode) code = parseManualInput(manualCode);
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) code = result.code;
    }

    if (!code) {
      options.onProgress?.("Waiting for pasted authorization code...");
      const input = await options.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
      code = parseManualInput(input);
    }
    if (!code) {
      throw new Error("Missing authorization code");
    }

    options.onProgress?.("Exchanging authorization code...");
    return credentialsFromToken(await exchangeAuthorizationCode(fetchFn, code, verifier));
  } finally {
    server.close();
  }
}
