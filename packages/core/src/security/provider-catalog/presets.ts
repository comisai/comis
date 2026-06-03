// SPDX-License-Identifier: Apache-2.0
/**
 * Built-in provider presets for the credential-injection broker.
 *
 * Port of OneCLI `apps.rs` curated preset catalog (Apache-2.0).
 *
 * Two presets are defined here (the initial ported set):
 *   - "anthropic": api.anthropic.com via x-api-key header, path-scoped to /v1/*
 *   - "finnhub": finnhub.io via `token` query parameter
 *
 * Presets do NOT carry a `secretRef` — the operator supplies the secretRef at
 * config time. `expandPreset(id, secretRef)` produces a `BrokerBinding`; the
 * injection engine only ever sees bindings, never presets.
 *
 * No I/O, no logger, no side-effects. Pure module.
 *
 * @module
 */

import type { ProviderPreset, BrokerBinding, PresetLibrary } from "./types.js";

// ── PRESETS ───────────────────────────────────────────────────────────────────

/** Built-in provider preset catalog. */
export const PRESETS: PresetLibrary = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    hostRules: [
      {
        pattern: { kind: "exact", host: "api.anthropic.com" },
        pathPolicy: ["/v1/*"],
        inject: [
          {
            kind: "setHeader",
            name: "x-api-key",
            format: "raw",
            removeAuthorization: true,
          },
        ],
      },
    ],
  },
  {
    id: "finnhub",
    displayName: "Finnhub",
    hostRules: [
      {
        pattern: { kind: "exact", host: "finnhub.io" },
        inject: [{ kind: "setParam", name: "token" }],
      },
    ],
  },
];

// ── expandPreset ──────────────────────────────────────────────────────────────

/**
 * Expand a named preset into a `BrokerBinding` by merging the preset's host
 * rules with the caller-supplied `secretRef`.
 *
 * Throws `Error("Unknown preset: <id>")` when no preset with the given id
 * is found — never returns a partial or default binding.
 *
 * @param id - Preset identifier (e.g. "anthropic", "finnhub")
 * @param secretRef - SecretManager key resolved per request
 */
export function expandPreset(id: string, secretRef: string): BrokerBinding {
  const preset: ProviderPreset | undefined = PRESETS.find((p) => p.id === id);
  if (preset === undefined) {
    throw new Error(`Unknown preset: ${id}`);
  }
  return {
    hostRules: preset.hostRules,
    secretRef,
    ...(preset.credentialRefs !== undefined && { credentialRefs: preset.credentialRefs }),
  };
}
