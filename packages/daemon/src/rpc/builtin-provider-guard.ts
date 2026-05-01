// SPDX-License-Identifier: Apache-2.0
/**
 * Built-in provider redundancy guard for providers.create (260501-gyy FIX 2).
 *
 * Rejects providers_manage create attempts that would shadow pi-ai's
 * dynamic catalog with a redundant custom entry. A built-in provider
 * (one in pi-ai's getProviders()) already has its full model list
 * available via the catalog -- custom entries are only legitimate for
 * proxies (different baseUrl) or non-SDK providers. Without this guard,
 * an LLM agent that creates a catalog-shadowing entry with a stale or
 * invented model id sets up downstream 404 / "model not found" failures
 * (production: 2026-05-01 08:53-08:54 trace).
 *
 * Generic by construction: rejection message uses ${providerId} +
 * ${apiKeyName} interpolation only -- no per-provider hardcoded names
 * in the source template (catalog-agnostic). Pinned by source-grep
 * regression test in builtin-provider-guard.test.ts.
 *
 * Mirrors credential-resolver.ts shape (260501-2pz precedent).
 *
 * @module
 */
import { getProviders, getModels, type KnownProvider } from "@mariozechner/pi-ai";

export type BuiltInProviderGuardResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Check whether a providers.create call would land a redundant custom
 * entry that shadows pi-ai's dynamic catalog. Returns ok=true when the
 * call is legitimate (genuine custom provider OR proxy with distinct
 * baseUrl), ok=false with an actionable reason otherwise.
 */
export function checkBuiltInProviderRedundancy(
  providerId: string,
  config: { baseUrl?: string; apiKeyName?: string },
): BuiltInProviderGuardResult {
  const native = new Set<string>(getProviders());
  if (!native.has(providerId)) {
    // Genuine custom provider -- never redundant.
    return { ok: true };
  }

  const catalogBaseUrl = getModels(providerId as KnownProvider)[0]?.baseUrl;
  const userBaseUrl = config.baseUrl?.trim();

  if (userBaseUrl && userBaseUrl !== catalogBaseUrl) {
    // Legitimate proxy -- user pointed at a non-catalog URL.
    return { ok: true };
  }

  // Built-in + catalog/absent baseUrl -> redundant.
  return {
    ok: false,
    reason: buildRejectionMessage(providerId, config),
  };
}

function buildRejectionMessage(
  providerId: string,
  config: { apiKeyName?: string },
): string {
  const apiKeyName = config.apiKeyName ?? "<APIKEY_NAME>";
  const lines: string[] = [];
  lines.push(
    `Cannot create custom provider entry for "${providerId}": this provider is built-in to the pi-ai SDK with its full model catalog available dynamically. Custom entries are only needed for proxies (different baseUrl) or non-SDK providers.`,
  );
  lines.push("");
  lines.push("To use this provider:");
  lines.push(`  1. gateway env_set ${apiKeyName}=<your-key>   (find name via gateway env_list)`);
  lines.push(`  2. gateway patch agents.<id>.provider = "${providerId}"`);
  lines.push(`  3. gateway patch agents.<id>.model = "<model-id>"   (find available models via models_manage list provider:${providerId})`);
  lines.push("");
  lines.push(
    `If you intended a custom proxy with a different base URL, supply a distinct provider_id (e.g., "${providerId}-proxy") and your custom baseUrl.`,
  );
  return lines.join("\n");
}
