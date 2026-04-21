// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Sender trust display configuration schema.
 *
 * Controls how sender identity is surfaced to the LLM in the message
 * envelope. Modes range from raw platform IDs (transparent but privacy-weak)
 * to HMAC-hashed prefixes (privacy-preserving but still uniquely identifying)
 * to human-readable aliases (operator-managed mapping).
 */
export const SenderTrustDisplayConfigSchema = z.strictObject({
  /** Whether sender identity is included in the message envelope */
  enabled: z.boolean().default(false),
  /** Display mode: raw (platform ID), hash (HMAC prefix), or alias (operator-defined name) */
  displayMode: z.enum(["raw", "hash", "alias"]).default("hash"),
  /** Number of hex characters to show from the HMAC digest (4-16) */
  hashPrefix: z.number().int().min(4).max(16).default(8),
  /** SecretManager key for the HMAC secret; empty string uses agentId as fallback */
  hashSecretRef: z.string().default(""),
  /** Sender ID to human-readable alias mapping (used when displayMode is "alias") */
  aliases: z.record(z.string(), z.string()).default({}),
});

export type SenderTrustDisplayConfig = z.infer<typeof SenderTrustDisplayConfigSchema>;
