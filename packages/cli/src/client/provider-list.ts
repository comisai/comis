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

import { withClient } from "./rpc-client.js";
import { createModelCatalog } from "@comis/agent";

/**
 * Defensive shape narrowing for the daemon RPC response.
 *
 * The daemon's `models.list_providers` handler is expected to return
 * `{ providers: string[]; count: number }` (verified in
 * `packages/daemon/src/rpc/model-handlers.ts:99-106`). We narrow at the
 * call site so a malformed response (e.g., daemon version skew, future
 * shape change) cannot crash the wizard.
 */
function isValidProvidersResponse(value: unknown): value is { providers: string[] } {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { providers?: unknown };
  if (!Array.isArray(candidate.providers)) return false;
  return candidate.providers.every((p) => typeof p === "string");
}

/**
 * Load the catalog provider list, preferring the daemon RPC and falling
 * back to the local pi-ai catalog when the daemon is unreachable.
 *
 * Contract:
 * - Returns `string[]` (the provider IDs).
 * - Never throws. All error paths are caught internally; the worst-case
 *   return is `[]`, which callers translate into a "no providers" UX.
 * - When the RPC succeeds with a valid `{providers, count}` shape, the
 *   array is returned verbatim (the daemon already sorts; we trust it).
 * - When the local fallback runs, the result is deduped and sorted.
 *
 * @returns A list of provider IDs from the catalog, or `[]` on total
 *   failure.
 */
export async function loadProvidersWithFallback(): Promise<string[]> {
  // RPC-first: daemon may have a richer/scanned catalog.
  try {
    const result = await withClient(async (client) =>
      client.call("models.list_providers", {}),
    );
    if (isValidProvidersResponse(result)) {
      return result.providers;
    }
    // Malformed shape -- fall through to local fallback (defensive).
  } catch {
    // Daemon not running, RPC error, or timeout -- fall through.
  }

  // Local fallback via pi-ai static catalog.
  try {
    const catalog = createModelCatalog();
    catalog.loadStatic();
    const providers = [...new Set(catalog.getAll().map((e) => e.provider))].sort();
    return providers;
  } catch {
    // Catastrophic failure (rare): pi-ai SDK boot failure or similar.
    // Caller's UX layer reports "no providers" on empty result.
    return [];
  }
}
