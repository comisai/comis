// SPDX-License-Identifier: Apache-2.0
/**
 * Provider listing CLI command.
 *
 * Provides `comis providers list` for browsing available providers from
 * the live pi-ai catalog (with daemon RPC + local fallback). Status
 * column indicates whether a provider's API key is resolvable from the
 * env (mirrors credential-resolver.ts Source B semantics from
 * 260501-2pz).
 *
 * Mirrors `commands/models.ts` shape -- RPC-first, local catalog
 * fallback, `--format` flag, no `set` subcommand (provider switching
 * goes through `comis agent configure --provider X`).
 *
 * @module
 */

import type { Command } from "commander";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import { withClient } from "../client/rpc-client.js";
import { loadProvidersWithFallback } from "../client/provider-list.js";
import { createModelCatalog } from "@comis/agent";
import type { CatalogEntry } from "@comis/agent";
import { error, info, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable } from "../output/table.js";

/**
 * Provider IDs that don't need an API key.
 *
 * Mirrors `credential-resolver.ts:25 KEYLESS_PROVIDER_TYPES`. Kept as
 * an independent set here because the CLI's status-column logic must
 * answer "is this keyless?" without booting the full credential-
 * resolver dep graph.
 */
const KEYLESS_PROVIDERS = new Set<string>(["ollama", "lm-studio"]);

/**
 * Load the model count for a single provider via RPC, falling back to
 * the local catalog. Returns 0 if neither source resolves.
 *
 * Mirrors `commands/models.ts:62-83 loadModels()` shape -- same
 * try/catch ladder, same defensive `Array.isArray` narrow.
 */
async function getModelCount(provider: string): Promise<number> {
  try {
    const result = await withClient(async (client) => {
      return (await client.call("models.list", { provider })) as CatalogEntry[];
    });
    if (Array.isArray(result)) return result.length;
  } catch {
    // Daemon not running -- fall through to local catalog.
  }
  try {
    const catalog = createModelCatalog();
    catalog.loadStatic();
    return catalog.getByProvider(provider).length;
  } catch {
    return 0;
  }
}

/**
 * Resolve the Status column value for a provider.
 *
 * - `keyless`     : provider is in `KEYLESS_PROVIDERS` (ollama, lm-studio)
 * - `configured`  : pi-ai's `getEnvApiKey` resolves a non-empty key
 * - `missing key` : no env key found
 *
 * Mirrors `credential-resolver.ts` Source B semantics from 260501-2pz.
 * Status reflects only env-key presence; it does NOT include the key
 * value itself (T-260501-kqq-02 information-disclosure threat).
 */
function getProviderStatus(
  provider: string,
): "keyless" | "configured" | "missing key" {
  if (KEYLESS_PROVIDERS.has(provider)) return "keyless";
  const key = getEnvApiKey(provider);
  return key && key.length > 0 ? "configured" : "missing key";
}

/**
 * Register the `providers` command group on the program.
 *
 * Provides:
 * - `comis providers list` -- browse available providers
 *
 * @param program - The root Commander program
 */
export function registerProvidersCommand(program: Command): void {
  const providers = program
    .command("providers")
    .description("Provider management");

  providers
    .command("list")
    .description("List available providers from the catalog")
    .option("--format <format>", 'Output format: "table" or "json"', "table")
    .action(async (options: { format: string }) => {
      try {
        const ids = await withSpinner("Loading providers...", () =>
          loadProvidersWithFallback(),
        );

        if (ids.length === 0) {
          info("No providers found in catalog");
          return;
        }

        // Sequentially fetch model counts. With ~11-23 providers this
        // is acceptable (single-digit RPC roundtrips). N+1 batching is
        // a v1.5 enhancement (T-260501-kqq-03 DoS disposition: accept).
        const rows: Array<{
          provider: string;
          modelCount: number;
          status: string;
        }> = [];
        for (const id of ids) {
          const modelCount = await getModelCount(id);
          const status = getProviderStatus(id);
          rows.push({ provider: id, modelCount, status });
        }

        if (options.format === "json") {
          json(rows);
          return;
        }

        renderTable(
          ["Provider", "Models", "Status"],
          rows.map((r) => [r.provider, String(r.modelCount), r.status]),
        );

        info(
          `${rows.length} provider${rows.length !== 1 ? "s" : ""} listed`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to list providers: ${msg}`);
        process.exit(1);
      }
    });
}
