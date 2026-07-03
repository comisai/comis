// SPDX-License-Identifier: Apache-2.0
/**
 * Spend kill-switch trajectory payload translators.
 *
 * The three `observability:spend_*` events → `spend.warning` / `spend.exceeded` /
 * `spend.unpriceable` trajectory records. Extracted from `translate-payload.ts` to
 * keep that module under the file-size cap (the spend forward pushed it over) — the
 * same per-event delegation pattern as `translate-cache-break-payload.ts` /
 * `translate-orchestration-payload.ts` etc.
 *
 * CONTENT-FREE (the load-bearing invariant): the closed
 * {@link SpendScopeKind} enum + dollar amounts as NUMBERS + provider/model CONFIG
 * ids ONLY. A message/prompt/query body never crosses the bus on these payloads,
 * so the translator omission is the PRIMARY control (sanitizeForPersistence is a
 * defense-in-depth backstop). Correlation keys (`agentId`/`sessionKey`/`traceId`/
 * `timestamp`) are envelope-only and are NOT echoed into `data` — the recorder
 * envelope carries them via TrajectoryRecorderInit + AsyncLocalStorage.
 *
 * @module
 */

/** The three spend-event names this translator handles. */
type SpendEventName =
  | "observability:spend_warning"
  | "observability:spend_exceeded"
  | "observability:spend_unpriceable";

/**
 * Translate one `observability:spend_*` payload into its trajectory `data`.
 * Forwards the scope enum + dollar numbers (warning/exceeded) or the provider/
 * model config ids (unpriceable) ONLY; the envelope correlation keys are stripped.
 */
export function translateSpendPayload(
  eventName: SpendEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    case "observability:spend_warning":
      return {
        scope: payload.scope,
        spentUsd: payload.spentUsd,
        capUsd: payload.capUsd,
        fraction: payload.fraction,
      };
    case "observability:spend_exceeded":
      return {
        scope: payload.scope,
        spentUsd: payload.spentUsd,
        capUsd: payload.capUsd,
        estUsd: payload.estUsd,
      };
    case "observability:spend_unpriceable":
      // provider/model are config ids (a model id is a config value, NOT user
      // content — the events-agent.ts spend_unpriceable doc), forwarded so the
      // explain timeline can name an unpriceable model (one with no known pricing).
      return {
        provider: payload.provider,
        model: payload.model,
      };
  }
}
