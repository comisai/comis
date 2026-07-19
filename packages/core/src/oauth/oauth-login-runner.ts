// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth login orchestrator for OpenAI Codex.
 *
 * Wraps loginOpenAICodexBrowser with VPS-aware handlers, manual-paste
 * fallback (15s delay + 1s grace), and error rewriting for
 * 2 user-friendly mappings (unsupported_region, callback_validation_failed)
 * + 1 identity-decode error path. Returns Result<LoginRunnerSuccess, LoginError>
 * — never throws at the public boundary.
 *
 * Both the CLI (`comis auth login`) and wizard step 04 OpenAI OAuth branch
 * import and call loginOpenAICodexOAuth — this is the single shared runner.
 *
 * openai-codex-browser-login.ts owns the protocol: PKCE generation, the
 * local callback server (hardcoded 127.0.0.1:1455), the token exchange POST
 * to https://auth.openai.com/oauth/token. This module owns the UX:
 * browser-open vs manual-paste, fallback timing, error mapping, identity
 * derivation via resolveCodexAuthIdentity.
 *
 * Logging discipline: submodule: "oauth-login" on every call.
 * NEVER log access tokens, refresh tokens, PKCE state, or callback `code`.
 * Identity in success logs uses redactEmailForLog (semi-redacted).
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { ComisLogger } from "../logging/log-fields.js";
import { loginOpenAICodexBrowser } from "./openai-codex-browser-login.js";
import {
  resolveCodexAuthIdentity,
  redactEmailForLog,
  rewriteOAuthError,
} from "../security/oauth-helpers.js";
import type { OAuthErrorCode } from "../security/oauth-helpers.js";
import {
  loginOpenAICodexDeviceCode,
  type DeviceCodeVerificationPrompt,
} from "./oauth-device-code.js";
import { systemNowMs, systemSetTimeout, systemClearTimeout } from "../runtime/system-time.js";

// ---------------------------------------------------------------------------
// Public types (boundary contract)
// ---------------------------------------------------------------------------

/**
 * Minimal prompter shape used by the runner. Defined locally — the runner
 * cannot import WizardPrompter from @comis/cli (cli depends on agent, not
 * the reverse — hexagonal architecture: core cannot depend on cli).
 *
 * Production: @comis/cli's WizardPrompter STRUCTURALLY satisfies this
 * (TypeScript structural typing); the CLI passes its WizardPrompter
 * instance directly. Test: build a small mock object with the required
 * methods.
 */
