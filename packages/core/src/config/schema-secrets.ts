// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Per-agent secret access configuration. */
export const AgentSecretsConfigSchema = z.strictObject({
  /** Glob patterns for allowed secret names. Empty array = unrestricted access. */
  allow: z.array(z.string()).default([]),
});

export type AgentSecretsConfig = z.infer<typeof AgentSecretsConfigSchema>;
