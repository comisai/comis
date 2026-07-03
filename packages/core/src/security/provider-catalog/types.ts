// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-catalog vocabulary: HostPattern, InjectionRule, HostRule,
 * BrokerBinding, ProviderPreset.
 *
 * Pure type definitions — zero runtime values, zero imports.
 * Consumed by matcher.ts, injection-engine.ts, and presets.ts.
 *
 * Port of OneCLI `apps.rs` type vocabulary (Apache-2.0). All discriminated
 * unions use `type`; all compound structures use `interface` with `readonly`
 * properties.
 *
 * @module
 */

// ── Host patterns ────────────────────────────────────────────────────────────

/** How a catalog entry matches an outbound hostname (port of apps.rs HostPattern :44-58). */
export type HostPattern =
  | { readonly kind: "exact"; readonly host: string }
  | { readonly kind: "suffix"; readonly suffix: string };

// ── Injection rules ──────────────────────────────────────────────────────────

/** Header/param injection (port of inject.rs Injection enum :19-42). Applied in array order. */
export type InjectionRule =
  | { readonly kind: "setHeader"; readonly name: string; readonly format: "raw" | "bearer"; readonly removeAuthorization?: boolean }
  | { readonly kind: "replaceHeader"; readonly name: string; readonly format: "raw" | "bearer" }
  | { readonly kind: "removeHeader"; readonly name: string }
  | { readonly kind: "setParam"; readonly name: string };

// ── Finalizer ────────────────────────────────────────────────────────────────

/** Post-injection, body-aware finalizer — runs after header/param injection with the buffered request body. */
export type RequestFinalizer = { readonly kind: "awsSigV4" };

// ── Static header ────────────────────────────────────────────────────────────

/** A static (non-secret) header a provider always needs, e.g. Vertex's x-goog-user-project.
 *  `valueRef` resolves from operator config via ${VAR} at session-creation (NOT SecretManager). */
export interface StaticHeader {
  readonly name: string;
  readonly valueRef: string;
}

// ── Host rule ────────────────────────────────────────────────────────────────

/** A host rule within a provider. */
export interface HostRule {
  readonly pattern: HostPattern;
  /** Path-prefix scoping (e.g. "/calendar/"); undefined = all paths on the host. */
  readonly pathPrefix?: string;
  /** Optional path-glob allow-list; broker refuses non-matching paths (port of path_matches :213-280). */
  readonly pathPolicy?: readonly string[];
  /** Secret-injection rules (the SECRET goes here). */
  readonly inject: readonly InjectionRule[];
  /** Non-secret static headers (project ids etc.). */
  readonly staticHeaders?: readonly StaticHeader[];
  /** Optional finalizer (runs after inject; needs the buffered body). */
  readonly finalizer?: RequestFinalizer;
}

// ── Broker binding ───────────────────────────────────────────────────────────

/** The provider-agnostic binding primitive. What the broker resolves and the engine consumes.
 *  Comes straight from operator config — no named provider required. A binding with `secretRef`
 *  and an empty `inject` defaults to `Authorization: Bearer` (the generic case). */
export interface BrokerBinding {
  readonly hostRules: readonly HostRule[];
  /** SecretManager key resolved per request for header/param injection (never cached to disk). */
  readonly secretRef: string;
  /** Extra refs for multi-field finalizers (e.g. AWS access/secret/region). */
  readonly credentialRefs?: Readonly<Record<string, string>>;
}

// ── Preset ───────────────────────────────────────────────────────────────────

/** Optional sugar. A named, reusable binding bundle (the apps.rs port). Presets do NOT carry a
 *  secret — the operator supplies `secretRef` at config time. `expandPreset(preset, secretRef)`
 *  produces a BrokerBinding; the engine only ever sees bindings, never presets. */
export interface ProviderPreset {
  readonly id: string;
  readonly displayName: string;
  readonly hostRules: readonly HostRule[];
  readonly credentialRefs?: Readonly<Record<string, string>>;
}

export type PresetLibrary = readonly ProviderPreset[];
