// SPDX-License-Identifier: Apache-2.0
// @allow-throw: OAuth device-code flow validation throws (state validation, response-shape guards); consumed via auth-handlers daemon RPC. State-machine throws are caller-bounded — the device-code orchestrator catches at each transition boundary.
/**
 * OAuth device-code login for OpenAI Codex.
 *
 * Sibling-dependency of `loginOpenAICodexOAuth`: the login runner dispatches
 * to `loginOpenAICodexDeviceCode` when callers select `method: "device-code"`,
 * so both files live together in @comis/core.
 *
 * Implementation notes:
 *   1. ORIGINATOR header is the literal "comis".
 *   2. Header values are fixed strings — no version-header lookup; the
 *      header is informational, and CLAUDE.md forbids reading runtime env
 *      in library code.
 *   3. trimNonEmptyString is INLINE (3-line helper; rule of three not met).
 *   4. resolveCodexAccessTokenExpiry is imported from Comis's
 *      oauth-identity.ts module.
 *   5. Public boundary returns Result<T,E> (never throws) — internal
 *      helpers still throw, but the top-level loginOpenAICodexDeviceCode
 *      wraps everything in try/catch + rewriteOAuthError + narrowing.
 *
 * Protocol: OpenAI's proprietary 3-step device-code flow (NOT RFC 8628):
 *   1. POST /api/accounts/deviceauth/usercode -> device_auth_id + user_code
 *   2. Poll POST /api/accounts/deviceauth/token (403/404 = pending, 200 =
 *      authorization_code + code_verifier; verifier comes FROM the server)
 *   3. POST /oauth/token grant_type=authorization_code -> tokens
 *
 * This module never logs — the caller (oauth-login-runner.ts) is responsible
 * for surfacing progress via prompter.log.info / Pino. No logger import.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { rewriteOAuthError, resolveCodexAccessTokenExpiry } from "../security/oauth-helpers.js";
import type { OAuthErrorCode } from "../security/oauth-helpers.js";
import type { LoginError } from "./oauth-login-runner.js";
import { systemNowMs, systemSleep } from "../runtime/system-time.js";

// -------- Constants --------
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const ORIGINATOR = "comis" as const;
const VERIFICATION_URL = `${OPENAI_AUTH_BASE_URL}/codex/device`;

// -------- Public types --------

/** The verification prompt surfaced to the caller — userCode + URL the user types/visits on phone. */
export interface DeviceCodeVerificationPrompt {
  verificationUrl: string;
  userCode: string;
  expiresInMs: number;
}

/** Options / DI seams for loginOpenAICodexDeviceCode. */
export interface LoginOpenAICodexDeviceCodeOptions {
  /** Dependency-injected fetch — defaults to globalThis.fetch. Used by tests. */
  fetchFn?: typeof fetch;
  /** Called once when userCode + verificationUrl are known. */
  onVerification: (prompt: DeviceCodeVerificationPrompt) => Promise<void> | void;
  /** Optional progress callback fired with stage strings during the flow. */
  onProgress?: (message: string) => void;
}

// -------- Internal types --------
interface DeviceCodeUserCodePayload {
  device_auth_id?: unknown;
  user_code?: unknown;
  usercode?: unknown;
  interval?: unknown;
}

interface DeviceCodeTokenPayload {
  authorization_code?: unknown;
  code_challenge?: unknown;
  code_verifier?: unknown;
}

interface OAuthTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

interface RequestedDeviceCode {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
}

interface DeviceCodeAuthorizationCode {
  authorizationCode: string;
  codeVerifier: string;
}

interface OpenAICodexDeviceCodeCredentials {
  access: string;
  refresh: string;
  expires: number;
}

// -------- Helpers --------

/**
 * INLINE 3-line helper (rule of three not met — same shape as the helper in
 * oauth-identity.ts but kept local to avoid coupling).
 */
function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Build the 3-key header set for the device-code flow.
 * Header values are fixed strings — no version-header lookup, no env reads.
 */
function resolveOpenAICodexDeviceCodeHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    originator: ORIGINATOR,
    "User-Agent": ORIGINATOR,
  };
}

function normalizePositiveMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  return undefined;
}

function normalizeTokenLifetimeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10) * 1000;
  }
  return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Strip ANSI/control characters from upstream error bodies before bubbling
 * the message to a user-facing surface. Defends against terminal hijack via
 * malicious error responses.
 */
function sanitizeDeviceCodeErrorText(value: string): string {
  const esc = String.fromCharCode(0x1b);
  // eslint-disable-next-line security/detect-non-literal-regexp -- regex built from module constants only (String.fromCharCode literal); no user input reaches the constructor
  const ansiCsiRegex = new RegExp(`${esc}\\[[\\u0020-\\u003f]*[\\u0040-\\u007e]`, "g");
  // eslint-disable-next-line security/detect-non-literal-regexp -- regex built from module constants only
  const osc8Regex = new RegExp(`${esc}\\]8;;.*?${esc}\\\\|${esc}\\]8;;${esc}\\\\`, "g");
  const c0Start = String.fromCharCode(0x00);
  const c0End = String.fromCharCode(0x1f);
  const del = String.fromCharCode(0x7f);
  const c1Start = String.fromCharCode(0x80);
  const c1End = String.fromCharCode(0x9f);
  // eslint-disable-next-line security/detect-non-literal-regexp -- regex built from module constants only
  const controlCharsRegex = new RegExp(`[${c0Start}-${c0End}${del}${c1Start}-${c1End}]`, "g");
  return value
    .replace(osc8Regex, "")
    .replace(ansiCsiRegex, "")
    .replace(controlCharsRegex, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveNextDeviceCodePollDelayMs(intervalMs: number, deadlineMs: number): number {
  const remainingMs = Math.max(0, deadlineMs - systemNowMs());
  return Math.min(Math.max(intervalMs, OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS), remainingMs);
}

function formatDeviceCodeError(params: {
  prefix: string;
  status: number;
  bodyText: string;
}): string {
  const body = parseJsonObject(params.bodyText);
  const error = trimNonEmptyString(body?.error);
  const description = trimNonEmptyString(body?.error_description);
  const safeError = error ? sanitizeDeviceCodeErrorText(error) : undefined;
  const safeDescription = description ? sanitizeDeviceCodeErrorText(description) : undefined;
  if (safeError && safeDescription) {
    return `${params.prefix}: ${safeError} (${safeDescription})`;
  }
  if (safeError) {
    return `${params.prefix}: ${safeError}`;
  }
  const bodyText = sanitizeDeviceCodeErrorText(params.bodyText);
  return bodyText
    ? `${params.prefix}: HTTP ${params.status} ${bodyText}`
    : `${params.prefix}: HTTP ${params.status}`;
}

async function requestOpenAICodexDeviceCode(fetchFn: typeof fetch): Promise<RequestedDeviceCode> {
  const response = await fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: resolveOpenAICodexDeviceCodeHeaders("application/json"),
    body: JSON.stringify({
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        "OpenAI Codex device code login is not enabled for this server. Use ChatGPT OAuth instead.",
      );
    }
    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device code request failed",
        status: response.status,
        bodyText,
      }),
    );
  }

  const body = parseJsonObject(bodyText) as DeviceCodeUserCodePayload | null;
  const deviceAuthId = trimNonEmptyString(body?.device_auth_id);
  const userCode = trimNonEmptyString(body?.user_code) ?? trimNonEmptyString(body?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI device code response was missing the device code or user code.");
  }

  return {
    deviceAuthId,
    userCode,
    verificationUrl: VERIFICATION_URL,
    intervalMs:
      normalizePositiveMilliseconds(body?.interval) ?? OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
  };
}

