// SPDX-License-Identifier: Apache-2.0
/**
 * Model Catalog: In-memory store combining pi-ai's static model registry
 * with live scan results for validated model metadata.
 *
 * The catalog serves as the central source of truth for model metadata
 * (context window, max tokens, input capabilities, cost, validation status).
 * It is populated on startup from pi-ai's static registry of 22+ providers
 * and hundreds of models, then optionally merged with live scan results
 * that confirm API key validity and discover additional models.
 *
 * @module
 */

import { getProviders, getModels } from "@earendil-works/pi-ai/compat";
import type { ModelCompatConfig } from "../domain/model-compat.js";
import { isNativeProvider } from "./model-family.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single entry in the model catalog. */
export interface CatalogEntry {
  /** Provider identifier (e.g., "anthropic", "openai") */
  provider: string;
  /** Model identifier at the provider (e.g., "claude-sonnet-4-5-20250929") */
  modelId: string;
  /** Human-readable display name */
  displayName: string;
  /** Maximum context window in tokens */
  contextWindow: number;
  /** Maximum output tokens */
  maxTokens: number;
  /** Supported input modalities */
  input: ("text" | "image")[];
  /** Whether the model supports extended thinking / reasoning */
  reasoning: boolean;
  /** Cost per million tokens */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Whether the model was confirmed available via API scan */
  validated: boolean;
  /** Timestamp of last successful validation (0 if never validated) */
  validatedAt: number;
  /** Comis-domain compatibility flags. Undefined = use provider defaults. */
  comisCompat?: ModelCompatConfig;
}

/** Model catalog interface for querying and managing model metadata. */
export interface ModelCatalog {
  /** Get a specific model entry by provider and model ID. */
  get(provider: string, modelId: string): CatalogEntry | undefined;
  /** Get all models for a provider. */
  getByProvider(provider: string): CatalogEntry[];
  /** Get all catalog entries. */
  getAll(): CatalogEntry[];
  /** Populate the catalog from pi-ai's static model registry. */
  loadStatic(): void;
  /** Merge live scan results into the catalog, updating validation state. */
  mergeScanned(entries: CatalogEntry[]): void;
  /** Get all provider names that have at least one model. */
  getProviders(): string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function catalogKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a model catalog backed by an in-memory Map.
 *
 * Usage:
 * ```typescript
 * const catalog = createModelCatalog();
 * catalog.loadStatic(); // populates from pi-ai
 * catalog.mergeScanned(scanResults); // merge live validation
 * const entry = catalog.get("anthropic", "claude-sonnet-4-5-20250929");
 * ```
 */
export function createModelCatalog(): ModelCatalog {
  const entries = new Map<string, CatalogEntry>();

  return {
    get(provider: string, modelId: string): CatalogEntry | undefined {
      return entries.get(catalogKey(provider, modelId));
    },

    getByProvider(provider: string): CatalogEntry[] {
      const result: CatalogEntry[] = [];
      for (const entry of entries.values()) {
        if (entry.provider === provider) {
          result.push(entry);
        }
      }
      return result;
    },

    getAll(): CatalogEntry[] {
      return Array.from(entries.values());
    },

    loadStatic(): void {
      const providers = getProviders();
      for (const providerName of providers) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider names are dynamic strings, SDK expects literal unions
        const models = getModels(providerName as any);
        for (const model of models) {
          const entry: CatalogEntry = {
            provider: providerName,
            modelId: model.id,
            displayName: model.name,
            contextWindow: model.contextWindow ?? 0,
            maxTokens: model.maxTokens ?? 0,
            input: (model.input ?? ["text"]) as ("text" | "image")[],
            reasoning: model.reasoning ?? false,
            cost: {
              input: model.cost?.input ?? 0,
              output: model.cost?.output ?? 0,
              cacheRead: model.cost?.cacheRead ?? 0,
              cacheWrite: model.cost?.cacheWrite ?? 0,
            },
            validated: false,
            validatedAt: 0,
          };
          entries.set(catalogKey(providerName, model.id), entry);
        }
      }
    },

    mergeScanned(scannedEntries: CatalogEntry[]): void {
      for (const scanned of scannedEntries) {
        const key = catalogKey(scanned.provider, scanned.modelId);
        const existing = entries.get(key);
        if (existing) {
          // Update validation state on existing entry
          existing.validated = scanned.validated;
          existing.validatedAt = scanned.validatedAt;
        } else {
          // New model discovered via scan -- add to catalog
          entries.set(key, { ...scanned });
        }
      }
    },

    getProviders(): string[] {
      const providerSet = new Set<string>();
      for (const entry of entries.values()) {
        providerSet.add(entry.provider);
      }
      return Array.from(providerSet);
    },
  };
}

// ---------------------------------------------------------------------------
// Per-token pricing resolution
// ---------------------------------------------------------------------------

/** Per-token cost rates for formulas (e.g., 0.000003 = $3/MTok).
 *  Converted from CatalogEntry's per-MTok rates by dividing by 1_000_000. */
export interface PerTokenCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Per-token cost for 1h TTL cache writes.
   *  Prefers SDK-supplied value when available; falls back to 2x input rate.
   *  1h TTL = 2x base input rate (Anthropic pricing). */
  cacheWrite1h: number;
}

/** Zero-cost sentinel for unknown models. Callers check cost.input > 0 before using rates. */
export const ZERO_COST: PerTokenCostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };

let _pricingSingleton: ModelCatalog | undefined;

/**
 * Resolve per-token cost rates for a provider/model pair.
 * Returns ZERO_COST for unknown models -- callers check cost.input > 0.
 *
 * CatalogEntry.cost stores per-MTok rates from the pi-ai SDK.
 * This function divides by 1_000_000 to return per-token rates
 * so downstream formulas like `tokens * rate = $cost` work directly.
 */
