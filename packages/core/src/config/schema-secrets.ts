// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Per-agent secret access configuration. */
export const AgentSecretsConfigSchema = z.strictObject({
  /** Glob patterns for allowed secret names. Empty array = unrestricted access. */
  allow: z.array(z.string()).default([]),
});

export type AgentSecretsConfig = z.infer<typeof AgentSecretsConfigSchema>;

/** Global encrypted secrets store configuration. */
export const SecretsConfigSchema = z.strictObject({
  /**
   * Enable encrypted secrets store. Default false — opt-in.
   *
   * When set to `true` (in YAML), the daemon bootstraps an AES-256-GCM
   * SQLite store: `writeMasterKeyIfAbsent` writes `SECRETS_MASTER_KEY` to
   * `<dataDir>/.env` if absent, and `bootstrapSecretsAndEnv` opens
   * `<dataDir>/<dbPath>`. When `false` (or omitted), both steps are
   * skipped — `.env` is left untouched and `secrets.db` is never opened.
   *
   * The env var `COMIS_DISABLE_ENCRYPTED_SECRETS=1` is an additional
   * opt-out path: it disables the store regardless of the YAML value.
   * (Operators who previously enabled the store and then set this env
   * var will see a backup-obligation WARN — `SECRETS_MASTER_KEY` may
   * already exist in `~/.comis/.env` and must be preserved if they
   * intend to re-enable the store later.)
   */
  enabled: z.boolean().default(false),
  /** Path to secrets.db relative to dataDir. */
  dbPath: z.string().default("secrets.db"),
});

export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
