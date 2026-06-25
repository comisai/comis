// SPDX-License-Identifier: Apache-2.0
/**
 * RED stress test for {@link normalizeOpeningRequest} (Phase 223, REFLECT-02) —
 * the SYNTH-EMBED-DEAD guard. This is the milestone's concentrated risk: the
 * deterministic `topicKey` REPLACES embedding-cosine clustering. If two genuinely
 * same-topic sessions worded DIFFERENTLY land on DIFFERENT keys, corroboration
 * never reaches >=2 distinct (session,sender) and `admitted:0` persists forever —
 * the exact failure embedding clustering had, now re-lived from the other direction.
 *
 * The four load-bearing properties this suite pins (D-01):
 *  - SAME key for same-topic-differently-worded (order-insensitive token SET; the
 *    collision-maximizing decision — "deploy the app" and "app deploy please" MUST
 *    collide; a token-SEQUENCE hash does NOT).
 *  - DIFFERENT key for genuinely different topics (groups don't over-merge).
 *  - Envelope-stripped: the volatile `[System context]...[End system context]` +
 *    `[telegram] <id> (9:34 AM):` channel header are stripped BEFORE hashing, so the
 *    SAME request at a different time collides (raw-text clustering failed live
 *    2026-06-25 because the per-turn timestamp made identical requests differ).
 *  - Content-light (INV-6): the returned key is a sha256 hex, NEVER the raw
 *    transcript — it must not leak `"deploy"` verbatim into telemetry.
 */
import { describe, it, expect } from "vitest";
import { normalizeOpeningRequest } from "./topic-key.js";

// A representative executor-injected envelope (envelope-wrapper.ts shape): a
// `[System context]` preamble carrying a VOLATILE timestamp, then the channel
// header `[telegram] <id> (<time>):`, then the real user message.
function withEnvelope(message: string, clockLabel: string): string {
  return [
    "[System context]",
    `Current time: ${clockLabel}. You are Comis, a helpful agent.`,
    "[End system context]",
    "",
    `[telegram] 678314278 (${clockLabel}): ${message}`,
  ].join("\n");
}

describe("normalizeOpeningRequest (Phase 223 — the SYNTH-EMBED-DEAD topicKey guard)", () => {
  it("SAME key for the same topic worded differently (order-insensitive token set)", () => {
    // All three are "deploy the app to production"; "please"/"the"/"to" are stopwords,
    // word ORDER differs. A token-SET hash collapses them; a sequence hash would not.
    const a = normalizeOpeningRequest("deploy the app to production");
    const b = normalizeOpeningRequest("please deploy app to prod");
    const c = normalizeOpeningRequest("app deploy to production please");
    // NOTE: "prod" vs "production" intentionally NOT asserted-equal — abbreviation
    // normalization is out of scope; (a) and (c) carry the same {deploy,app,production}
    // token set and MUST collide.
    expect(a).toBe(c);
    expect(a.length).toBeGreaterThan(0);
    // (b) shares deploy+app but says "prod" — it is allowed to differ from (a)/(c);
    // we only pin that wording/order alone (same tokens) collides.
    expect(b.length).toBeGreaterThan(0);
  });

  it("SAME key when only word order and stopwords differ (the core collision claim)", () => {
    const ordered = normalizeOpeningRequest("restart the discord channel now");
    const shuffled = normalizeOpeningRequest("now restart discord channel");
    const padded = normalizeOpeningRequest("please could you restart the discord channel now");
    expect(shuffled).toBe(ordered);
    expect(padded).toBe(ordered);
  });

  it("DIFFERENT key for genuinely different topics (no over-merge)", () => {
    const deploy = normalizeOpeningRequest("deploy the app to production");
    const sales = normalizeOpeningRequest("summarize yesterday's sales report");
    expect(deploy).not.toBe(sales);
  });

  it("envelope-stripped: identical request at DIFFERENT times collides (volatile header never hashed)", () => {
    const morning = normalizeOpeningRequest(withEnvelope("deploy the app", "9:34 AM"));
    const afternoon = normalizeOpeningRequest(withEnvelope("deploy the app", "2:15 PM"));
    expect(morning).toBe(afternoon);
    // And the enveloped form collides with the bare request (the envelope is fully stripped).
    const bare = normalizeOpeningRequest("deploy the app");
    expect(morning).toBe(bare);
  });

  it("content-light (INV-6): the key is a hash, never the raw transcript", () => {
    const key = normalizeOpeningRequest("deploy the app to production");
    expect(key.includes("deploy")).toBe(false);
    expect(key.includes("production")).toBe(false);
    // sha256 hex shape: 64 lowercase hex chars.
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deterministic: the same input returns the identical string across calls", () => {
    const input = "schedule a reminder for the standup";
    expect(normalizeOpeningRequest(input)).toBe(normalizeOpeningRequest(input));
  });

  it("empty / stopword-only input returns a stable, non-throwing ungroupable key", () => {
    // The reflection job treats an empty key as ungroupable (a singleton that can
    // never corroborate) — so degenerate input must NOT throw and must be stable.
    expect(() => normalizeOpeningRequest("")).not.toThrow();
    expect(normalizeOpeningRequest("")).toBe("");
    // A stopword-only request has no content tokens → also empty (ungroupable).
    expect(normalizeOpeningRequest("please could you the a an")).toBe("");
    // Whitespace/punctuation-only collapses to the same empty key.
    expect(normalizeOpeningRequest("   ...!?   ")).toBe("");
  });
});
