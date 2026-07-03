// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-Timeout Redirect WARN: `providers.entries.<id>.timeoutMs`
 * is config-echo only — its sole consumer is the daemon provider-config echo
 * (api/provider-handlers.ts); NO completion path reads it. Wiring it as a real
 * transport timeout would re-introduce a 120s whole-turn race STRICTER than the
 * previously-removed 180s race (the zod default 120_000 is indistinguishable from
 * an operator-set 120_000 post-parse), so the honest fate
 * is: re-document the knob and redirect operators who set it.
 *
 * When an operator sets a non-default value, this module WARNs ONCE per
 * provider per boot, naming the dead key, both numbers, and the knob that
 * actually governs completion deadlines
 * (`agents.<id>.promptTimeout.promptTimeoutMs` — stall budget; makespan =
 * × stallCeilingMultiplier). WARN-only, fail-open: the daemon call site
 * wraps it in try/catch, and the loop is defensive over possibly-undefined
 * entries.
 *
 * Acknowledged limitation: an operator explicitly writing the default value
 * gets no WARN — their value matches behavior-neutral reality, and the schema
 * JSDoc + config-yaml.mdx row no longer lie.
 *
 * Shape: served-window-comparator.ts (once-per-boot-per-provider latch,
 * structural logger, hint with knob names + numbers — never env VALUES).
 *
 * @module
 */

import { PROVIDER_TIMEOUT_MS_DEFAULT } from "@comis/core";

// ---------------------------------------------------------------------------
// Once-per-boot-per-provider WARN latch
// ---------------------------------------------------------------------------

/** Once-per-boot-per-provider WARN latch. Module-level Set — the daemon
 *  process IS the boot (served-window-comparator precedent). */
const redirectWarnLoggedForProvider = new Set<string>();

/** Test-only reset for the module-level latch — without it test order breaks
 *  (resetServedWindowWarnForTest precedent). */
export function resetProviderTimeoutRedirectWarnForTest(): void {
  redirectWarnLoggedForProvider.clear();
}

// ---------------------------------------------------------------------------
// Redirect WARN
// ---------------------------------------------------------------------------

/**
 * WARN once per provider per boot when `providers.entries.<id>.timeoutMs`
 * carries a non-default value — the knob is config-echo only, and the operator
 * almost certainly meant `agents.<id>.promptTimeout.promptTimeoutMs`.
 *
 * Reads ONLY the numeric `timeoutMs` field from each entry (structural input
 * type) — never credentials fields (apiKeyName/headers/baseUrl).
 */
export function warnOnProviderTimeoutRedirect(input: {
  providerEntries: Record<string, { timeoutMs?: number } | undefined>;
  logger: { warn(obj: object, msg: string): void };
}): void {
  for (const [providerId, entry] of Object.entries(input.providerEntries)) {
    const configured = entry?.timeoutMs;
    if (configured === undefined || configured === PROVIDER_TIMEOUT_MS_DEFAULT) continue;
    if (redirectWarnLoggedForProvider.has(providerId)) continue;
    redirectWarnLoggedForProvider.add(providerId);
    input.logger.warn(
      {
        providerId,
        configuredTimeoutMs: configured,
        defaultTimeoutMs: PROVIDER_TIMEOUT_MS_DEFAULT,
        errorKind: "config" as const,
        submodule: "provider-timeout-redirect",
        // Knob NAMES + numbers only — never credential/env VALUES.
        hint:
          `providers.entries.${providerId}.timeoutMs (${String(configured)}) is not enforced on completion calls — ` +
          `the completion deadline is agents.<id>.promptTimeout.promptTimeoutMs (stall budget; ` +
          `makespan = × stallCeilingMultiplier). Remove the provider key or tune the agent knob instead.`,
      },
      "providers.timeoutMs is config-echo only — completion deadline lives on agents.promptTimeout",
    );
  }
}