async function pollOpenAICodexDeviceCode(params: {
  fetchFn: typeof fetch;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}): Promise<DeviceCodeAuthorizationCode> {
  const deadline = systemNowMs() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS;

  while (systemNowMs() < deadline) {
    const response = await params.fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: resolveOpenAICodexDeviceCodeHeaders("application/json"),
      body: JSON.stringify({
        device_auth_id: params.deviceAuthId,
        user_code: params.userCode,
      }),
    });

    const bodyText = await response.text();
    if (response.ok) {
      const body = parseJsonObject(bodyText) as DeviceCodeTokenPayload | null;
      const authorizationCode = trimNonEmptyString(body?.authorization_code);
      const codeVerifier = trimNonEmptyString(body?.code_verifier);
      if (!authorizationCode || !codeVerifier) {
        throw new Error("OpenAI device authorization response was missing the exchange code.");
      }
      return {
        authorizationCode,
        codeVerifier,
      };
    }

    if (response.status === 403 || response.status === 404) {
      await systemSleep(resolveNextDeviceCodePollDelayMs(params.intervalMs, deadline));
      continue;
    }

    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device authorization failed",
        status: response.status,
        bodyText,
      }),
    );
  }

  throw new Error("OpenAI device authorization timed out after 15 minutes.");
}

async function exchangeOpenAICodexDeviceCode(params: {
  fetchFn: typeof fetch;
  authorizationCode: string;
  codeVerifier: string;
}): Promise<OpenAICodexDeviceCodeCredentials> {
  const response = await params.fetchFn(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: resolveOpenAICodexDeviceCodeHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.authorizationCode,
      redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: params.codeVerifier,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device token exchange failed",
        status: response.status,
        bodyText,
      }),
    );
  }

  const body = parseJsonObject(bodyText) as OAuthTokenPayload | null;
  const access = trimNonEmptyString(body?.access_token);
  const refresh = trimNonEmptyString(body?.refresh_token);
  if (!access || !refresh) {
    throw new Error("OpenAI token exchange succeeded but did not return OAuth tokens.");
  }

  const expiresInMs = normalizeTokenLifetimeMs(body?.expires_in);
  const expires =
    expiresInMs !== undefined
      ? systemNowMs() + expiresInMs
      : (resolveCodexAccessTokenExpiry(access) ?? systemNowMs());

  return {
    access,
    refresh,
    expires,
  };
}

/**
 * Narrow the (broader) OAuthErrorCode catalogue back to the 4-case
 * LoginError["code"] union the public boundary promises. Mirror of
 * oauth-login-runner.ts:269-281 — duplicated verbatim because each call
 * site has a distinct LoginError-shaped union (rule of three not met).
 */
function narrowToLoginError(code: OAuthErrorCode): LoginError["code"] {
  switch (code) {
    case "unsupported_region":
    case "callback_validation_failed":
    case "callback_timeout":
    case "identity_decode_failed":
      return code;
    case "invalid_grant":
    case "refresh_token_reused":
      return "callback_timeout";
  }
}

// -------- Public boundary --------

/**
 * Run the OpenAI Codex device-code flow end-to-end.
 *
 * Returns ok({ access, refresh, expires }) on success, err({ code, message,
 * hint }) on failure. NEVER throws — internal helpers throw, the boundary
 * wraps everything in try/catch and pipes through rewriteOAuthError +
 * narrowToLoginError.
 */
export async function loginOpenAICodexDeviceCode(
  params: LoginOpenAICodexDeviceCodeOptions,
): Promise<Result<{ access: string; refresh: string; expires: number }, LoginError>> {
  const fetchFn = params.fetchFn ?? fetch;
  try {
    params.onProgress?.("Requesting device code…");
    const deviceCode = await requestOpenAICodexDeviceCode(fetchFn);

    await params.onVerification({
      verificationUrl: deviceCode.verificationUrl,
      userCode: deviceCode.userCode,
      expiresInMs: OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS,
    });

    params.onProgress?.("Waiting for device authorization…");
    const authorization = await pollOpenAICodexDeviceCode({
      fetchFn,
      deviceAuthId: deviceCode.deviceAuthId,
      userCode: deviceCode.userCode,
      intervalMs: deviceCode.intervalMs,
    });

    params.onProgress?.("Exchanging device code…");
    const creds = await exchangeOpenAICodexDeviceCode({
      fetchFn,
      authorizationCode: authorization.authorizationCode,
      codeVerifier: authorization.codeVerifier,
    });

    return ok(creds);
  } catch (caught) {
    const rewritten = rewriteOAuthError(caught);
    return err({
      code: narrowToLoginError(rewritten.code),
      message: rewritten.userMessage,
      hint: rewritten.hint,
    });
  }
}
