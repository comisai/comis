// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for attributeRecallUsage() — the pure overlap heuristic that
 * partitions recalled memories into {used, ignored} from the agent's response.
 *
 * Load-bearing RED-first assertions (mirror score.test.ts determinism style):
 * - empty response → every recalled id is ignored (overlap 0)
 * - empty recalled → empty partition { usedIds: [], ignoredIds: [] }
 * - a memory whose content is echoed verbatim in the response → used
 * - a memory sharing ONLY stopwords with the response → ignored (the
 *   content-word/bigram filter cuts the "shared common word" false positive)
 * - determinism: same inputs → identical output across two calls (no clock,
 *   no random — the fn takes no time arg)
 * - partition invariant: usedIds.length + ignoredIds.length === recalled.length
 *
 * Pure function — no I/O, no Result, no clock. Imports the in-package fn only.
 */

import { describe, it, expect } from "vitest";
import { attributeRecallUsage } from "./recall-attribution.js";

describe("attributeRecallUsage — overlap heuristic partition", () => {
  it("returns an empty partition for empty recalled input", () => {
    const out = attributeRecallUsage([], "any response text here");
    expect(out.usedIds).toEqual([]);
    expect(out.ignoredIds).toEqual([]);
  });

  it("ignores every recalled memory when the response is empty", () => {
    const recalled = [
      { id: "m1", content: "the database migration ran successfully last tuesday" },
      { id: "m2", content: "alice prefers dark mode in the dashboard" },
    ];
    const out = attributeRecallUsage(recalled, "");
    expect(out.usedIds).toEqual([]);
    expect(out.ignoredIds).toEqual(["m1", "m2"]);
  });

  it("ignores every recalled memory when the response is whitespace only", () => {
    const recalled = [{ id: "m1", content: "kubernetes cluster autoscaling threshold is seventy percent" }];
    const out = attributeRecallUsage(recalled, "   \n\t  ");
    expect(out.usedIds).toEqual([]);
    expect(out.ignoredIds).toEqual(["m1"]);
  });

  it("marks a memory USED when its content is echoed in the response", () => {
    const recalled = [
      { id: "echoed", content: "the deployment pipeline uses blue-green rollout with canary checks" },
    ];
    const response =
      "As you mentioned, the deployment pipeline uses blue-green rollout with canary checks, so we are safe.";
    const out = attributeRecallUsage(recalled, response);
    expect(out.usedIds).toContain("echoed");
    expect(out.ignoredIds).not.toContain("echoed");
  });

  it("ignores a memory that shares ONLY stopwords with the response", () => {
    // content significant terms (after stopword strip): none — "the a of and" are all stopwords.
    // To make the denominator non-zero with a real content word we add one rare word that is
    // ABSENT from the response, so overlap stays 0 → ignored (no false positive from stopwords).
    const recalled = [{ id: "stop", content: "the a of and zephyrium" }];
    const response = "the of and a the of"; // only stopwords; "zephyrium" never appears
    const out = attributeRecallUsage(recalled, response);
    expect(out.ignoredIds).toContain("stop");
    expect(out.usedIds).not.toContain("stop");
  });

  it("is deterministic — identical inputs produce identical output across calls", () => {
    const recalled = [
      { id: "m1", content: "the quarterly revenue forecast was revised upward in march" },
      { id: "m2", content: "an unrelated note about coffee preferences" },
    ];
    const response = "the quarterly revenue forecast was revised upward in march per finance";
    const a = attributeRecallUsage(recalled, response);
    const b = attributeRecallUsage(recalled, response);
    expect(a).toEqual(b);
  });

  it("partitions a mixed set: 1 echoed used + 2 unrelated ignored (partition invariant holds)", () => {
    const recalled = [
      { id: "hit", content: "the staging environment runs on port eight thousand eighty" },
      { id: "miss1", content: "favourite dessert is tiramisu with espresso" },
      { id: "miss2", content: "the cat sat quietly on the warm windowsill" },
    ];
    const response =
      "Right — the staging environment runs on port eight thousand eighty, I'll connect there now.";
    const out = attributeRecallUsage(recalled, response);
    expect(out.usedIds).toContain("hit");
    expect(out.ignoredIds).toContain("miss1");
    expect(out.ignoredIds).toContain("miss2");
    // Partition invariant: every recalled id lands in exactly one bucket.
    expect(out.usedIds.length + out.ignoredIds.length).toBe(recalled.length);
    const all = [...out.usedIds, ...out.ignoredIds].sort();
    expect(all).toEqual(["hit", "miss1", "miss2"]);
  });

  it("respects a stricter minOverlap threshold (opts override)", () => {
    // A partial-overlap memory: shares a couple of content words but not the bulk.
    const recalled = [
      { id: "partial", content: "the migration script backfills user avatars and resizes thumbnails nightly" },
    ];
    // Response shares only "migration" + "script" — a low fraction of the memory's content terms.
    const response = "I ran a quick migration script on my laptop for an unrelated demo.";
    const lenient = attributeRecallUsage(recalled, response, { minOverlap: 0.1 });
    const strict = attributeRecallUsage(recalled, response, { minOverlap: 0.9 });
    // Under a very strict threshold the partial overlap is NOT enough → ignored.
    expect(strict.ignoredIds).toContain("partial");
    // Sanity: the lenient threshold partitions the same single id into exactly one bucket.
    expect(lenient.usedIds.length + lenient.ignoredIds.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// OBS-01 / Phase 180 — de-Anglicization (RED on pre-patch code).
//
// Pre-patch the tokenizer is `.toLowerCase().replace(/[^a-z0-9]+/g, " ")` — every
// non-ASCII letter is stripped to whitespace, so a Hebrew/Arabic/Cyrillic memory
// and an overlapping non-Latin response BOTH tokenize to nothing. denom === 0 →
// the memory is forced into `ignoredIds` (the zero-denominator guard), so its
// attribution is PERMANENTLY 0 regardless of how much real content overlaps.
// Every non-Latin case below asserts the memory is USED — each FAILS on the
// pre-patch tokenizer and flips GREEN once the split becomes Unicode-aware.
//
// The Latin byte-identity case + the Latin-gated stopword case pin I1: the fix
// must NOT move any pure-ASCII result and must keep STOPWORDS filtering Latin
// tokens only (a non-Latin token that transliterates near a stopword survives).
// ---------------------------------------------------------------------------

describe("attributeRecallUsage — de-Anglicization (non-Latin scripts, OBS-01)", () => {
  it("scores a Hebrew memory overlapping a Hebrew response > 0 (USED) — RED: 0 pre-patch", () => {
    // Two-word Hebrew phrase shared verbatim → significant unigrams + a bigram overlap.
    const recalled = [{ id: "he", content: "הספרייה הלאומית פתוחה היום" }];
    const response = "כן, הספרייה הלאומית פתוחה היום עד שש בערב.";
    const out = attributeRecallUsage(recalled, response);
    expect(out.usedIds).toContain("he");
    expect(out.ignoredIds).not.toContain("he");
  });

  it("scores an Arabic memory overlapping an Arabic response > 0 (USED) — RED: 0 pre-patch", () => {
    const recalled = [{ id: "ar", content: "المكتبة الوطنية مفتوحة اليوم" }];
    const response = "نعم، المكتبة الوطنية مفتوحة اليوم حتى المساء.";
    const out = attributeRecallUsage(recalled, response);
    expect(out.usedIds).toContain("ar");
    expect(out.ignoredIds).not.toContain("ar");
  });

  it("scores a Cyrillic memory overlapping a Cyrillic response > 0 (USED) — RED: 0 pre-patch", () => {
    const recalled = [{ id: "ru", content: "национальная библиотека сегодня открыта" }];
    const response = "Да, национальная библиотека сегодня открыта до вечера.";
    const out = attributeRecallUsage(recalled, response);
    expect(out.usedIds).toContain("ru");
    expect(out.ignoredIds).not.toContain("ru");
  });

  it("produces a bigram for a space-delimited two-word Hebrew phrase (phrase structure preserved)", () => {
    // A memory whose ONLY signal is a shared two-word phrase: the bigram axis must
    // fire for non-Latin tokens exactly as it does for Latin ones. Pre-patch the
    // phrase tokenizes to nothing → no bigram → ignored.
    const recalled = [{ id: "phrase", content: "ספרייה לאומית" }];
    const response = "ביקרנו אתמול בספרייה לאומית גדולה מאוד.";
    const out = attributeRecallUsage(recalled, response);
    expect(out.usedIds).toContain("phrase");
  });

  it("does NOT filter a non-Latin token even when it collides with a Latin stopword spelling (stopword gate is Latin-only)", () => {
    // STOPWORDS holds ASCII "is"/"it"/"on" etc. A non-Latin token must never be
    // dropped by that English set — gate it behind a Latin-script test. A Cyrillic
    // memory whose tokens are short stays attributable (its tokens are significant,
    // not stopwords), so overlap with the echoed response is > 0.
    const recalled = [{ id: "cyr-short", content: "это новая политика безопасности" }];
    const response = "Подтверждаю: это новая политика безопасности с сегодняшнего дня.";
    const out = attributeRecallUsage(recalled, response);
    expect(out.usedIds).toContain("cyr-short");
  });
});

describe("attributeRecallUsage — pure-ASCII byte identity (I1)", () => {
  it("produces a frozen partition for a pure-ASCII corpus (the de-Anglicization is a no-op for ASCII)", () => {
    // I1 pin: an English-only deployment must be UNCHANGED. This case is explicit
    // (not just the inherited cases above) so the de-Anglicization is provably a
    // no-op for ASCII. Mixed used/ignored exercises both buckets + the bigram axis.
    const recalled = [
      { id: "u1", content: "the nightly backup job writes to the offsite bucket at midnight" },
      { id: "i1", content: "an unrelated note about espresso roast preferences" },
      { id: "u2", content: "rate limiting is enforced at one hundred requests per minute" },
    ];
    const response =
      "Confirmed — the nightly backup job writes to the offsite bucket at midnight, and rate limiting is enforced at one hundred requests per minute.";
    const out = attributeRecallUsage(recalled, response);
    // Exact partition (the byte-identity baseline — frozen for I1).
    expect(out.usedIds).toEqual(["u1", "u2"]);
    expect(out.ignoredIds).toEqual(["i1"]);
  });
});
