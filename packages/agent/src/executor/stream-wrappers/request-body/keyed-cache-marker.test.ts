// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for translating placed cache markers into the keyed provider's own marker block.
 *
 * On a `type`-discriminated provider a breakpoint is a `cache_control` PROPERTY on a content block.
 * The keyed (Bedrock Converse) provider has no such property — its marker is a separate
 * `{cachePoint}` BLOCK — so every marker this pipeline placed was silently discarded by the
 * serializer, leaving only the single marker the SDK appends to the last user message.
 */
import { describe, it, expect } from "vitest";

import { KEYED_MAX_CACHE_MARKERS, translateKeyedCacheMarkers } from "./keyed-cache-marker.js";

const keyedUser = (text: string, marked = false) => ({
  role: "user",
  content: [marked ? { text, cache_control: { type: "ephemeral" } } : { text }],
});
const typedUser = (text: string, marked = false) => ({
  role: "user",
  content: [marked ? { type: "text", text, cache_control: { type: "ephemeral" } } : { type: "text", text }],
});

const cachePointCount = (messages: Array<Record<string, unknown>>): number =>
  messages.reduce((n, m) => n + (Array.isArray(m.content)
    ? (m.content as Array<Record<string, unknown>>).filter(b => b.cachePoint !== undefined).length
    : 0), 0);

const hasCacheControl = (messages: Array<Record<string, unknown>>): boolean =>
  messages.some(m => Array.isArray(m.content)
    && (m.content as Array<Record<string, unknown>>).some(b => b.cache_control !== undefined));

describe("translateKeyedCacheMarkers", () => {
  it("converts a placed marker on a keyed message into a cachePoint block", () => {
    const messages = [keyedUser("q1", true), keyedUser("q2")];

    const result = translateKeyedCacheMarkers(messages);
    expect(result.converted).toBe(1);
    expect(messages[0]!.content).toEqual([{ text: "q1" }, { cachePoint: { type: "default" } }]);
    // The property is meaningless on this provider and must not ride along.
    expect(hasCacheControl(messages)).toBe(false);
  });

  it("carries the long-retention TTL onto the cachePoint", () => {
    const messages = [{
      role: "user",
      content: [{ text: "q" }, { text: "r", cache_control: { type: "ephemeral", ttl: "1h" } }],
    }];

    translateKeyedCacheMarkers(messages);
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks[blocks.length - 1]).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
  });

  it("never exceeds the provider's per-request marker limit, counting markers already present", () => {
    // The SDK appends its own cachePoint to the last user message before this runs, so the budget
    // must account for it — overshooting the limit is a hard request rejection, not a lost hit.
    const messages: Array<Record<string, unknown>> = [
      keyedUser("a", true), keyedUser("b", true), keyedUser("c", true),
      keyedUser("d", true), keyedUser("e", true),
      { role: "user", content: [{ text: "latest" }, { cachePoint: { type: "default" } }] },
    ];

    const result = translateKeyedCacheMarkers(messages);
    expect(cachePointCount(messages)).toBeLessThanOrEqual(KEYED_MAX_CACHE_MARKERS);
    expect(result.converted).toBe(KEYED_MAX_CACHE_MARKERS - 1);
    // Markers it could not afford are dropped, not left as dead properties.
    expect(result.dropped).toBeGreaterThan(0);
    expect(hasCacheControl(messages)).toBe(false);
  });

  it("prefers the newest markers when the budget cannot cover them all", () => {
    const messages = [keyedUser("oldest", true), keyedUser("newest", true)];

    // Budget of one: the newest boundary is the one worth keeping.
    translateKeyedCacheMarkers(messages, 1);
    expect(messages[1]!.content).toContainEqual({ cachePoint: { type: "default" } });
    expect(messages[0]!.content).toEqual([{ text: "oldest" }]);
  });

  it("leaves a type-discriminated payload completely untouched", () => {
    const messages = [typedUser("q1", true), typedUser("q2")];
    const before = structuredClone(messages);

    const result = translateKeyedCacheMarkers(messages);
    expect(result.converted).toBe(0);
    expect(messages).toEqual(before);
  });

  it("does not double-mark a keyed message that already carries a cachePoint", () => {
    const messages = [{
      role: "user",
      content: [{ text: "q", cache_control: { type: "ephemeral" } }, { cachePoint: { type: "default" } }],
    }];

    const result = translateKeyedCacheMarkers(messages);
    expect(result.converted).toBe(0);
    expect(cachePointCount(messages)).toBe(1);
    expect(hasCacheControl(messages)).toBe(false);
  });

  it("returns zero on a non-array payload rather than throwing", () => {
    expect(translateKeyedCacheMarkers(undefined as never).converted).toBe(0);
  });
});
