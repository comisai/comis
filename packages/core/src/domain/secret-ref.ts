// SPDX-License-Identifier: Apache-2.0
/**
 * SecretRef — typed reference to an externally-managed secret.
 *
 * Instead of embedding plaintext secrets in config YAML, operators can
 * declare where a secret lives:
 *
 *   - **env**: read from SecretManager (environment variable / encrypted store)
 *   - **file**: read from a file on disk (Vault agent sidecar, K8s mounted secrets)
 *   - **exec**: invoke a credential helper binary (1Password CLI, AWS Secrets Manager CLI)
 *
 * The daemon resolves all SecretRef objects in config before any adapter
 * or subsystem code runs, so downstream consumers always see plain strings.
 *
 * SecretRef domain type.
 */

import { z } from "zod";

/**
 * Zod schema for a secret reference object.
 *
 * - `source`: how to resolve the secret ("env", "file", or "exec")
 * - `provider`: logical provider name (e.g., "vault", "op", "aws-sm").
 *   For file sources, may include a `#/json/pointer` suffix to extract
 *   a value from a JSON file.
 * - `id`: the lookup key — env var name, file path, or secret identifier
 */
export const SecretRefSchema = z.strictObject({
  source: z.enum(["env", "file", "exec"]),
  provider: z.string().min(1),
  id: z.string().min(1),
});

/** Inferred type for a secret reference. */
export type SecretRef = z.infer<typeof SecretRefSchema>;

/**
 * Runtime type guard for SecretRef objects.
 * Uses Zod safeParse for correctness — not just shape checking.
 */
export function isSecretRef(value: unknown): value is SecretRef {
  return SecretRefSchema.safeParse(value).success;
}

/**
 * Reusable Zod schema for config fields that accept either a plain string
 * or a SecretRef object. Used in channel/gateway/webhook config schemas.
 */
export const SecretRefOrStringSchema = z.union([z.string(), SecretRefSchema]);