export interface RunnerPrompter {
  text(opts: {
    message: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  spinner(): {
    start(msg: string): void;
    update(msg: string): void;
    stop(msg: string): void;
  };
  log: {
    info(msg: string): void;
    warn(msg: string): void;
  };
}

/** Inputs to the public loginOpenAICodexOAuth function. */
export interface LoginRunnerParams {
  prompter: RunnerPrompter;
  isRemote: boolean;
  /**
   * Browser opener — typically `import open from "open"` from the consumer.
   * Stubbed in tests with a vi.fn that captures the URL. Returns
   * Promise<unknown> because the `open` package returns Promise<ChildProcess>
   * which the runner does not consume.
   */
  openUrl: (url: string) => Promise<unknown>;
  /** Optional logger — callers without one get a no-op fallback. */
  logger?: ComisLogger;
  /**
   * Login method. "browser" (default) uses loginOpenAICodexBrowser with
   * local-callback-server + manual-paste fallback; "device-code" uses the
   * OpenAI proprietary 3-step device-code flow (no clipboard, suitable for
   * SSH sessions). Only "openai-codex" supports "device-code"; the CLI
   * rejects other providers at parse time.
   */
  method?: "browser" | "device-code";
}

/** Error codes returned by the runner. */
export interface LoginError {
  code:
    | "unsupported_region"
    | "callback_validation_failed"
    | "callback_timeout"
    | "identity_decode_failed";
  message: string;
  hint: string;
}

/** Successful-login payload — caller persists this via OAuthCredentialStorePort. */
export interface LoginRunnerSuccess {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
  displayName?: string;
  /** Canonical "openai-codex:<email>" or "openai-codex:id-<base64url>" form. */
  profileId: string;
}

// ---------------------------------------------------------------------------
// Internal types + constants
// ---------------------------------------------------------------------------

const PROVIDER = "openai-codex" as const;

/**
 * Manual-paste fallback timing: after 15s the browser redirect is assumed
 * not to have completed and manual paste is offered; the 1s grace window
 * avoids racing a login that is just about to settle.
 */
const localManualFallbackDelayMs = 15_000;
const localManualFallbackGraceMs = 1_000;

interface OAuthPromptArg {
  message: string;
  placeholder?: string;
}

const validateRequiredInput = (value: string): string | undefined =>
  value.trim().length > 0 ? undefined : "Required";

// ---------------------------------------------------------------------------
// Internal: VPS-aware OAuth handlers — on a remote/headless host the browser
// cannot be opened locally, so the URL is printed for the operator's LOCAL
// browser and the redirect URL is collected via manual paste.
// ---------------------------------------------------------------------------

function createVpsAwareOAuthHandlers(params: {
  isRemote: boolean;
  prompter: RunnerPrompter;
  spin: ReturnType<RunnerPrompter["spinner"]>;
  openUrl: (url: string) => Promise<unknown>;
  localBrowserMessage: string;
  manualPromptMessage?: string;
}): {
  onAuth: (event: { url: string }) => Promise<void>;
  onPrompt: (prompt: OAuthPromptArg) => Promise<string>;
} {
  const manualPromptMessage =
    params.manualPromptMessage ?? "Paste the redirect URL";
  let manualCodePromise: Promise<string> | undefined;

  return {
    onAuth: async ({ url }) => {
      if (params.isRemote) {
        params.spin.stop("OAuth URL ready");
        // Use prompter.log.info, NOT prompter.note, mid-spinner (clack note
        // tears apart spinner display).
        params.prompter.log.info(
          `\nOpen this URL in your LOCAL browser:\n\n${url}\n`,
        );
        manualCodePromise = params.prompter.text({
          message: manualPromptMessage,
          validate: validateRequiredInput,
        });
        return;
      }
      params.spin.update(params.localBrowserMessage);
      await params.openUrl(url);
      params.prompter.log.info(`Open: ${url}`);
    },
    onPrompt: async (prompt) => {
      if (manualCodePromise) return manualCodePromise;
      return params.prompter.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        validate: validateRequiredInput,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: Manual-paste fallback race — resolves "delay" when the fallback
// timer fires before the login settles, "settled" when login wins the race.
// ---------------------------------------------------------------------------

function waitForDelayOrLoginSettle(params: {
  delayMs: number;
  waitForLoginToSettle: Promise<void>;
}): Promise<"delay" | "settled"> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (outcome: "delay" | "settled"): void => {
      if (finished) return;
      finished = true;
      systemClearTimeout(timeoutHandle);
      resolve(outcome);
    };
    const timeoutHandle = systemSetTimeout(() => finish("delay"), params.delayMs);
    params.waitForLoginToSettle.then(
      () => finish("settled"),
      () => finish("settled"),
    );
  });
}

function createNeverSettlingPromptResult(): Promise<string> {
  return new Promise<string>(() => undefined);
}

function createManualCodeInputHandler(params: {
  isRemote: boolean;
  onPrompt: (prompt: OAuthPromptArg) => Promise<string>;
  spin: ReturnType<RunnerPrompter["spinner"]>;
  waitForLoginToSettle: Promise<void>;
  hasBrowserAuthStarted: () => boolean;
}): (() => Promise<string>) | undefined {
  if (params.isRemote) {
    return async () =>
      params.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
  }
  return async () => {
    if (!params.hasBrowserAuthStarted()) {
      params.spin.update(
        "Local OAuth callback was unavailable. Paste the redirect URL to continue…",
      );
      return params.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
    }
    const outcome = await waitForDelayOrLoginSettle({
      delayMs: localManualFallbackDelayMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (outcome === "settled") return createNeverSettlingPromptResult();

    const settledDuringGraceWindow = await waitForDelayOrLoginSettle({
      delayMs: localManualFallbackGraceMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (settledDuringGraceWindow === "settled")
      return createNeverSettlingPromptResult();

    params.spin.update(
      "Browser callback did not finish. Paste the redirect URL to continue…",
    );
    return params.onPrompt({
      message: "Paste the authorization code (or full redirect URL):",
    });
  };
}

// ---------------------------------------------------------------------------
// Internal: Error rewriting — moved to ./oauth-errors.ts.
// The shared module exposes 6 cases (vs the 3 + default this runner originally
// shipped); the 2 new cases (invalid_grant, refresh_token_reused) only fire
// from the refresh path, never from interactive login. We narrow back to
// LoginError["code"] at the call sites via narrowToLoginError() below.
// ---------------------------------------------------------------------------

/**
 * Narrow a (broader) `OAuthErrorCode` back to the 4-case `LoginError["code"]`
 * union the runner promises at its public boundary. The login flow itself
 * cannot produce `invalid_grant` or `refresh_token_reused` (those are
 * refresh-only failures), but the shared classifier accepts both — coerce
 * defensively to the timeout default. Exhaustive `switch` ensures any future
 * `OAuthErrorCode` addition surfaces as a TypeScript compile error.
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
      // Login flow does not produce these (refresh-only failures); coerce.
      return "callback_timeout";
  }
}

// ---------------------------------------------------------------------------
// Public boundary
// ---------------------------------------------------------------------------

const NO_OP_LOGGER: ComisLogger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  audit: () => undefined,
  child: () => NO_OP_LOGGER,
} as unknown as ComisLogger;

/**
 * Shared identity-derivation + LoginRunnerSuccess builder used by both
 * the browser flow and the device-code flow. Extracted on the third
 * caller (rule-of-three: extracted on the third caller).
 *
 * Returns ok(success) on identity success; err(identity_decode_failed)
 * when neither email nor profileName can be derived from the JWT.
 *
 * NEVER logs the access/refresh values — only the resulting identity
 * (semi-redacted via redactEmailForLog) and durationMs.
 */
function deriveLoginRunnerSuccess(
  creds: { access: string; refresh: string; expires: number; accountId?: string },
  logger: ComisLogger,
): Result<LoginRunnerSuccess, LoginError> {
  const identity = resolveCodexAuthIdentity({ accessToken: creds.access });
  const identityKey = identity.email ?? identity.profileName;
  if (!identityKey) {
    const rewritten = rewriteOAuthError(
      new Error("Failed to extract accountId from token"),
    );
    logger.warn(
      {
        provider: PROVIDER,
        errorKind: "auth" as const,
        hint: rewritten.hint,
        submodule: "oauth-login",
      },
      "OAuth login failed — identity could not be derived",
    );
    return err({
      code: narrowToLoginError(rewritten.code),
      message: rewritten.userMessage,
      hint: rewritten.hint,
    });
  }
  const profileId = `${PROVIDER}:${identityKey}`;
  const success: LoginRunnerSuccess = {
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    accountId: creds.accountId,
    email: identity.email,
    displayName: identity.profileName,
    profileId,
  };
  return ok(success);
}

/**
 * Run the interactive OAuth login for OpenAI Codex.
 *
 * Returns ok({access, refresh, expires, accountId?, email?, displayName?,
 * profileId}) on success, err({code, message, hint}) on failure. NEVER
 * throws — the caller pattern-matches on result.ok.
 */
export async function loginOpenAICodexOAuth(
  params: LoginRunnerParams,
): Promise<Result<LoginRunnerSuccess, LoginError>> {
  const logger = params.logger ?? NO_OP_LOGGER;
  const startedAt = systemNowMs();

  // Device-code dispatch. Only "openai-codex" supports device-code today;
  // the CLI rejects other providers at parse time.
  if (params.method === "device-code") {
    return loginOpenAICodexDeviceCodeRunner(params, logger);
  }

  logger.info(
    { provider: PROVIDER, isRemote: params.isRemote, submodule: "oauth-login" },
    "OAuth login starting",
  );

  // Spinner lifecycle — start now; handlers update/stop it in their flow.
  const spin = params.prompter.spinner();
  spin.start(params.isRemote ? "Preparing OAuth URL..." : "Opening browser for OAuth...");

  // Track whether the browser-callback path actually opened — feeds the
  // manual-paste fallback's hasBrowserAuthStarted() check.
  let hasBrowserAuthStarted = false;
  let resolveLoginSettled: () => void;
  const waitForLoginToSettle = new Promise<void>((resolve) => {
    resolveLoginSettled = resolve;
  });

  const handlers = createVpsAwareOAuthHandlers({
    isRemote: params.isRemote,
    prompter: params.prompter,
    spin,
    openUrl: params.openUrl,
    localBrowserMessage: "Browser opened. Waiting for OAuth callback...",
  });

  // Wrap onAuth to flip hasBrowserAuthStarted in local mode.
  const onAuth = async (event: { url: string }): Promise<void> => {
    logger.debug(
      {
        submodule: "oauth-login",
        // Log URL but redact the state param.
        url: event.url.replace(/state=[^&]+/, "state=***"),
      },
      "OAuth authorize URL ready",
    );
    if (!params.isRemote) hasBrowserAuthStarted = true;
    return handlers.onAuth(event);
  };

  const onManualCodeInput = createManualCodeInputHandler({
    isRemote: params.isRemote,
    onPrompt: handlers.onPrompt,
    spin,
    waitForLoginToSettle,
    hasBrowserAuthStarted: () => hasBrowserAuthStarted,
  });

  try {
    const creds = await loginOpenAICodexBrowser({
      onAuth,
      onPrompt: handlers.onPrompt,
      onManualCodeInput,
      onProgress: (msg: string) => spin.update(msg),
    });

    // Identity derivation via shared helper (rule-of-three: browser, device-code,
    // device-code-on-failure all converge on this exact identity-derivation path).
    const successResult = deriveLoginRunnerSuccess(
      {
        access: creds.access,
        refresh: creds.refresh,
        expires: creds.expires,
        accountId: (creds as { accountId?: string }).accountId,
      },
      logger,
    );
    if (!successResult.ok) {
      spin.stop("OAuth login failed");
      resolveLoginSettled!();
      return successResult;
    }

    spin.stop("OAuth login complete");
    logger.info(
      {
        provider: PROVIDER,
        profileId: successResult.value.profileId,
        durationMs: systemNowMs() - startedAt,
        identity:
          redactEmailForLog(successResult.value.email) ??
          successResult.value.displayName ??
          `id-${(creds as { accountId?: string }).accountId ?? "<unknown>"}`,
        submodule: "oauth-login",
      },
      "OAuth login complete",
    );
    resolveLoginSettled!();
    return successResult;
  } catch (caught) {
    spin.stop("OAuth login failed");
    const rewritten = rewriteOAuthError(caught);
    logger.warn(
      {
        provider: PROVIDER,
        errorKind: "auth" as const,
        hint: rewritten.hint,
        err: caught,
        submodule: "oauth-login",
      },
      "OAuth login failed",
    );
    resolveLoginSettled!();
    return err({
      code: narrowToLoginError(rewritten.code),
      message: rewritten.userMessage,
      hint: rewritten.hint,
    });
  }
}

/**
 * Device-code login runner.
 *
 * Wraps loginOpenAICodexDeviceCode in the LoginRunnerSuccess shape so
 * the CLI/wizard can pattern-match on the same result type regardless
 * of method. Owns the spinner UX: start, transition on verification
 * prompt, restart for polling, stop on completion.
 *
 * NEVER logs or surfaces tokens, userCode, or verifier values. Identity
 * derivation reuses the shared deriveLoginRunnerSuccess helper.
 */
async function loginOpenAICodexDeviceCodeRunner(
  params: LoginRunnerParams,
  logger: ComisLogger,
): Promise<Result<LoginRunnerSuccess, LoginError>> {
  const startedAt = systemNowMs();
  logger.info(
    {
      provider: PROVIDER,
      isRemote: params.isRemote,
      method: "device-code",
      submodule: "oauth-login",
    },
    "Device-code OAuth login starting",
  );

  const spin = params.prompter.spinner();
  spin.start("Requesting device code…");

  const result = await loginOpenAICodexDeviceCode({
    onVerification: (prompt: DeviceCodeVerificationPrompt) => {
      spin.stop("Device code ready");
      params.prompter.log.info(
        "\nOpen this URL on any device (your phone, another desktop, etc.):\n\n" +
          `  ${prompt.verificationUrl}\n\n` +
          `Enter the code: ${prompt.userCode}\n\n` +
          "(this code expires in 15 minutes)\n",
      );
      spin.start("Waiting for authorization (polling every 5s)…");
    },
    onProgress: (msg: string) => {
      spin.update(msg);
    },
  });

  if (!result.ok) {
    spin.stop("OAuth login failed");
    logger.warn(
      {
        provider: PROVIDER,
        errorKind: "auth" as const,
        hint: result.error.hint,
        submodule: "oauth-login",
      },
      "Device-code login failed",
    );
    return err(result.error);
  }

  const successResult = deriveLoginRunnerSuccess(result.value, logger);
  if (!successResult.ok) {
    spin.stop("OAuth login failed");
    return successResult;
  }

  spin.stop("OAuth login complete");
  logger.info(
    {
      provider: PROVIDER,
      profileId: successResult.value.profileId,
      durationMs: systemNowMs() - startedAt,
      identity:
        redactEmailForLog(successResult.value.email) ??
        successResult.value.displayName ??
        "id-unknown",
      submodule: "oauth-login",
    },
    "Device-code login complete",
  );
  return successResult;
}
