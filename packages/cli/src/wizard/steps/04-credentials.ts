// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).
/**
 * Credentials entry step -- step 04 of the init wizard.
 *
 * Collects API credentials for the provider selected in step 03.
 * Three branches handle different provider types:
 *
 * - **Ollama**: no key needed, skip straight through
 * - **Custom endpoint**: collect base URL, compat mode, optional key, model ID
 * - **Standard provider**: show help URL, format pre-check, live API validation,
 *   retry/continue-anyway/skip recovery on failure
 *
 * Live validation uses a lightweight GET /models request with a 5-second
 * timeout. Network failures warn but allow proceeding (air-gapped scenario).
 *
 * @module
 */

import type {
  WizardState,
  WizardStep,
  ProviderConfig,
  AuthMethod,
} from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { sectionSeparator, info } from "../theme.js";
import { validateApiKey, getKeyPrefix } from "../validators/api-key.js";
import { getModels, type KnownProvider } from "@earendil-works/pi-ai";

// ---- OAuth interactive-flow imports ----
// CLI cannot import from packages/daemon (dep-direction); the OAuth
// runner + selector + remote-env detector live in @comis/agent
// (selectOAuthCredentialStore lives there). The browser opener is the
// `open` package (exact-pinned in @comis/cli per CLAUDE.md
// supply-chain invariants).
import open from "open";
import { // All symbol groups below live in @comis/core; the CLI does not
  // route through @comis/agent for these.
  isRemoteEnvironment, loginOpenAICodexOAuth, systemClearTimeout, systemEnvSnapshot, systemSetTimeout } from "@comis/core";
import {
  redactEmailForLog,
  // createConsoleLogger is the Pino-free replacement for @comis/infra's
  // createLogger. CLI does not import from @comis/infra.
  createConsoleLogger,
  AuthSetContract,
  safePath,
  type OAuthCredentialStorePort,
  type OAuthProfile,
} from "@comis/core";
import { homedir } from "node:os";
import { callTyped, withClient, isGatewayAuthRejection } from "../../client/rpc-client.js";
import { DAEMON_PROBE_TIMEOUT_MS } from "../../util/daemon-required.js";
import { isDaemonRunning } from "../../sync-tooling/daemon-guard.js";
import { offlineOAuthProfileSet } from "../../util/offline-secrets-store.js";
import {
  loadWizardStorageMode,
  openWizardOAuthStore,
} from "./04-oauth-helpers.js";

// ---------- Provider Help URLs ----------

const PROVIDER_HELP_URLS: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/apikey",
  groq: "https://console.groq.com/keys",
  mistral: "https://console.mistral.ai/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  xai: "https://console.x.ai",
  together: "https://api.together.xyz/settings/api-keys",
  cerebras: "https://cloud.cerebras.ai/account",
  openrouter: "https://openrouter.ai/settings/keys",
};

// ---------- Auth Method Options ----------

/**
 * Providers that offer an OAuth token alternative to API keys.
 *
 * openai is API-key-only -- OAuth lives exclusively on the separate
 * `openai-codex` provider id (which has its own dedicated branch with
 * a method picker). Only anthropic remains here.
 */
const AUTH_METHOD_PROVIDERS: Record<
  string,
  {
    options: { value: AuthMethod; label: string; hint: string }[];
    helpUrls: Record<AuthMethod, string | null>;
    helpNotes: Record<AuthMethod, string | null>;
  }
> = {
  anthropic: {
    options: [
      { value: "apikey", label: "API Key", hint: "sk-ant-api03-..." },
      { value: "oauth", label: "OAuth Token", hint: "From 'claude setup-token'" },
    ],
    helpUrls: {
      apikey: "https://console.anthropic.com/settings/keys",
      oauth: null,
    },
    helpNotes: {
      apikey: null,
      oauth: "Generate with: claude setup-token",
    },
  },
};

// ---------- Provider Validation Endpoints ----------

