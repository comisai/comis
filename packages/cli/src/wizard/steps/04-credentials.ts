// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).
/**
 * Credentials entry step -- step 04 of the init wizard.
 *
 * Collects API credentials for the provider selected in step 03.
 * Three branches handle different provider types:
 *
 * - **Ollama**: no key needed, skip straight through
 * - **Custom endpoint**: collect base URL, compat mode, key, model ID
 * - **Standard provider**: show help URL, format pre-check, live API validation,
 *   retry/continue-anyway/skip recovery on failure
 *
 * Live validation uses a provider-specific models endpoint with a 5-second
 * timeout. Providers without a verified endpoint contract are saved as
 * unverified instead of being probed with a guessed path.
 *
 * @module
 */

import type {
  WizardState,
  WizardStep,
  ProviderConfig,
  AuthMethod,
} from "../types.js";
import { MULTI_VALUE_PROVIDER_CREDENTIAL_NAMES } from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { sectionSeparator, info } from "../theme.js";
import { validateApiKey, getKeyPrefix } from "../validators/api-key.js";
import type { BuiltinProvider } from "@earendil-works/pi-ai/compat";
import { getModels } from "@earendil-works/pi-ai/compat";

import { systemClearTimeout, systemSetTimeout } from "@comis/core";
import { handleCodexOAuth } from "./04-oauth-helpers.js";
import { handleBedrockAuth } from "./04-aws-helpers.js";

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
 * Providers absent from this table are deliberately not probed. A guessed
 * path can both reject a valid credential and send it to the wrong endpoint.
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
 * Resolve the validation endpoint from pi-ai's catalog base URL and an
 * explicitly reviewed path in PROVIDER_VALIDATION_PATHS.
 *
 * Returns `undefined` when either half is absent. Callers save the credential
 * as unverified in that case.
 */
function getValidationEndpoint(
  provider: string,
): { baseUrl: string; path: string } | undefined {
  // eslint-disable-next-line security/detect-object-injection -- read of static const map indexed by validated provider string
  const path = PROVIDER_VALIDATION_PATHS[provider];
  if (!path) return undefined;
  const baseUrl = getModels(provider as BuiltinProvider)[0]?.baseUrl;
  if (!baseUrl) return undefined;
  return { baseUrl, path };
}

// ---------- Live Validation ----------

/**
 * Validate an API key against the provider's /models endpoint.
 *
 * Returns a distinct status for a successful check, a failed check, or an
 * intentionally skipped check. Callers must never present `skipped` as proof
 * that a credential is valid.
 *
 * @param authMethod - OAuth tokens are saved without a guessed live check.
 */
async function validateKeyLive(
  provider: string,
  apiKey: string,
  authMethod?: AuthMethod,
): Promise<
  | { status: "valid" }
  | { status: "invalid"; error: string }
  | { status: "skipped"; reason: string }
> {
  // OAuth tokens cannot be validated against /models endpoints --
  // Anthropic's /v1/models rejects OAuth Bearer tokens with 401.
  // Skip live validation and trust the format check.
  if (authMethod === "oauth") {
    return {
      status: "skipped",
      reason: "OAuth token saved but not live-validated; it will be checked on the first model request.",
    };
  }

  const entry = getValidationEndpoint(provider);
  if (!entry) {
    return {
      status: "skipped",
      reason: `${provider} credential saved but not live-validated because no verified validation endpoint is configured. It will be checked on the first model request.`,
    };
  }

  let url = `${entry.baseUrl}${entry.path}`;
  const headers: Record<string, string> = {};

  // Provider-specific auth header schemes
  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
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
      return { status: "valid" };
    }

    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", error: `Invalid API key (${response.status})` };
    }

    return { status: "invalid", error: `API returned ${response.status}` };
  } catch {
    return { status: "invalid", error: "Could not reach provider (network error or timeout)" };
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
 * Branch B: Custom endpoint -- collect base URL, compat mode, key, and model ID.
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
    message: "API key",
    validate: (v: string) => {
      if (typeof v !== "string") return undefined;
      if (!v.trim()) {
        return "API key is required. Configure Ollama or LM Studio directly for a keyless endpoint.";
      }
      return undefined;
    },
  });
  const apiKey = key.trim();
  if (!apiKey) {
    throw new Error(
      "API key is required for custom endpoints. Configure Ollama or LM Studio directly for a keyless endpoint.",
    );
  }

  const modelId = await prompter.text({
    message: "Model ID",
    placeholder: "my-model-v2",
    validate: (v: string) => {
      if (typeof v !== "string") return undefined;
      if (!v.trim()) return "Model ID is required.";
      return undefined;
    },
  });

  prompter.log.info(
    "Custom endpoint credential saved but not live-validated; it will be checked on the first model request.",
  );

  return updateState(state, {
    provider: {
      id: "custom",
      customEndpoint: baseUrl.trim(),
      compatMode,
      apiKey,
      validated: false,
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

    if (result.status === "valid") {
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

    if (result.status === "skipped") {
      spin.stop(`${credLabel} saved without live validation`);
      prompter.log.info(result.reason);
      return updateState(state, {
        provider: {
          id: providerId,
          apiKey: key,
          authMethod,
          validated: false,
        } as ProviderConfig,
      });
    }

    // Validation failed
    spin.stop("Validation failed");
    prompter.log.warn(result.error);

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
// handleCodexOAuth (+ its wizardLogger) lives in ./04-oauth-helpers.ts to keep
// this file under the 800-line architecture cap. credentialsStep dispatches to it.


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

    // Bedrock supports a managed bearer, a stored AWS profile, or the ambient
    // credential chain. Keep this dispatch above the multi-value abort and the
    // standard-provider auth-method selector.
    if (providerId === "amazon-bedrock") {
      return handleBedrockAuth(state, prompter);
    }

    // The current wizard credential shape stores one entered value. Abort with
    // exact recovery names for providers that require routing identifiers too.
    // eslint-disable-next-line security/detect-object-injection -- static credential map indexed by a catalog provider id
    const multiValueNames = MULTI_VALUE_PROVIDER_CREDENTIAL_NAMES[providerId];
    if (multiValueNames) {
      throw new Error(
        `${providerId} requires multiple credential values: ${multiValueNames.join(", ")}. ` +
        "Complete init with a single-key provider, store each value with `comis secrets set <NAME>`, then configure this provider.",
      );
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
