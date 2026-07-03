// SPDX-License-Identifier: Apache-2.0
/**
 * `observability:cache_break → cache.break` trajectory payload translator.
 * Extracted from
 * `translate-payload.ts` to keep that module under the file-size cap (the est-$
 * forward pushed it over) — the same per-event delegation pattern as
 * `translate-image-payload.ts` / `translate-video-payload.ts` etc.
 *
 * CONTENT-FREE (the load-bearing constraint): a closed `reason`,
 * the `tokenDrop` counts, a changed-dims DIGEST (counts only — the
 * toolsAdded/Removed/SchemaChanged NAME arrays are NEVER forwarded), and a
 * COMPUTED `estCostUsd` (a number — the directly-lost cache-read saving, SAME
 * formula as the `obs_diagnostics` row-builder:
 * `tokenDrop × resolveModelPricing(provider, model).cacheRead`; 0 for an unknown
 * model). `provider`/`model` are closed labels (already on the event, already
 * forwarded by the image/vision records), never bodies. Correlation keys
 * (`agentId`/`sessionKey`/`traceId`) are envelope-only and NOT echoed into `data`.
 *
 * @module
 */
import { resolveModelPricing } from "@comis/core";

/** Translate the `observability:cache_break` payload into the `cache.break` data. */
export function translateCacheBreakPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const toLen = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    reason: payload.reason,
    tokenDrop: payload.tokenDrop,
    tokenDropRelative: payload.tokenDropRelative,
    estCostUsd: num(payload.tokenDrop) * resolveModelPricing(str(payload.provider), str(payload.model)).cacheRead,
    changedDimsDigest: {
      added: toLen(payload.toolsAdded),
      removed: toLen(payload.toolsRemoved),
      schemaChanged: toLen(payload.toolsSchemaChanged),
      systemCharDelta: num(payload.systemCharDelta),
    },
  };
}