/**
 * Path suffixes per provider, RELATIVE to the pi-ai catalog baseUrl.
 *
 * Pi-ai's catalog baseUrl shape is NOT uniform across providers:
 *   - HOST-ONLY for anthropic ("https://api.anthropic.com"), mistral, deepseek
 *     -> path here must include the version prefix ("/v1/models").
 *   - PREFIXED with the version segment for openai ("https://api.openai.com/v1"),
 *     google ("/v1beta"), groq ("/openai/v1"), xai ("/v1"), cerebras ("/v1"),
 *     openrouter ("/api/v1") -> path here must NOT repeat the version segment;
 *     append "/models" only.
 *
 * Composing entry.baseUrl + entry.path therefore produces the canonical /models
 * endpoint for each provider (e.g., https://api.openai.com/v1/models,
 * https://generativelanguage.googleapis.com/v1beta/models,
 * https://api.groq.com/openai/v1/models).
 *
 * Drift risk: if pi-ai upgrades a provider's baseUrl AND its path convention
 * changes, this table must be updated. Acceptable trade-off -- explicit
 * beats clever (auto-detection of duplicated path segments could mask
 * legitimate future shape changes).
 *
 * Excluded: `together` and `ollama` are NOT in pi-ai 0.71.0's catalog
 * (`getModels(p)[0]?.baseUrl` returns undefined for both). The line-130
 * fallback (`if (!entry) return { valid: true };`) handles them by
 * skipping live validation entirely. Live validation against
 * api.together.xyz is skipped; users can still target Together via the
 * synthetic `custom` endpoint route.
 */
const PROVIDER_VALIDATION_PATHS: Record<string, string> = {
  // Catalog baseUrl is HOST-ONLY for these providers -> path needs the /v1 prefix.
  anthropic: "/v1/models",
  mistral:   "/v1/models",
  deepseek:  "/v1/models",
  // Catalog baseUrl ALREADY INCLUDES the version prefix for these providers
  // (e.g., openai's baseUrl is "https://api.openai.com/v1", openrouter's is
  // "https://openrouter.ai/api/v1") -- append /models only.
  openai:     "/models",
  google:     "/models",
  groq:       "/models",
  xai:        "/models",
  cerebras:   "/models",
  openrouter: "/models",
};

/**
 * Resolve the validation endpoint for a provider by reading the catalog
 * baseUrl from pi-ai (precedent: builtin-provider-guard.ts:45) and
 * combining it with a known path from PROVIDER_VALIDATION_PATHS.
 *
 * Returns `undefined` for providers not in the catalog (or providers
 * with no models, e.g., ollama with no remote endpoint) -- callers
 * skip live validation in that case.
 */
function getValidationEndpoint(
  provider: string,
): { baseUrl: string; path: string } | undefined {
  const baseUrl = getModels(provider as KnownProvider)[0]?.baseUrl;
  if (!baseUrl) return undefined;
  // eslint-disable-next-line security/detect-object-injection -- read of static const map indexed by validated provider string
  const path = PROVIDER_VALIDATION_PATHS[provider] ?? "/v1/models";
  return { baseUrl, path };
}

// ---------- Live Validation ----------

/**
 * Validate an API key against the provider's /models endpoint.
 *
 * Returns { valid: true } on HTTP 200, or a descriptive error
 * on auth failures, HTTP errors, and network/timeout errors.
 * Unknown providers skip validation (return valid).
 *
 * @param authMethod - When "oauth", forces Bearer auth for Anthropic
 */
