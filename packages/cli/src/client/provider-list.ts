// SPDX-License-Identifier: Apache-2.0
/**
 * Shared provider-list utility (RPC-first, local catalog fallback).
 *
 * Used by BOTH the wizard's provider selection step
 * (`wizard/steps/03-provider.ts`) AND the `comis providers list` command
 * (`commands/providers.ts`). The single utility avoids duplicating the
 * "try daemon, fall back to pi-ai locally" decision tree across two call
 * sites.
 *
 * RPC-first because the daemon's catalog may be enriched with live scan
 * results that the local pi-ai static registry doesn't know about.
 *
 * Local fallback handles the pre-init use case: the wizard runs *before*
 * the daemon exists for first-time users, and `comis providers list`
 * remains useful when the daemon is stopped.
 *
 * Logging: silent. The catch arms here represent the *normal* fallback
 * flow (daemon not running, daemon returned an unexpected shape), not
 * error conditions. Adding a logger would create noise on every wizard
 * boot. Surfaces above this layer (the wizard prompter, the providers
 * command's output) report the resulting state to the user.
 *
 * @module
 */

import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { callTyped, withClient } from "./rpc-client.js";
import {
  createModelCatalog,
  KEYLESS_PROVIDER_TYPES,
  ModelsListProvidersContract,
} from "@comis/core";

export type ProviderCredentialStatus =
  | "configured"
  | "keyless"
  | "not_configured"
  | "unknown";

export type ProviderCredentialSource =
  | "keyless"
  | "providers_entry"
  | "env_canonical"
  | "oauth_profile"
  | "oauth_env_seed"
  | "secret_store_canonical"
  | "none"
  | "daemon_unavailable";

export interface ProviderCatalogRow {
  provider: string;
  modelCount: number;
  status: ProviderCredentialStatus;
  credentialSource: ProviderCredentialSource;
}

/**
 * Defensive shape narrowing for the daemon RPC response.
 *
 * The daemon's `models.list_providers` handler is expected to return
 * `{ agentId, providers: ProviderCatalogRow[], count }`. We narrow at the
 * call site so a malformed response (e.g., daemon version skew, future
 * shape change) cannot crash the wizard.
 */
function isValidProvidersResponse(value: unknown): value is { providers: ProviderCatalogRow[] } {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { providers?: unknown };
  if (!Array.isArray(candidate.providers)) return false;
  return candidate.providers.every((row) => {
    if (row === null || typeof row !== "object") return false;
    const provider = row as Partial<ProviderCatalogRow>;
    return typeof provider.provider === "string"
      && typeof provider.modelCount === "number"
      && ["configured", "keyless", "not_configured"].includes(provider.status ?? "")
      && typeof provider.credentialSource === "string";
  });
}

/**
 * Load the catalog provider list, preferring the daemon RPC and falling
 * back to the local pi-ai catalog when the daemon is unreachable.
 *
 * Contract:
 * - Returns provider rows with model counts and credential status.
 * - Without an explicit agent selector, all error paths fall back locally;
 *   the worst-case return is `[]`.
 * - With an explicit agent selector, RPC failure is returned to the caller
 *   because a local catalog cannot validate that daemon-owned identity.
 * - When the RPC succeeds with a valid `{providers, count}` shape, the
 *   array is returned verbatim (the daemon already sorts; we trust it).
 * - When the local fallback runs, the result is deduped and sorted.
 *
 * @returns Provider catalog rows, or `[]` on total failure.
 */
export async function loadProvidersWithFallback(agentId?: string): Promise<ProviderCatalogRow[]> {
  // RPC-first: daemon may have a richer/scanned catalog.
  try {
    // Uses callTyped via ModelsListProvidersContract. The defensive
    // shape-narrowing below remains in place — daemon version skew or
    // future shape changes would surface here, not as a crash.
    const result = await withClient(async (client) =>
      callTyped(client, ModelsListProvidersContract, agentId ? { agentId } : {}),
    );
    if (isValidProvidersResponse(result)) {
      return result.providers;
    }
    // Malformed shape -- fall through to local fallback (defensive).
  } catch (error) {
    if (agentId) throw error;
    // Daemon not running, RPC error, or timeout -- fall through.
  }

  // Local fallback via pi-ai static catalog.
  try {
    const catalog = createModelCatalog();
    catalog.loadStatic();
    const modelCounts = new Map<string, number>();
    for (const entry of catalog.getAll()) {
      modelCounts.set(entry.provider, (modelCounts.get(entry.provider) ?? 0) + 1);
    }
    return [...modelCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, modelCount]) => {
        if (KEYLESS_PROVIDER_TYPES.has(provider)) {
          return {
            provider,
            modelCount,
            status: "keyless" as const,
            credentialSource: "keyless" as const,
          };
        }
        if (getEnvApiKey(provider)) {
          return {
            provider,
            modelCount,
            status: "configured" as const,
            credentialSource: "env_canonical" as const,
          };
        }
        return {
          provider,
          modelCount,
          status: "unknown" as const,
          credentialSource: "daemon_unavailable" as const,
        };
      });
  } catch {
    // Catastrophic failure (rare): pi-ai SDK boot failure or similar.
    // Caller's UX layer reports "no providers" on empty result.
    return [];
  }
}
