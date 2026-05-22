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
  /** Enable encrypted secrets store. Default false (opt-in to encrypted secrets store). */
  enabled: z.boolean().default(false),
  /** Path to secrets.db relative to dataDir. */
  dbPath: z.string().default("secrets.db"),
});

export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