async function validateKeyLive(
  provider: string,
  apiKey: string,
  authMethod?: AuthMethod,
): Promise<{ valid: boolean; error?: string }> {
  // OAuth tokens cannot be validated against /models endpoints --
  // Anthropic's /v1/models rejects OAuth Bearer tokens with 401.
  // Skip live validation and trust the format check.
  if (authMethod === "oauth") {
    return { valid: true };
  }

  const entry = getValidationEndpoint(provider);
  if (!entry) {
    return { valid: true };
  }

  let url = `${entry.baseUrl}${entry.path}`;
  const headers: Record<string, string> = {};

  // Provider-specific auth header schemes
  if (provider === "anthropic") {
    // OAuth tokens (sk-ant-oat01-*) use Bearer auth; regular keys use x-api-key
    if (apiKey.startsWith("sk-ant-oat01-")) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else {
      headers["x-api-key"] = apiKey;
    }
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider === "google") {
    url += `?key=${apiKey}`;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // 5-second timeout
  const controller = new AbortController();
  const timeout = systemSetTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: `Invalid API key (${response.status})` };
    }

    return { valid: false, error: `API returned ${response.status}` };
  } catch {
    return { valid: false, error: "Could not reach provider (network error or timeout)" };
  } finally {
    systemClearTimeout(timeout);
  }
}

// ---------- Branch Handlers ----------

/**
 * Branch A: Ollama -- no API key needed.
 */
async function handleOllama(
  state: WizardState,
  prompter: WizardPrompter,
): Promise<WizardState> {
  prompter.log.info("Ollama runs locally -- no API key needed.");
  return updateState(state, {
    provider: { ...state.provider!, validated: true },
  });
}

/**
 * Branch B: Custom endpoint -- collect base URL, compat mode, optional key, model ID.
 */
async function handleCustomEndpoint(
  state: WizardState,
  prompter: WizardPrompter,
): Promise<WizardState> {
  const baseUrl = await prompter.text({
    message: "Custom API base URL",
    placeholder: "https://my-llm.internal/v1",
    validate: (v: string) => {
      if (typeof v !== "string") return undefined;
      const trimmed = v.trim();
      if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        return "URL must start with http:// or https://";
      }
      return undefined;
    },
  });

  const compatMode = await prompter.select<"openai" | "anthropic">({
    message: "Compatibility mode",
    options: [
      { value: "openai" as const, label: "OpenAI-compatible" },
      { value: "anthropic" as const, label: "Anthropic-compatible" },
    ],
  });

  const key = await prompter.password({
    message: "API key (leave blank if none required)",
  });

  const modelId = await prompter.text({
    message: "Model ID",
    placeholder: "my-model-v2",
    validate: (v: string) => {
      if (typeof v !== "string") return undefined;
      if (!v.trim()) return "Model ID is required.";
      return undefined;
    },
  });

  return updateState(state, {
    provider: {
      id: "custom",
      customEndpoint: baseUrl.trim(),
      compatMode,
      apiKey: key || undefined,
      validated: true,
    } as ProviderConfig,
    model: modelId.trim(),
  });
}

/**
 * Branch C: Standard provider -- help URL, format pre-check, live validation, retry loop.
 *
 * Accepts an optional `preResolvedAuthMethod` parameter so the
 * dispatcher (credentialsStep.execute) can hoist the auth-method select
 * BEFORE deciding which branch handler to run. When set, the internal
 * select is skipped — preventing a double-prompt for AUTH_METHOD_PROVIDERS
 * entries. When undefined, the internal select runs.
 */
