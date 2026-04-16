import { createHash } from "node:crypto";

/**
 * Compute a stable identity hash from embedding provider configuration.
 * Returns the FULL SHA-256 hex (64 chars). Used by both the fingerprint
 * manager (fingerprint_hash) and the L2 cache (config_hash column).
 *
 * CRITICAL: The hash format is "${modelId}:${dimensions}" and MUST NOT
 * change -- any change triggers spurious reindex on existing deployments.
 */
export function computeEmbeddingIdentityHash(
  modelId: string,
  dimensions: number,
): string {
  const input = `${modelId}:${dimensions}`;
  return createHash("sha256").update(input).digest("hex");
}
