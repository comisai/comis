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
   * Enable encrypted secrets store. Default true — secure-by-default.
   *
   * The daemon auto-bootstraps an AES-256-GCM SQLite store on first boot,
   * writing `SECRETS_MASTER_KEY` to `<dataDir>/.env` and opening
   * `<dataDir>/<dbPath>`. Set this to `false` (in YAML) to disable the
   * store entirely — the daemon will skip `writeMasterKeyIfAbsent` and
   * `bootstrapSecretsAndEnv`, leaving `.env` untouched and never opening
   * `secrets.db`. The env var `COMIS_DISABLE_ENCRYPTED_SECRETS=1` is an
   * equivalent opt-out (either disables the store).
   */
  enabled: z.boolean().default(true),
  /** Path to secrets.db relative to dataDir. */
  dbPath: z.string().default("secrets.db"),
});

export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