async function handleStandardProvider(
  state: WizardState,
  prompter: WizardPrompter,
  providerId: string,
  preResolvedAuthMethod?: AuthMethod,
): Promise<WizardState> {
  // Auth method selection for providers that support OAuth
  let authMethod: AuthMethod | undefined = preResolvedAuthMethod;
  const authConfig = AUTH_METHOD_PROVIDERS[providerId];

  if (authConfig && authMethod === undefined) {
    authMethod = await prompter.select<AuthMethod>({
      message: `${providerId} authentication method`,
      options: authConfig.options,
    });
  }

  if (authConfig) {
    // Show help URL or note based on auth method
    const helpUrl = authConfig.helpUrls[authMethod!];
    const helpNote = authConfig.helpNotes[authMethod!];
    if (helpUrl) {
      prompter.note(info(`Get your API key at: ${helpUrl}`), `${providerId} API Key`);
    } else if (helpNote) {
      prompter.note(info(helpNote), `${providerId} OAuth Token`);
    }
  } else {
    // Non-OAuth providers: show standard help URL
    const helpUrl = PROVIDER_HELP_URLS[providerId];
    if (helpUrl) {
      prompter.note(info(`Get your API key at: ${helpUrl}`), `${providerId} API Key`);
    }
  }

  // Show key prefix hint (only for API key auth or non-OAuth providers)
  if (authMethod !== "oauth") {
    const prefix = getKeyPrefix(providerId);
    if (prefix) {
      prompter.log.info(`Key format: ${prefix}...`);
    }
  }

  const credLabel = authMethod === "oauth" ? "OAuth token" : "API key";
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Collect credential with format pre-check (skipped for OAuth)
    const key = await prompter.password({
      message: `${providerId} ${credLabel}`,
      validate: (v: string) => {
        if (typeof v !== "string") return undefined;
        const result = validateApiKey(providerId, v, authMethod);
        return result ? result.message : undefined;
      },
    });

    // Live validation with spinner
    const spin = prompter.spinner();
    spin.start(`Validating ${credLabel}...`);
    const result = await validateKeyLive(providerId, key, authMethod);

    if (result.valid) {
      spin.stop(`${authMethod === "oauth" ? "OAuth token accepted" : "API key validated"}`);
      return updateState(state, {
        provider: {
          id: providerId,
          apiKey: key,
          authMethod,
          validated: true,
        } as ProviderConfig,
      });
    }

    // Validation failed
    spin.stop("Validation failed");
    prompter.log.warn(result.error ?? "Unknown validation error");

    // Build recovery options -- retry only available if attempts remain
    const isLastAttempt = attempt === maxRetries;
    const recoveryOptions = isLastAttempt
      ? [
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip provider setup" },
        ]
      : [
          { value: "retry" as const, label: "Try again" },
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip provider setup" },
        ];

    const choice = await prompter.select<"retry" | "continue" | "skip">({
      message: "What would you like to do?",
      options: recoveryOptions,
    });

    if (choice === "continue") {
      return updateState(state, {
        provider: {
          id: providerId,
          apiKey: key,
          authMethod,
          validated: false,
        } as ProviderConfig,
      });
    }

    if (choice === "skip") {
      return state;
    }

    // choice === "retry" -- continue loop
  }

  // Should not reach here (last attempt forces continue/skip above),
  // but handle gracefully
  return state;
}

// ---------- Branch D: openai-codex OAuth ----------

// `warn` (not `info`): interactive wizard shares the TTY with the @clack UI;
// info/debug JSON would interleave with prompts. Progress uses prompter.log.*.
const wizardLogger = createConsoleLogger("warn", { name: "wizard-oauth" });

/**
 * Branch D: openai-codex OAuth — interactive method picker + runner dispatch.
 *
 * Surfaces the runner's three login methods (browser auto-open, browser
 * manual paste, device-code) plus a "skip for now" escape hatch. OAuth
 * lives on its own provider id so the openai (API-key) flow is
 * straight-through.
 *
 * On runner success: writes the profile to the OAuth store AND updates
 * wizard state with apiKey + oauthProfileId + validated=true. The matching
 * `oauthProfiles` config emission in step 10 wires the daemon to resolve
 * this identity for openai-codex calls.
 *
 * On "skip for now": leaves the wizard advancing with provider.id set but
 * validated=false; logs the literal hint pointing to `comis auth login`.
 */