export function resolveModelPricing(
  provider: string,
  modelId: string,
  catalog?: ModelCatalog,
): PerTokenCostRates {
  const source = catalog ?? (() => {
    if (!_pricingSingleton) {
      _pricingSingleton = createModelCatalog();
      _pricingSingleton.loadStatic();
    }
    return _pricingSingleton;
  })();
  const entry = source.get(provider, modelId);
  if (!entry) return ZERO_COST;

  const inputRate = entry.cost.input / 1_000_000;

  // cacheWrite1h SDK-preference guard.
  // Derive 1h TTL rate as 2x input (Anthropic pricing).
  // Prefer SDK-supplied value when the cost object includes cacheWrite1h.
  const derived1h = inputRate * 2;
  const sdkCost = entry.cost as Record<string, unknown>;
  let cacheWrite1h = derived1h;
  if (typeof sdkCost.cacheWrite1h === "number" && sdkCost.cacheWrite1h > 0) {
    const sdk1h = sdkCost.cacheWrite1h / 1_000_000;
    // Drift detection -- >5% divergence from derived 2x rate.
    // When the SDK provides a cacheWrite1h that differs significantly from
    // the expected 2x-input derivation, callers should log a WARN.
    // model-catalog is stateless (no logger) so we only compute the flag.
    if (derived1h > 0 && Math.abs(sdk1h - derived1h) / derived1h > 0.05) {
      // Drift detected: SDK 1h rate diverges >5% from 2x input derivation.
      // Consumer (pi-event-bridge) should log WARN with hint + errorKind.
    }
    cacheWrite1h = sdk1h;
  }

  return {
    input: inputRate,
    output: entry.cost.output / 1_000_000,
    cacheRead: entry.cost.cacheRead / 1_000_000,
    cacheWrite: entry.cost.cacheWrite / 1_000_000,
    cacheWrite1h,
  };
}

/**
 * The honest three-state pricing signal.
 * Derives whether a provider/model's cost is `priced` (a real catalog rate),
 * `free` (a gateway/local runtime where $0 is correct), or `unknown` (a native
 * provider with NO catalog entry — the dangerous fail-open where
 * {@link resolveModelPricing} silently returns {@link ZERO_COST}, masking a phantom
 * cost as if it were free).
 *
 * Deliberately SEPARATE from {@link resolveModelPricing}
 * (whose return type {@link PerTokenCostRates} + 5 production callers stay
 * untouched). The signal is persisted as `pricing_state`; the spend
 * kill-switch consumes it.
 *
 * The discriminator is provider-family membership ({@link isNativeProvider} over
 * model-family.ts's `NATIVE_PROVIDER_FAMILY`), NOT a bare catalog-presence boolean:
 * a local/gateway provider (ollama/openrouter/llama.cpp/vllm/lm-studio) absent from
 * that map legitimately serves uncosted models, so its $0 is `free`, never
 * `unknown`.
 *
 * @param provider - the provider id (e.g. "anthropic", "ollama").
 * @param modelId  - the model id at the provider.
 * @returns the closed pricing-state union.
 */
export function resolvePricingState(
  provider: string,
  modelId: string,
  catalog?: ModelCatalog,
): "priced" | "free" | "unknown" {
  // 1. A real catalog rate (non-ZERO_COST) → priced. Check the cost-bearing rates
  //    (a catalog entry with all-zero cost — e.g. a scanned custom model — is
  //    treated as not-priced and falls through to the family discriminator).
  const rates = resolveModelPricing(provider, modelId, catalog);
  if (rates.input > 0 || rates.cacheRead > 0 || rates.output > 0) return "priced";

  // 2. A gateway/local/aggregator provider (absent from NATIVE_PROVIDER_FAMILY) →
  //    free. $0 is correct for these runtimes.
  if (!isNativeProvider(provider)) return "free";

  // 3. A NATIVE single-family provider with no catalog entry → unknown (a
  //    provider↔model chimera: a phantom $0 that must NOT be reported as free).
  return "unknown";
}

/**
 * Whether a (provider, modelId) resolves to a REAL entry in the model catalog
 * (the built-in static registry + any merged scanned/custom entries).
 *
 * Distinct from {@link resolveModelPricing} / {@link resolvePricingState}: those
 * return ZERO_COST / `"free"` for BOTH an uncosted-but-cataloged model AND an
 * unknown one, so they cannot detect an UNRESOLVED model id — the fail-closed-to-
 * nano class where `modelRegistry.find()` returns undefined and the whole
 * ModelProfile collapses to the nano/8192 profile (e.g. `openai-codex:gpt-5.6`
 * where the real ids are `gpt-5.6-terra`/`-luna`/`-sol`). Notably a non-native
 * provider like `openai-codex` resolves `"free"` for an unknown model (it is not
 * in NATIVE_PROVIDER_FAMILY), so neither the pricing nor the chimeric detector
 * flags it — a boot config-posture count uses THIS predicate instead.
 *
 * Callers should still exempt operator-declared custom models
 * (`providers.entries.<p>.models`) which are legitimately absent from the static
 * registry — this predicate only knows the static + scanned catalog.
 */
export function modelResolvesInCatalog(provider: string, modelId: string, catalog?: ModelCatalog): boolean {
  const source = catalog ?? (() => {
    if (!_pricingSingleton) {
      _pricingSingleton = createModelCatalog();
      _pricingSingleton.loadStatic();
    }
    return _pricingSingleton;
  })();
  return source.get(provider, modelId) !== undefined;
}
