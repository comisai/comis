// SPDX-License-Identifier: Apache-2.0
/**
 * Translate placed cache breakpoints into the keyed provider's own marker block.
 *
 * A breakpoint is expressed differently by the two wire shapes this pipeline serves:
 *
 *  - **`type`-discriminated** (Anthropic Messages): a `cache_control` PROPERTY on a content block.
 *  - **keyed** (Bedrock Converse): a separate `{cachePoint}` BLOCK in the content array. There is no
 *    `cache_control` member at all, so the property is dropped during serialization.
 *
 * Every breakpoint this pipeline placed on a keyed payload was therefore discarded silently, leaving
 * only the single marker the SDK appends to the last user message. The multi-zone budget and strategy
 * ran, reported a fence, and bought nothing — a lost optimisation rather than an outage, which is why
 * it stayed invisible.
 *
 * Runs as ONE post-pass over the finished payload rather than inside the per-message placement
 * helper. That is deliberate: the provider caps markers PER REQUEST, and the SDK has already spent
 * one before this code sees the messages, so the budget can only be enforced where the whole payload
 * is in scope. Overshooting the cap is a hard request rejection, not a missed cache hit, so the
 * budget is counted from what is actually present and unaffordable markers are DROPPED — never left
 * behind as a dead `cache_control` property.
 *
 * Conversion runs newest-first: when the budget cannot cover every placed marker, the boundaries
 * closest to the tail are the ones worth keeping.
 *
 * @module
 */

/** Markers a single Bedrock Converse request may carry, including any the SDK placed. */
export const KEYED_MAX_CACHE_MARKERS = 4;

/** Outcome of the translation pass, for the caller's DEBUG line. */
export interface KeyedCacheMarkerResult {
  /** Placed markers turned into a `{cachePoint}` block. */
  converted: number;
  /** Placed markers the per-request budget could not afford, removed rather than left dead. */
  dropped: number;
}

function contentOf(message: unknown): Array<Record<string, unknown>> | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content as Array<Record<string, unknown>> : undefined;
}

/** True when a block belongs to the keyed shape: no string `type`, but a recognised member. */
function isKeyedBlock(block: Record<string, unknown>): boolean {
  if (typeof block.type === "string") return false;
  return block.text !== undefined
    || block.toolUse !== undefined
    || block.toolResult !== undefined
    || block.reasoningContent !== undefined
    || block.cachePoint !== undefined
    || block.image !== undefined;
}

/** Strip the inert property and report the retention it carried, if any. */
function takeCacheControl(block: Record<string, unknown>): { ttl?: string } | undefined {
  const marker = block.cache_control;
  if (marker === undefined) return undefined;
  delete block.cache_control;
  const ttl = (marker as { ttl?: unknown } | null)?.ttl;
  return typeof ttl === "string" ? { ttl } : {};
}

/**
 * Positions of every `{cachePoint}` marker in the finished payload — `[messageIndex, blockIndex]`
 * pairs, bounded to the first eight. Indices only, no content: the keyed provider hard-rejects a
 * request whose marker has nothing cacheable before it, and diagnosing that rejection requires
 * knowing WHERE the markers sat, which counts alone cannot say.
 */
export function findCachePointPositions(
  messages: Array<Record<string, unknown>>,
): Array<[number, number]> {
  const positions: Array<[number, number]> = [];
  for (let i = 0; i < messages.length && positions.length < 8; i++) {
    const content = contentOf(messages[i]!);
    if (content === undefined) continue;
    for (let j = 0; j < content.length; j++) {
      if (content[j]!.cachePoint !== undefined) {
        positions.push([i, j]);
        if (positions.length >= 8) break;
      }
    }
  }
  return positions;
}

/**
 * Role + block-kind skeleton of the payload tail — the last `count` messages as
 * `"<index>:<role>[<kind>,<kind>,…]"`, kinds resolved by the block key or `type`. Structure only,
 * never content: a marker rejection is decided by what SURROUNDS the marker, and positions alone
 * cannot show an empty message or a marker-only content array.
 */
export function describePayloadTail(
  messages: Array<Record<string, unknown>>,
  count = 6,
): string[] {
  const start = Math.max(0, messages.length - count);
  const out: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const msg = messages[i]!;
    const content = contentOf(msg);
    const kinds = content === undefined
      ? (typeof msg.content === "string" ? ["string"] : ["none"])
      : content.map((b) => {
        if (typeof b.type === "string") return b.type;
        const key = Object.keys(b).find((k) => b[k] !== undefined);
        return key ?? "empty";
      });
    out.push(`${i}:${String(msg.role)}[${kinds.join(",")}]`);
  }
  return out;
}

/**
 * Convert every `cache_control` property on a keyed payload into a `{cachePoint}` block, bounded by
 * the per-request marker cap.
 *
 * A `type`-discriminated payload is left untouched — the property IS the marker there.
 *
 * @param messages - the finished request messages (mutated in place)
 * @param maxMarkers - per-request marker cap; defaults to {@link KEYED_MAX_CACHE_MARKERS}
 */
export function translateKeyedCacheMarkers(
  messages: Array<Record<string, unknown>>,
  maxMarkers: number = KEYED_MAX_CACHE_MARKERS,
): KeyedCacheMarkerResult {
  if (!Array.isArray(messages)) return { converted: 0, dropped: 0 };

  // Only act on a payload that actually uses the keyed shape.
  const keyed = messages.some(m => contentOf(m)?.some(isKeyedBlock) === true);
  if (!keyed) return { converted: 0, dropped: 0 };

  // Markers already present — the SDK appends its own before this runs, and it counts against the cap.
  let spent = 0;
  for (const message of messages) {
    for (const block of contentOf(message) ?? []) {
      if (block.cachePoint !== undefined) spent++;
    }
  }

  let converted = 0;
  let dropped = 0;
  // Newest-first: the tail boundaries are the valuable ones when the budget runs short.
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = contentOf(messages[i]!);
    if (content === undefined) continue;

    let retention: { ttl?: string } | undefined;
    for (const block of content) {
      const taken = takeCacheControl(block);
      // A message may carry the property on more than one block; the last one wins, matching the
      // placement helper's own "mark the last cacheable block" rule.
      if (taken !== undefined) retention = taken;
    }
    if (retention === undefined) continue;

    if (content.some(b => b.cachePoint !== undefined)) continue; // already marked — never double-mark
    if (spent >= maxMarkers) { dropped++; continue; }

    content.push({ cachePoint: { type: "default", ...(retention.ttl !== undefined ? { ttl: retention.ttl } : {}) } });
    spent++;
    converted++;
  }

  return { converted, dropped };
}