async function handleCodexOAuth(
  state: WizardState,
  prompter: WizardPrompter,
): Promise<WizardState> {
  const isRemoteDefault = isRemoteEnvironment({ env: systemEnvSnapshot() });
  const maxRetries = 3;

  // Resolve storage mode FIRST so env/encrypted branches return early without
  // opening a store. state.storageMode (set by step 02b) takes precedence: on a
  // fresh init the key was just provisioned but loadWizardStorageMode's env
  // snapshot may not reflect it, so encrypted must not fall back to file.
  const wizardStorage = state.storageMode ?? await loadWizardStorageMode();

  if (wizardStorage === "env") {
    // Env is read-only — credentials come from environment variables.
    // OAuth login cannot persist a profile in this mode.
    prompter.log.error(
      "OAuth login is not supported in 'env' storage mode (read-only). " +
        "Set security.storage to 'file' or 'encrypted' in config.yaml to enable OAuth login.",
    );
    return state;
  }

  // Inline helpNote -- AUTH_METHOD_PROVIDERS no longer has an openai entry,
  // so we cannot pull the note from the map. Keep the wording user-facing
  // and explicit about what the picker will do.
  prompter.note(
    info(
      "OpenAI Codex uses your ChatGPT/Codex subscription -- no API key needed. Choose how you want to sign in.",
    ),
    "openai-codex OAuth",
  );

  // Method picker -- four options, with isRemoteDefault driving the default.
  type MethodChoice = "browser-auto" | "browser-manual" | "device-code" | "skip";
  const methodChoice = await prompter.select<MethodChoice>({
    message: "How do you want to sign in?",
    options: [
      { value: "browser-auto", label: "Browser (auto-open)", hint: "Local desktop, opens default browser" },
      { value: "browser-manual", label: "Browser (manual paste)", hint: "VPS, you paste callback URL after sign-in" },
      { value: "device-code", label: "Device code (phone)", hint: "SSH/headless, type a short code on a phone" },
      { value: "skip", label: "Skip for now", hint: "finish wizard, run `comis auth login` later" },
    ],
    initialValue: isRemoteDefault ? "device-code" : "browser-auto",
  });

  if (methodChoice === "skip") {
    prompter.log.info(
      "Skipped OAuth -- run `comis auth login --provider openai-codex` before starting the daemon.",
    );
    return updateState(state, {
      provider: { id: "openai-codex", validated: false } as ProviderConfig,
    });
  }

  // Compute runner params from the method choice. The runner ignores
  // isRemote when method === "device-code" but we still pass the detected
  // value for log fidelity. browser-manual forces isRemote=true so the
  // manual-paste handlers run regardless of detection.
  let method: "browser" | "device-code";
  let isRemote: boolean;
  switch (methodChoice) {
    case "browser-auto":
      method = "browser";
      isRemote = false;
      break;
    case "browser-manual":
      method = "browser";
      isRemote = true;
      break;
    case "device-code":
      method = "device-code";
      isRemote = isRemoteDefault;
      break;
  }

  // Encrypted mode: probe the daemon BEFORE the OAuth flow so the persistence
  // route (daemon RPC vs. offline encrypted write) is decided up front. When
  // the daemon is down we seal the profile directly into secrets.db via
  // offlineOAuthProfileSet. When the daemon IS running it is normally the sole
  // writer, so we route through the auth.set RPC (single-writer invariant) —
  // BUT on a fresh install the installer's systemd unit starts the daemon
  // before `comis init` has written any config.yaml, so the gateway has zero
  // configured tokens and rejects the CLI's connection (WS close 4001). In that
  // case the RPC is unreachable and we fall back to the same offline encrypted
  // write (see the auth-rejection branch below).
  if (wizardStorage === "encrypted") {
    const daemonUp = await isDaemonRunning(DAEMON_PROBE_TIMEOUT_MS);
    // Seal an OAuth profile straight into the encrypted secrets.db (no daemon).
    // Returns true on success; logs the failure and returns false otherwise.
    // Shared by the daemon-down branch and the daemon-up-but-auth-rejected
    // fallback so both produce an identical encrypted-at-rest write.
    const sealOAuthProfileOffline = async (
      oauthProfile: OAuthProfile,
    ): Promise<boolean> => {
      const res = await offlineOAuthProfileSet({
        profile: oauthProfile,
        dataDir: safePath(homedir(), ".comis"),
        envFilePath: safePath(homedir(), ".comis", ".env"),
      });
      if (!res.ok) {
        prompter.log.error(
          `Failed to persist OAuth profile: ${res.error.message}`,
        );
        return false;
      }
      return true;
    };
    // Run the OAuth flow locally (browser/device-code — user's interactive
    // machine).
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await loginOpenAICodexOAuth({
        prompter,
        isRemote,
        openUrl: open,
        logger: wizardLogger,
        method,
      });

      if (result.ok) {
        const v = result.value;
        const profile: OAuthProfile = {
          provider: "openai-codex",
          profileId: v.profileId,
          access: v.access,
          refresh: v.refresh,
          expires: v.expires,
          accountId: v.accountId,
          email: v.email,
          displayName: v.displayName,
          version: 1,
        };

        if (daemonUp) {
          // Daemon is the sole writer when running → persist via auth.set RPC.
          try {
            await withClient((client) =>
              callTyped(client, AuthSetContract, profile),
            );
          } catch (rpcErr) {
            if (isGatewayAuthRejection(rpcErr)) {
              // The gateway rejected our token (WS close 4001): the daemon is
              // up but has no gateway.tokens entry the CLI can match — the
              // fresh-install case where the installer started the service
              // before `comis init` wrote any config. The auth.set RPC is
              // permanently unreachable here, so route around it and seal the
              // profile straight into the encrypted secrets.db, then tell the
              // user to restart the daemon (encrypted-store hot-reload is
              // disabled, so a restart is required for any credential change
              // to take effect regardless of the write path).
              if (!(await sealOAuthProfileOffline(profile))) {
                if (attempt === maxRetries) return state;
                continue;
              }
              prompter.log.warn(
                "Daemon is running but rejected the CLI's gateway token (no gateway.tokens entry matched). " +
                  "Sealed the OAuth profile into the encrypted secrets store directly — " +
                  "restart the daemon (e.g. `sudo systemctl restart comis`) for it to take effect.",
              );
            } else {
              prompter.log.error(
                `Failed to persist OAuth profile via daemon: ${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)}`,
              );
              if (attempt === maxRetries) return state;
              continue;
            }
          }
        } else {
          // Daemon down (e.g. during `comis init`) → seal the profile directly
          // into the encrypted secrets.db. NEVER touches the plaintext file store.
          if (!(await sealOAuthProfileOffline(profile))) {
            if (attempt === maxRetries) return state;
            continue;
          }
        }

        wizardLogger.info(
          {
            provider: "openai-codex",
            profileId: v.profileId,
            identity:
              redactEmailForLog(v.email) ?? `id-${v.accountId ?? "<unknown>"}`,
            action: "wizard-login",
            submodule: "wizard-oauth",
          },
          "OAuth profile stored (encrypted)",
        );

        prompter.log.info(
          "OAuth profile stored. Restart or reload the daemon before the new credential takes effect.",
        );

        // Do NOT store v.access as apiKey in wizard state for
        // encrypted mode. The token is already persisted by the daemon
        // via the auth.set RPC above. Setting apiKey here would keep a
        // live bearer token in WizardState.provider for the remainder of
        // the wizard session, creating a fragile residency guarantee that
        // depends on openai-codex staying absent from PROVIDER_ENV_KEYS.
        return updateState(state, {
          provider: {
            id: "openai-codex",
            authMethod: "oauth",
            oauthProfileId: v.profileId,
            validated: true,
          } as ProviderConfig,
        });
      }

      // Failure path -- surface the rewritten error + recovery options.
      prompter.log.warn(result.error.message);
      if (result.error.hint) prompter.log.info(result.error.hint);

      const isLastAttempt = attempt === maxRetries;
      const recoveryOptions = isLastAttempt
        ? [{ value: "skip" as const, label: "Skip provider setup" }]
        : [
            { value: "retry" as const, label: "Try again" },
            { value: "skip" as const, label: "Skip provider setup" },
          ];

      const choice = await prompter.select<"retry" | "skip">({
        message: "What would you like to do?",
        options: recoveryOptions,
      });
      if (choice === "skip") return state;
      // choice === "retry" -> continue loop
    }

    return state;
  }

  // File mode: open the store adapter and write directly.
  let store: OAuthCredentialStorePort;
  try {
    store = await openWizardOAuthStore();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    prompter.log.error(msg);
    return state;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await loginOpenAICodexOAuth({
      prompter,
      isRemote,
      openUrl: open,
      logger: wizardLogger,
      method,
    });

    if (result.ok) {
      const v = result.value;
      const profile: OAuthProfile = {
        provider: "openai-codex",
        profileId: v.profileId,
        access: v.access,
        refresh: v.refresh,
        expires: v.expires,
        accountId: v.accountId,
        email: v.email,
        displayName: v.displayName,
        version: 1,
      };
      const writeResult = await store.set(v.profileId, profile);
      if (!writeResult.ok) {
        prompter.log.error(
          `Failed to persist OAuth profile: ${writeResult.error.message}`,
        );
        if (attempt === maxRetries) return state;
        continue;
      }

      wizardLogger.info(
        {
          provider: "openai-codex",
          profileId: v.profileId,
          identity:
            redactEmailForLog(v.email) ?? `id-${v.accountId ?? "<unknown>"}`,
          action: "wizard-login",
          submodule: "wizard-oauth",
        },
        "OAuth profile written by wizard",
      );

      return updateState(state, {
        provider: {
          id: "openai-codex",
          authMethod: "oauth",
          apiKey: v.access,
          oauthProfileId: v.profileId,
          validated: true,
        } as ProviderConfig,
      });
    }

    // Failure path -- surface the rewritten error + recovery options.
    prompter.log.warn(result.error.message);
    if (result.error.hint) prompter.log.info(result.error.hint);

    const isLastAttempt = attempt === maxRetries;
    const recoveryOptions = isLastAttempt
      ? [{ value: "skip" as const, label: "Skip provider setup" }]
      : [
          { value: "retry" as const, label: "Try again" },
          { value: "skip" as const, label: "Skip provider setup" },
        ];

    const choice = await prompter.select<"retry" | "skip">({
      message: "What would you like to do?",
      options: recoveryOptions,
    });
    if (choice === "skip") return state;
    // choice === "retry" -> continue loop
  }

  return state;
}

