// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Per-agent secret access configuration. */
export const AgentSecretsConfigSchema = z.strictObject({
  /** Glob patterns for allowed secret names. Empty array = unrestricted access. */
  allow: z.array(z.string()).default([]),
});

export type AgentSecretsConfig = z.infer<typeof AgentSecretsConfigSchema>;

/**
 * Global secrets store configuration.
 *
 * Previously contained `dbPath` (removed in v1.5 Plan 02-02 as a dead knob —
 * the value was never read; `setup-secrets.ts` hardcodes `"secrets.db"`).
 * If `security.secrets.dbPath` is present in a config.yaml, `checkLegacyConfigKeys`
 * will surface a MIGRATION_ERROR (T-02-07 guard).
 */
export const SecretsConfigSchema = z.strictObject({});

export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
