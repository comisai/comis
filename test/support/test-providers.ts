// SPDX-License-Identifier: Apache-2.0
/**
 * Parser for the COMIS_E2E_TEST_PROVIDERS env var.
 *
 * Format: comma-separated list, e.g., "openai-codex,anthropic,google".
 * Returns an empty array when unset -- callers use `length > 0` for skip-gating
 * via `describe.skipIf(!parseTestProviders().length)`.
 *
 * The env var name and format are documented in
 * packages/agent/src/__tests__/fixtures/phase-8-skill-variants/README.md
 * (cost / latency implications for developers running locally).
 *
 * Top-level entry-point exception applies (AGENTS.md §2.2): test fault injectors
 * may read process.env directly. This helper is the canonical injection surface
 * for the provider-gated suite.
 *
 * @module
 */

/**
 * Returns the list of providers requested by the developer for the
 * provider-gated behavioral metric suite. Empty array means "skip the suite".
 */
export function parseTestProviders(): string[] {
  return (
    process.env["COMIS_E2E_TEST_PROVIDERS"]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

/**
 * Default rounds-per-provider for the behavioral metric suite (cost guardrail).
 */
export const DEFAULT_ROUNDS_PER_PROVIDER = 10;

/**
 * Returns the configured number of rounds per provider for the behavioral
 * metric suite. Defaults to DEFAULT_ROUNDS_PER_PROVIDER.
 * Override via COMIS_E2E_TEST_ROUNDS=<positive-int>.
 *
 * Invalid values (non-numeric, zero, negative, NaN) silently fall back to the
 * default rather than failing the suite -- the env var is operator convenience,
 * not a contract surface.
 */
export function parseRoundsPerProvider(): number {
  const raw = process.env["COMIS_E2E_TEST_ROUNDS"];
  if (raw === undefined || raw === "") return DEFAULT_ROUNDS_PER_PROVIDER;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROUNDS_PER_PROVIDER;
  return n;
}
