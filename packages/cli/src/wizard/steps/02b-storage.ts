// SPDX-License-Identifier: Apache-2.0
/**
 * Credential-storage step -- step 02b of the init wizard.
 *
 * Runs immediately after flow-select and BEFORE provider/credentials so the
 * encrypted store's master key is provisioned before any OAuth login or
 * secret collection. Closes the silent plaintext-degradation hole: encrypted
 * is the recommended default, and accepting it on a fresh `~/.comis`
 * provisions a `SECRETS_MASTER_KEY` so credentials end up encrypted-at-rest.
 *
 * Idempotent: `writeMasterKeyIfAbsent` is only invoked when no key is present
 * AND no `secrets.db` exists, so re-running init over an already-sealed store
 * never re-keys it (no DECRYPTION_FAILED orphaning).
 *
 * @module
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  writeMasterKeyIfAbsent,
  safePath,
  loadEnvFile,
  systemGetEnv,
  type CredentialStorageMode,
} from "@comis/core";
import type { WizardState, WizardStep } from "../types.js";
import type { WizardPrompter } from "../prompter.js";
import { updateState } from "../state.js";
import { loadWizardStorageMode } from "./04-oauth-helpers.js";

// ---------- Step Implementation ----------

export const storageStep: WizardStep = {
  id: "storage",
  label: "Credential Storage",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    // Resolve the data dir the same way loadWizardStorageMode does so the key
    // detection + provisioning target the canonical ~/.comis/.env location.
    const dataDir = systemGetEnv("COMIS_DATA_DIR") ?? safePath(homedir(), ".comis");

    // Load ~/.comis/.env into the process env snapshot (consistent with
    // 04-oauth-helpers.ts) so systemGetEnv("SECRETS_MASTER_KEY") reflects a
    // key written by an earlier run. loadEnvFile never overwrites existing
    // entries.
    loadEnvFile(safePath(dataDir, ".env"));

    const keyPresent = !!systemGetEnv("SECRETS_MASTER_KEY");
    const dbPresent = existsSync(safePath(dataDir, "secrets.db"));

    // Default the picker to the recommended "encrypted" mode on a fresh data
    // dir (no key, no store). When a key/store already exists, honor the
    // resolved config mode so a prior explicit "file" choice is preserved on
    // re-run. loadWizardStorageMode returns "env" for a read-only env-mode
    // config; the two-option picker only offers encrypted|file, so treat
    // anything other than "file" as "encrypted".
    let initialValue: CredentialStorageMode = "encrypted";
    if (keyPresent || dbPresent) {
      const resolved = await loadWizardStorageMode();
      initialValue = resolved === "file" ? "file" : "encrypted";
    }

    const chosen = await prompter.select<CredentialStorageMode>({
      message: "Encrypt credentials at rest?",
      options: [
        {
          value: "encrypted",
          label: "Yes — encrypted at rest (recommended)",
        },
        { value: "file", label: "No — plaintext .env" },
      ],
      initialValue,
    });

    // Only provision a key when encrypted is chosen AND there is no existing
    // key or store. writeMasterKeyIfAbsent is itself idempotent, but the guard
    // avoids even touching .env when a store already exists.
    if (chosen === "encrypted" && !keyPresent && !dbPresent) {
      const res = writeMasterKeyIfAbsent(dataDir);
      if (res.written) {
        // Path only — NEVER log res.keyHex.
        prompter.log.warn(
          "Generated an encryption key at ~/.comis/.env — back this up; without it your stored credentials cannot be decrypted.",
        );
      }
    }

    return updateState(state, { storageMode: chosen });
  },
};
