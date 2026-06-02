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
  validateConfig,
  safePath,
  selectOAuthCredentialStore,
  systemGetEnv,
  type OAuthCredentialStorePort,
} from "@comis/core";

/**
 * Resolve the active credential storage mode from config.yaml.
 *
 * Uses COMIS_CONFIG_PATHS with ":" separator (matching daemon.ts:1422).
 * Returns "file" when no config is found or the config is invalid.
 */
export async function loadWizardStorageMode(): Promise<
  "file" | "encrypted" | "env"
> {
  const envPaths = systemGetEnv("COMIS_CONFIG_PATHS");
  const configPath =
    envPaths?.split(":")[0] ?? safePath(homedir(), ".comis", "config.yaml");
  const loadResult = loadConfigFile(configPath);
  if (!loadResult.ok) {
    return "file";
  }
  const validated = validateConfig(loadResult.value);
  if (!validated.ok) {
    return "file";
  }
  return (validated.value.security?.storage ?? "file") as
    | "file"
    | "encrypted"
    | "env";
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