// ---------- Step Implementation ----------

export const credentialsStep: WizardStep = {
  id: "credentials",
  label: "API Credentials",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("API Credentials"));

    const providerId = state.provider?.id;

    if (!providerId) {
      prompter.log.warn("No provider selected. Skipping credentials step.");
      return state;
    }

    // Branch A: Ollama (no key needed)
    if (providerId === "ollama") {
      return handleOllama(state, prompter);
    }

    // Branch B: Custom endpoint
    if (providerId === "custom") {
      return handleCustomEndpoint(state, prompter);
    }

    // Branch D: openai-codex OAuth -- dedicated method picker
    // dispatching to loginOpenAICodexOAuth. Kept ABOVE the auth-method
    // hoist so openai-codex never sees the apikey/oauth select prompt.
    if (providerId === "openai-codex") {
      return handleCodexOAuth(state, prompter);
    }

    // Hoisted auth-method select runs UP FRONT for providers in
    // AUTH_METHOD_PROVIDERS so the dispatcher can branch on the chosen
    // method before handleStandardProvider runs. Only anthropic remains
    // in the map -- openai is API-key-only.
    let authMethod: AuthMethod | undefined;
    // eslint-disable-next-line security/detect-object-injection -- read of static const map indexed by validated provider string
    const authConfig = AUTH_METHOD_PROVIDERS[providerId];
    if (authConfig) {
      authMethod = await prompter.select<AuthMethod>({
        message: `${providerId} authentication method`,
        options: authConfig.options,
      });
    }

    // Branch C: Standard provider -- pass the hoisted authMethod so the
    // handler doesn't double-prompt. Anthropic OAuth still flows through
    // here for the existing claude setup-token paste path.
    return handleStandardProvider(state, prompter, providerId, authMethod);
  },
};
