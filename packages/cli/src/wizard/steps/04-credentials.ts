// SPDX-License-Identifier: Apache-2.0
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
  WizardPrompter,
  ProviderConfig,
  AuthMethod,
} from "../index.js";
import {
  updateState,
  sectionSeparator,
  info,
  validateApiKey,
  getKeyPrefix,
} from "../index.js";
import { getModels, type KnownProvider } from "@mariozechner/pi-ai";

// ---- Phase 8 (D-03) OAuth interactive-flow imports ----
// CLI cannot import from packages/daemon (dep-direction); the OAuth
// runner + selector + remote-env detector live in @comis/agent (Phase 8
// plan 01 moved selectOAuthCredentialStore there). The browser opener is
// the `open` package (exact-pinned in @comis/cli per CLAUDE.md
// supply-chain invariants).
import { homedir } from "node:os";
import open from "open";
import {
  loginOpenAICodexOAuth,
  isRemoteEnvironment,
  selectOAuthCredentialStore,
  redactEmailForLog,
} from "@comis/agent";
import {
  loadConfigFile,
  validateConfig,
  safePath,
  type OAuthCredentialStorePort,
  type OAuthProfile,
} from "@comis/core";
import { createLogger } from "@comis/infra";

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

/** Providers that offer an OAuth token alternative to API keys. */
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
  openai: {
    options: [
      { value: "apikey", label: "API Key", hint: "sk-..." },
      { value: "oauth", label: "OAuth (interactive)", hint: "Opens browser or accepts manual paste" },
    ],
    helpUrls: {
      apikey: "https://platform.openai.com/api-keys",
      oauth: null,
    },
    helpNotes: {
      apikey: null,
      oauth: "Interactive OAuth flow with ChatGPT — your browser will open (or you'll paste the URL on a remote host).",
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
 * Follow-up to 260501-kqq Sub-Fix C: that migration replaced the static
 * PROVIDER_VALIDATION map (which had host-only baseUrls + correct /v1/models
 * suffixes) with the catalog-driven `getValidationEndpoint` helper, but the
 * path-table values were copied verbatim -- producing double-prefixed URLs
 * (e.g., https://api.openai.com/v1/v1/models -> 404) for the 6 providers
 * whose catalog baseUrl includes the version segment. 260501-mvw corrects
 * the table; the helper itself is unchanged.
 *
 * Drift risk: if pi-ai upgrades a provider's baseUrl AND its path convention
 * changes, this table must be updated. Acceptable trade-off -- explicit
 * beats clever (auto-detection of duplicated path segments could mask
 * legitimate future shape changes).
 *
 * Excluded: `together` and `ollama` are NOT in pi-ai 0.71.0's catalog
 * (`getModels(p)[0]?.baseUrl` returns undefined for both). The line-130
 * fallback (`if (!entry) return { valid: true };`) handles them by
 * skipping live validation entirely. For `together` this is a deliberate
 * behavior change vs the pre-260501-kqq state -- live validation against
 * api.together.xyz is now skipped. Users can still target Together via
 * the synthetic `custom` endpoint route.
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
 * baseUrl from pi-ai (260501-gyy precedent: builtin-provider-guard.ts:45)
 * and combining it with a known path from PROVIDER_VALIDATION_PATHS.
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
  const timeout = setTimeout(() => controller.abort(), 5000);

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
    clearTimeout(timeout);
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
 * Phase 8 D-03: accepts an optional `preResolvedAuthMethod` parameter so the
 * dispatcher (credentialsStep.execute) can hoist the auth-method select
 * BEFORE deciding which branch handler to run. When set, the internal
 * select is skipped — preventing a double-prompt for AUTH_METHOD_PROVIDERS
 * entries (anthropic + openai). When undefined, behavior matches the
 * pre-Phase-8 path (the internal select runs as before).
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

// ---------- Branch D: OpenAI OAuth (Phase 8 D-03) ----------

const wizardLogger = createLogger({ name: "wizard-oauth" });

/**
 * Open the OAuth credential store from the current config (mirrors the
 * helper plan 03 will install in `auth.ts`). Defaults to file storage when
 * config is absent or doesn't set `oauth.storage`. Encrypted-mode CLI
 * wiring requires SECRETS_MASTER_KEY + secretsDb — if `storage='encrypted'`,
 * the wizard surfaces a fail-fast error (operator can switch to file mode
 * for the wizard, then back to encrypted after).
 */
async function openWizardOAuthStore(): Promise<OAuthCredentialStorePort> {
  const dataDir = safePath(homedir(), ".comis");
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager (matches doctor.ts:45 / health.ts:43 precedent)
  const envPaths = process.env["COMIS_CONFIG_PATHS"];
  const configPath = envPaths?.split(":")[0] ??
    safePath(homedir(), ".comis", "config.yaml");
  const loadResult = loadConfigFile(configPath);
  if (!loadResult.ok) {
    return selectOAuthCredentialStore({ storage: "file", dataDir });
  }
  const validated = validateConfig(loadResult.value);
  if (!validated.ok) {
    return selectOAuthCredentialStore({ storage: "file", dataDir });
  }
  const storage = validated.value.oauth?.storage ?? "file";
  if (storage === "encrypted") {
    throw new Error(
      "OAuth storage mode is 'encrypted' but the wizard cannot bootstrap the encrypted store. " +
        "Hint: set appConfig.oauth.storage to 'file' temporarily for the wizard, or run " +
        "`comis auth login --provider openai-codex` from a shell where SECRETS_MASTER_KEY is exported.",
    );
  }
  return selectOAuthCredentialStore({ storage: "file", dataDir });
}

/**
 * Branch D: OpenAI OAuth — interactive flow via @comis/agent's
 * loginOpenAICodexOAuth (D-03 inline placement). REPLACES the pre-Phase-8
 * pre-generated-token paste path. Mirrors handleStandardProvider's 3-attempt
 * retry-loop pattern per RESEARCH §Open Q4.
 *
 * On success: writes the profile to the OAuth store AND updates wizard
 * state with apiKey + oauthProfileId + validated=true. SPEC R6 acceptance
 * requires the profile to exist in ~/.comis/auth-profiles.json after the
 * wizard advances past step 04.
 */
async function handleOpenAIOAuth(
  state: WizardState,
  prompter: WizardPrompter,
): Promise<WizardState> {
  const isRemote = isRemoteEnvironment({ env: process.env });
  const maxRetries = 3;

  // Display the helpNote so the operator sees what the OAuth flow will
  // do BEFORE the runner is invoked. handleStandardProvider's
  // helpNote presentation lives inside its own dispatch path, which is
  // BYPASSED for the openai+oauth case — surface it here.
  const authConfig = AUTH_METHOD_PROVIDERS["openai"];
  const helpNote = authConfig?.helpNotes.oauth;
  if (helpNote) {
    prompter.note(info(helpNote), "openai OAuth");
  }

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
          module: "wizard-oauth",
        },
        "OAuth profile written by wizard",
      );

      // SPEC R6 acceptance — wizard state carries oauthProfileId for downstream
      // (Phase 9 multi-account); apiKey holds the access token for
      // backward-compat with handleStandardProvider's downstream consumers.
      return updateState(state, {
        provider: {
          id: "openai",
          authMethod: "oauth",
          apiKey: v.access,
          oauthProfileId: v.profileId,
          validated: true,
        } as ProviderConfig,
      });
    }

    // Failure path — surface the rewritten error + recovery options.
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
    // choice === "retry" → continue loop
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

    // Phase 8 D-03 + Pitfall 8: hoisted auth-method select runs UP FRONT
    // for providers in AUTH_METHOD_PROVIDERS so the dispatcher can branch
    // to the right handler before handleStandardProvider runs. Without
    // this hoist, the auth-method select is buried inside
    // handleStandardProvider and we cannot route openai+oauth to the
    // interactive runner without a double-prompt.
    let authMethod: AuthMethod | undefined;
    // eslint-disable-next-line security/detect-object-injection -- read of static const map indexed by validated provider string
    const authConfig = AUTH_METHOD_PROVIDERS[providerId];
    if (authConfig) {
      authMethod = await prompter.select<AuthMethod>({
        message: `${providerId} authentication method`,
        options: authConfig.options,
      });
    }

    // Branch D: OpenAI OAuth — interactive flow (Phase 8 D-03).
    // REPLACES the pre-Phase-8 pre-generated-token paste path.
    // Anthropic OAuth still flows through handleStandardProvider unchanged
    // (RESEARCH §Pitfall 8 — claude setup-token paste is the source of truth
    // for those tokens; pi-ai has no equivalent loginAnthropic to wire).
    if (providerId === "openai" && authMethod === "oauth") {
      return handleOpenAIOAuth(state, prompter);
    }

    // Branch C: Standard provider — pass the hoisted authMethod so the
    // handler doesn't double-prompt.
    return handleStandardProvider(state, prompter, providerId, authMethod);
  },
};
