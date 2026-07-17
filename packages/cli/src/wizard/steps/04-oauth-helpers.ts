// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI wizard helper; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).
/**
 * Shared OAuth store helpers for the credentials wizard step.
 *
 * Extracted from `04-credentials.ts` to keep that file under the 800-line
 * architecture cap. Both helpers are private to the wizard layer and may
 * not be imported outside of `wizard/steps/`.
 *
 * @module
 */

import { homedir } from "node:os";
import {
  createFileLock,
  loadConfigFile,
  loadEnvFile,
  parseConfigPaths,
  validateConfig,
  safePath,
  selectOAuthCredentialStore,
  systemGetEnv,
  isRemoteEnvironment,
  loginOpenAICodexOAuth,
  systemEnvSnapshot,
  redactEmailForLog,
  createConsoleLogger,
  AuthSetContract,
  type OAuthCredentialStorePort,
  type OAuthProfile,
} from "@comis/core";
import open from "open";
import type { WizardState, ProviderConfig } from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { info } from "../theme.js";
import { callTyped, withClient, isGatewayAuthRejection } from "../../client/rpc-client.js";
import { DAEMON_PROBE_TIMEOUT_MS } from "../../util/daemon-required.js";
import { isDaemonRunning } from "../../sync-tooling/daemon-guard.js";
import { offlineOAuthProfileSet } from "../../util/offline-secrets-store.js";

/**
 * Resolve the active credential storage mode from config.yaml.
 *
 * Uses the shared comma-separated COMIS_CONFIG_PATHS contract.
 * Returns "file" when no config is found or the config is invalid.
 */
export async function loadWizardStorageMode(): Promise<
  "file" | "encrypted" | "env"
> {
  const envPaths = systemGetEnv("COMIS_CONFIG_PATHS");
  const configPath =
    parseConfigPaths(envPaths)[0] ?? safePath(homedir(), ".comis", "config.yaml");

  // Resolve ${VAR} refs before validation — consistent with daemon bootstrap.
  // Use COMIS_DATA_DIR if set (test isolation), else the standard data dir.
  const dataDir = systemGetEnv("COMIS_DATA_DIR") ?? safePath(homedir(), ".comis");
  loadEnvFile(safePath(dataDir, ".env"));

  const loadResult = loadConfigFile(configPath, {
    getSecret: (k) => systemGetEnv(k),
  });
  if (!loadResult.ok) {
    // No config.yaml yet (e.g. during `comis init`, before step 10 writes it).
    // Align with the daemon's encrypted default when the encrypted store is
    // actually usable — i.e. a SECRETS_MASTER_KEY exists. Without a master key
    // there is no encrypted store to write to, so fall back to file mode.
    return systemGetEnv("SECRETS_MASTER_KEY") ? "encrypted" : "file";
  }
  const validated = validateConfig(loadResult.value);
  if (!validated.ok) {
    // Same rationale as the config-absent branch above.
    return systemGetEnv("SECRETS_MASTER_KEY") ? "encrypted" : "file";
  }
  // security.storage is always present on a valid config
  // (SecurityConfigSchema gives it .default("encrypted") and AppConfigSchema
  // gives security itself .default(...)). The ?. and ?? "file" fallbacks
  // are unreachable, and the `as` cast is redundant (type is already
  // CredentialStorageMode = "file" | "encrypted" | "env").
  return validated.value.security.storage;
}

/**
 * Open the OAuth credential store from the current config (mirrors the
 * helper installed in `auth.ts`). Defaults to file storage when config
 * is absent or doesn't set `security.storage`.
 *
 * NOTE: This function must only be called in FILE mode. For encrypted mode,
 * use the daemon RPC path in handleCodexOAuth directly (no store opened in
 * CLI). For env mode, reject before reaching this function.
 */
export async function openWizardOAuthStore(): Promise<OAuthCredentialStorePort> {
  const dataDir = safePath(homedir(), ".comis");
  const fileLock = createFileLock();
  const storage = await loadWizardStorageMode();
  if (storage === "env") {
    // Defensive: env mode is read-only. handleCodexOAuth should have
    // already rejected before reaching this path.
    throw new Error(
      "OAuth credential store is read-only in 'env' storage mode. " +
        "Set security.storage to 'file' or 'encrypted' in config.yaml to enable OAuth login.",
    );
  }
  if (storage === "encrypted") {
    // Encrypted mode: the wizard cannot open secrets.db directly.
    // handleCodexOAuth detects encrypted mode before calling openWizardOAuthStore
    // and routes through the daemon RPC (callTyped(AuthSetContract)).
    // This throw is a defensive backstop — the encrypted branch in
    // handleCodexOAuth returns early and never reaches this call.
    throw new Error(
      "OAuth storage mode is 'encrypted' but the wizard cannot bootstrap the encrypted store. " +
        "This is an internal error — the encrypted path should not reach openWizardOAuthStore.",
    );
  }
  return selectOAuthCredentialStore({ storage: "file", dataDir, fileLock });
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
export async function handleCodexOAuth(
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

  // Inline helpNote -- AUTH_METHOD_PROVIDERS has no openai entry,
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
