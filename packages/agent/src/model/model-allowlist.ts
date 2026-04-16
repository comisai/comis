/**
 * Model allowlist enforcement: restricts which LLM models an agent
 * is permitted to use.
 *
 * When the allowlist is empty (no entries), all models are allowed
 * (backward-compatible default). When populated, only models matching
 * an entry are permitted.
 *
 * Supports two matching formats:
 * - "provider/modelId" -- exact provider + model match
 * - "modelId" -- provider-agnostic match (any provider)
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Model allowlist interface returned by the factory. */
export interface ModelAllowlist {
  /**
   * Check if a specific provider/model combination is permitted.
   * Empty allowlist = allow all.
   */
  isAllowed(provider: string, modelId: string): boolean;

  /**
   * Filter a list of model candidates to only permitted ones.
   * Empty allowlist returns all models unchanged.
   */
  filter<T extends { provider: string; modelId: string }>(models: T[]): T[];

  /**
   * Whether the allowlist is active (has entries).
   * An inactive allowlist permits everything.
   */
  isActive(): boolean;

  /**
   * Get a human-readable rejection message listing allowed models.
   * Returns empty string if the allowlist is inactive or if the model is allowed.
   */
  getRejectionMessage(provider: string, modelId: string): string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a model allowlist from a list of allowed model strings.
 *
 * Each entry can be:
 * - "provider/modelId" for exact provider+model matching
 * - "modelId" for provider-agnostic matching
 *
 * An empty array means "allow all models" (backward compatible).
 *
 * @param allowedModels - List of permitted model strings
 */
export function createModelAllowlist(allowedModels: string[]): ModelAllowlist {
  const allowed = new Set(allowedModels);

  function isAllowed(provider: string, modelId: string): boolean {
    if (allowed.size === 0) return true;

    // Check exact "provider/modelId" match
    if (allowed.has(`${provider}/${modelId}`)) return true;

    // Check provider-agnostic "modelId" match
    if (allowed.has(modelId)) return true;

    return false;
  }

  return {
    isAllowed,

    filter<T extends { provider: string; modelId: string }>(models: T[]): T[] {
      if (allowed.size === 0) return models;
      return models.filter((m) => isAllowed(m.provider, m.modelId));
    },

    isActive(): boolean {
      return allowed.size > 0;
    },

    getRejectionMessage(provider: string, modelId: string): string {
      if (allowed.size === 0) return "";
      if (isAllowed(provider, modelId)) return "";
      return `Model '${provider}/${modelId}' is not allowed. Permitted models: ${[...allowed].join(", ")}`;
    },
  };
}
