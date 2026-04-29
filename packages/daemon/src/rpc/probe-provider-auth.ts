// SPDX-License-Identifier: Apache-2.0
/**
 * Lightweight HTTP probe to validate a provider API key before committing
 * the provider config to config.yaml.
 *
 * Design:
 * - Only 401/403 are treated as definitive auth failures (block config commit).
 * - 5xx, network errors, and timeouts are treated as transient — they return
 *   ok() so they do NOT block config changes.
 * - Empty baseUrl or apiKey short-circuits to ok() (nothing to probe).
 * - Uses AbortSignal.timeout to cap probe duration (default 5 s).
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Probe a provider endpoint to verify the API key is accepted.
 *
 * @param baseUrl  - Provider API base URL (e.g. "https://api.openai.com/v1")
 * @param apiKey   - The secret API key value
 * @param timeoutMs - Maximum probe duration in milliseconds (default 5000)
 * @returns ok(undefined) if the key appears valid or the check is inconclusive;
 *          err(string) if the provider explicitly rejected the key (401/403).
 */
export async function probeProviderAuth(
  baseUrl: string,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Result<void, string>> {
  if (!baseUrl || !apiKey) return ok(undefined);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network error or timeout — do not block config changes for transient issues
    return ok(undefined);
  }

  if (response.status === 401 || response.status === 403) {
    return err(
      `API key rejected by provider (HTTP ${response.status}). ` +
      `Verify the key is correct and has not expired.`,
    );
  }

  return ok(undefined);
}
