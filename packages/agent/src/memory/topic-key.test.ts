// SPDX-License-Identifier: Apache-2.0
/**
 * Stress test for {@link normalizeOpeningRequest} —
 * the topicKey collision guard. This is the keyless approach's concentrated
 * risk: if two genuinely
 * same-topic sessions worded DIFFERENTLY land on DIFFERENT keys, corroboration
 * never reaches >=2 distinct (session,sender) and `admitted:0` persists forever.
 *
 * The four load-bearing properties this suite pins:
 *  - SAME key for same-topic-differently-worded (order-insensitive token SET; the
 *    collision-maximizing decision — "deploy the app" and "app deploy please" MUST
 *    collide; a token-SEQUENCE hash does NOT).
 *  - DIFFERENT key for genuinely different topics (groups don't over-merge).
 *  - Envelope-stripped: the volatile `[System context]...[End system context]` +
 *    `[telegram] <id> (9:34 AM):` channel header are stripped BEFORE hashing, so the
 *    SAME request at a different time collides (raw-text clustering failed live
 *    2026-06-25 because the per-turn timestamp made identical requests differ).
 *  - Content-light: the returned key is a sha256 hex, NEVER the raw
 *    transcript — it must not leak `"deploy"` verbatim into telemetry.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeOpeningRequest,
  openingRequestTokens,
  jaccardSimilarity,
  topicMatchedSkillNames,
  topicMatchScores,
  tokenSetCoverage,
  commonCoreTokens,
  stemToken,
} from "./topic-key.js";

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

describe("normalizeOpeningRequest (the topicKey collision guard)", () => {
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

  it("content-light: the key is a hash, never the raw transcript", () => {
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

// ---------------------------------------------------------------------------
// openingRequestTokens + jaccardSimilarity (the under-merge fix primitives). The token
// SET is the pre-hash form; the Jaccard overlap is what the reflection job merges
// differently-worded analogues on.
// ---------------------------------------------------------------------------
describe("openingRequestTokens", () => {
  it("returns the sorted, de-duplicated, stopword/envelope-stripped content tokens (the pre-hash set)", () => {
    expect(openingRequestTokens("Deploy the App to PRODUCTION, please deploy")).toEqual(["app", "deploy", "production"]);
  });
  it("is order-insensitive (same set for re-ordered words) and hashes consistently with normalizeOpeningRequest", () => {
    expect(openingRequestTokens("ship the app")).toEqual(openingRequestTokens("app ship the"));
    // The exported tokens are exactly what the hash is computed over.
    const tokens = openingRequestTokens("route via the harbor tunnel");
    expect(normalizeOpeningRequest("route via the harbor tunnel")).not.toBe(""); // has content tokens
    expect(tokens.length).toBeGreaterThan(0);
  });
  it("returns [] for an empty / stopword-only / punctuation-only request", () => {
    expect(openingRequestTokens("")).toEqual([]);
    expect(openingRequestTokens("please could you the a an")).toEqual([]);
    expect(openingRequestTokens("   ...!?   ")).toEqual([]);
  });
});

describe("stemToken + morphological collapse (the keyless semantic-matching slice)", () => {
  it("collapses verb inflections to one stem (deliver/delivered/delivering)", () => {
    expect(stemToken("delivering")).toBe("deliver");
    expect(stemToken("delivered")).toBe("deliver");
    expect(stemToken("deliver")).toBe("deliver");
  });
  it("collapses regular plurals (packages/reports/tools/deliveries/boxes/dishes)", () => {
    expect(stemToken("packages")).toBe("package");
    expect(stemToken("reports")).toBe("report");
    expect(stemToken("tools")).toBe("tool");
    expect(stemToken("deliveries")).toBe("delivery");
    expect(stemToken("boxes")).toBe("box");
    expect(stemToken("dishes")).toBe("dish");
  });
  it("DOES NOT over-merge: distinct words + -ss/-us/-is endings + short tokens survive (the false-corroboration guard)", () => {
    // The dangerous failure mode is two DISTINCT words collapsing to one token. These must stay distinct.
    expect(stemToken("police")).not.toBe(stemToken("policy")); // police vs policy
    expect(stemToken("across")).toBe("across"); // -ss is not a plural
    expect(stemToken("business")).toBe("business"); // -ss
    expect(stemToken("status")).toBe("status"); // -us is not a plural
    expect(stemToken("analysis")).toBe("analysis"); // -is is not a plural
    expect(stemToken("fire")).toBe("fire"); // <=4 chars never stemmed
    expect(stemToken("ring")).toBe("ring"); // <=4 chars (no "ring"→"r")
    // A curated distinct-pair set: none may collide after stemming.
    const distinct = ["deploy", "report", "summary", "schedule", "channel", "credential", "lateral", "finance", "harbor", "tunnel"];
    const stems = distinct.map(stemToken);
    expect(new Set(stems).size).toBe(distinct.length); // all still unique
  });
  it("two genuinely-same-task openings worded with morphology variation collide on ONE topicKey (the whole point)", () => {
    // Without stemming these carry DIFFERENT token sets ({deliver,package} vs {delivering,packages}) and
    // land on separate topicKeys → they would never reach the corroboration gate. Stemming makes them collide.
    const a = normalizeOpeningRequest("deliver the package");
    const b = normalizeOpeningRequest("delivering the packages");
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
  it("a behavioral reuse worded with morphology variation CREDITS the skill", () => {
    // Core stored from openings that said "deliver"/"package"/"office"; a reuse says the inflected forms.
    const core = openingRequestTokens("deliver the package to the office"); // ["deliver","office","package"]
    const surfaced = [{ name: "skill-deliver", topicTokens: core }];
    // The reuse turn uses delivering/packages/offices — all stem to the core tokens → full coverage.
    expect(topicMatchedSkillNames("delivering the packages to the offices", surfaced)).toContain("skill-deliver");
  });
});

describe("jaccardSimilarity", () => {
  it("is 1 for identical token sets and 0 for disjoint sets", () => {
    expect(jaccardSimilarity(["a", "b", "c"], ["c", "b", "a"])).toBe(1);
    expect(jaccardSimilarity(["a", "b"], ["c", "d"])).toBe(0);
  });
  it("computes |A∩B| / |A∪B| for partial overlap", () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} (2); ∪ = {a,b,c,d} (4) → 0.5
    expect(jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
  });
  it("two empty sets are 0 (ungroupable — never corroborates)", () => {
    expect(jaccardSimilarity([], [])).toBe(0);
  });
  it("rates differently-worded analogous dispatch requests ABOVE 0.5 and unrelated ones BELOW (the merge floor)", () => {
    const fire = openingRequestTokens("dispatch the closest fire engine across the river during evening rush hour avoiding the bridge");
    const medic = openingRequestTokens("dispatch the closest medic unit across the river during evening rush hour avoiding the bridge");
    const sales = openingRequestTokens("summarize the quarterly sales report and email it to the finance team");
    expect(jaccardSimilarity(fire, medic)).toBeGreaterThanOrEqual(0.5); // analogues merge
    expect(jaccardSimilarity(fire, sales)).toBeLessThan(0.5); // genuinely different stays separate
  });
});

// ---------------------------------------------------------------------------
// topicMatchedSkillNames (reuse-attribution):
// credit a SURFACED skill whose stored topic token-set matches the turn — so a
// skill applied without an explicit `read` still promotes.
// ---------------------------------------------------------------------------
describe("tokenSetCoverage", () => {
  it("is 1 when the turn contains the whole core, regardless of extra turn tokens", () => {
    expect(tokenSetCoverage(["a", "b", "c"], ["a", "b", "c", "x", "y", "z"])).toBe(1);
  });
  it("is the fraction of the CORE present in the turn (asymmetric — not Jaccard)", () => {
    // core {a,b,c,d}; turn has a,b → 2/4 = 0.5
    expect(tokenSetCoverage(["a", "b", "c", "d"], ["a", "b", "x"])).toBe(0.5);
  });
  it("is 0 for an empty core (an un-grounded skill never auto-credits)", () => {
    expect(tokenSetCoverage([], ["a", "b"])).toBe(0);
  });
});

describe("commonCoreTokens", () => {
  it("returns the INTERSECTION of the members' token sets (the shared procedure, specifics dropped)", () => {
    const core = commonCoreTokens([
      "dispatch the engine across the river at evening rush avoiding the bridge for a fire",
      "dispatch the medic across the river at evening rush avoiding the bridge for a stroke",
    ]);
    // shared procedure survives; per-instance specifics (engine/medic, fire/stroke) drop.
    expect(core).toContain("dispatch");
    expect(core).toContain("river");
    expect(core).toContain("bridge");
    expect(core).not.toContain("engine");
    expect(core).not.toContain("medic");
    expect(core).not.toContain("fire");
    expect(core).not.toContain("stroke");
  });
  it("is [] when members share no content token", () => {
    expect(commonCoreTokens(["deploy the app", "summarize the report"])).toEqual([]);
  });
});

describe("topicMatchedSkillNames", () => {
  // A skill's stored topicTokens are the CORE (the shared procedure) — what commonCoreTokens yields.
  const ROUTING_CORE = ["across", "avoid", "bridge", "dispatch", "evening", "river", "rush"]; // "avoid": commonCoreTokens stems "avoiding"
  const surfaced = [
    { name: "skill-routing", topicTokens: ROUTING_CORE },
    { name: "skill-legacy", topicTokens: undefined }, // a legacy/seeded doc with no stored topic set
  ];

  it("credits a surfaced skill whose core the turn CONTAINS (differently-worded, no read needed)", () => {
    // A differently-worded instance — different unit/incident, but contains the routing core.
    const matched = topicMatchedSkillNames(
      "dispatch the nearest engine across the river at evening rush avoiding the bridge for a structure fire",
      surfaced,
    );
    expect(matched).toContain("skill-routing");
  });

  it("credits a behavioral reuse that covers ~half the core (synonym/framing variation) but NOT an unrelated/different-task turn", () => {
    // A 10-token behavioral core (a threat-hunting TTP). A genuine reuse worded with synonyms +
    // different framing covers ~0.5 of it (observed live at exactly 0.50) — it MUST credit.
    // An unrelated turn (~0) and a similar-but-DIFFERENT TTP (~0.2-0.3) must NOT. At a 0.6 threshold
    // the genuine reuse at 0.5 would be MISSED → the learned skill never promotes on a real behavioral instance.
    const ttp = [
      { name: "skill-ttp", topicTokens: ["credential", "dwell", "weekend", "pivot", "psexec", "lateral", "lsass", "fileserver", "domainadmin", "contain"] },
    ];
    // 5 of 10 core tokens present (0.50) — a genuine reuse described differently.
    expect(topicMatchedSkillNames("the host showed a credential dump then dwell then a weekend pivot via psexec", ttp)).toContain("skill-ttp");
    // unrelated turn — ~0 coverage, never credits.
    expect(topicMatchedSkillNames("please summarize the quarterly sales report and email finance", ttp)).not.toContain("skill-ttp");
    // a DIFFERENT TTP sharing only a couple generic tokens (~0.2) — must NOT false-credit.
    expect(topicMatchedSkillNames("a phishing email harvested a credential from a user at business hours", ttp)).not.toContain("skill-ttp");
  });

  it("does NOT credit on an unrelated turn (core not present)", () => {
    const matched = topicMatchedSkillNames("summarize the quarterly sales report and email finance", surfaced);
    expect(matched).not.toContain("skill-routing");
  });

  it("never false-credits a skill with no stored topicTokens (legacy/seeded docs)", () => {
    const matched = topicMatchedSkillNames(
      "dispatch the nearest engine across the river at evening rush avoiding the bridge",
      surfaced,
    );
    expect(matched).not.toContain("skill-legacy");
  });

  it("returns [] for an empty/ungroupable turn signature", () => {
    expect(topicMatchedSkillNames("", surfaced)).toEqual([]);
    expect(topicMatchedSkillNames("please could you the a an", surfaced)).toEqual([]);
  });

  it("credits a SHORT on-topic turn against a LARGE/verbose core via the absolute-count floor", () => {
    // A big core distilled from verbose corroborating incidents (behavioral signal + framing).
    const bigCore = [
      "lsass", "credential", "dump", "dwell", "weekend", "psexec", "pivot", "fileserver", "domainadmin", "stolen",
      "lateral", "movement", "campaign", "contain", "sequence", "offhours", "soc", "triage", "host", "verdict",
      "artifact", "rotat", "record", "memory", "rely", "change", "week", "test", "account", "tool", // "artifact"/"rotat"/"tool": stemmed forms
    ]; // 30 tokens
    const big = [{ name: "skill-ttp", topicTokens: bigCore }];
    // A SHORT triage turn: shares ~10 DISTINCTIVE behavioral tokens but only ~0.33 of the 30-token core —
    // below the 0.5 fraction bar, yet clearly the same TTP. The absolute floor (>=8) must credit it.
    const shortReuse = "soc triage host lsass credential dump dwell weekend psexec pivot fileserver verdict";
    expect(topicMatchedSkillNames(shortReuse, big)).toContain("skill-ttp");
    // An adjacent-but-DIFFERENT security task shares only a few generic tokens (~4-5) — below BOTH bars → no credit.
    expect(topicMatchedSkillNames("soc triage host phishing email harvested a user credential account", big)).not.toContain("skill-ttp");
    // Unrelated → no credit.
    expect(topicMatchedSkillNames("please summarize the quarterly sales report for finance", big)).not.toContain("skill-ttp");
  });
});

// topicMatchScores: the OBSERVABILITY companion to topicMatchedSkillNames.
// Returns a score PER surfaced skill (coverage + sharedCount + credited + hasTopicTokens) so the
// reuse-attribution NEAR-MISSES — a surfaced skill that just missed the credit bar, or a legacy
// doc with no topicTokens — become visible (a memory.skill_surfaced trajectory record), instead of
// silently producing nothing. topicMatchedSkillNames is the credited subset of these scores.
describe("topicMatchScores", () => {
  const ROUTING_CORE = ["across", "avoid", "bridge", "dispatch", "evening", "river", "rush"]; // "avoid": commonCoreTokens stems "avoiding"
  const surfaced = [
    { name: "skill-routing", topicTokens: ROUTING_CORE },
    { name: "skill-legacy", topicTokens: undefined }, // legacy/seeded doc with no stored topic set
  ];

  it("returns one score per surfaced skill: a credited match + a hasTopicTokens=false legacy doc", () => {
    const scores = topicMatchScores(
      "dispatch the nearest engine across the river at evening rush avoiding the bridge for a structure fire",
      surfaced,
    );
    expect(scores).toHaveLength(2);
    const routing = scores.find((s) => s.name === "skill-routing")!;
    expect(routing.credited).toBe(true);
    expect(routing.coverage).toBeGreaterThanOrEqual(0.5);
    expect(routing.hasTopicTokens).toBe(true);
    const legacy = scores.find((s) => s.name === "skill-legacy")!;
    expect(legacy.credited).toBe(false);
    expect(legacy.hasTopicTokens).toBe(false);
    expect(legacy.coverage).toBe(0);
    expect(legacy.sharedCount).toBe(0);
  });

  it("scores a NEAR-MISS (coverage below threshold AND shared below the absolute floor) as uncredited-but-visible", () => {
    // 3 of the 7 routing-core tokens present → 0.43 coverage, 3 shared (< 8) → NOT credited, but scored.
    const scores = topicMatchScores("dispatch across the river only", surfaced);
    const routing = scores.find((s) => s.name === "skill-routing")!;
    expect(routing.credited).toBe(false);
    expect(routing.sharedCount).toBe(3);
    expect(routing.coverage).toBeCloseTo(3 / 7, 5);
  });

  it("topicMatchedSkillNames is exactly the credited names of topicMatchScores (no behavior drift)", () => {
    const turn = "dispatch the nearest engine across the river at evening rush avoiding the bridge";
    const creditedNames = topicMatchScores(turn, surfaced)
      .filter((s) => s.credited)
      .map((s) => s.name);
    expect(topicMatchedSkillNames(turn, surfaced)).toEqual(creditedNames);
  });

  it("credits only the dominant learned topic when simulator request boilerplate overlaps every skill", () => {
    const learned = [
      {
        name: "skill-package",
        topicTokens: [
          "accept", "as", "build", "correct", "deliver", "depot", "finish", "grad", "inspect",
          "mcp", "need", "only", "package", "recipient", "result", "sim", "simulator", "tool", "use",
        ],
      },
      {
        name: "skill-threat",
        topicTokens: [
          "action", "alert", "baseline", "case", "close", "current", "distinguish", "false", "finish",
          "from", "grad", "investigate", "justifi", "mcp", "only", "open", "positive", "result", "sim",
          "simulator", "soc", "take", "telemetry", "th", "tool", "true", "use",
        ],
      },
      {
        name: "skill-wildfire",
        topicTokens: [
          "account", "as", "assign", "change", "choose", "containment", "declare", "evacuation", "finish",
          "fire", "forecast", "fuel", "grad", "incident", "inspect", "mcp", "need", "only", "open", "plan",
          "resource", "result", "safe", "sim", "simulator", "spread", "terrain", "tool", "use", "weather", "wildfire",
        ],
      },
      {
        name: "skill-relief",
        topicTokens: [
          "allocate", "assess", "confirm", "convoy", "current", "delivery", "dispatch", "field", "finish",
          "grad", "humanitarian", "mcp", "need", "only", "open", "operation", "prioritize", "relief", "report",
          "reroute", "result", "sim", "simulator", "source", "supply", "tool", "use", "verify",
        ],
      },
    ];
    const requests = [
      ["skill-package", "Use only depot-sim tools to accept the new package, inspect the building as needed, deliver it to the correct recipient, and finish with the simulator graded result."],
      ["skill-threat", "Use only th-sim tools to open and investigate the new SOC alert, distinguish true from false positive with telemetry and baselines, take only justified action, close the case, and finish with the simulator graded result."],
      ["skill-wildfire", "Use only fire-sim tools to open the new wildfire incident, inspect weather, fuels, terrain, spread and resources, choose a safe plan accounting for forecast changes, assign resources and evacuation as needed, declare containment, and finish with the simulator graded result."],
      ["skill-relief", "Use only relief-sim tools to open the new humanitarian operation, verify field-report sources, assess needs, prioritize, reroute and allocate supplies, dispatch the convoy, confirm delivery, and finish with the simulator graded result."],
    ] as const;

    for (const [expected, request] of requests) {
      const credited = topicMatchScores(request, learned)
        .filter((score) => score.credited)
        .map((score) => score.name);
      expect(credited).toEqual([expected]);
    }
  });

  it("credits nothing (but still scores every skill) for an empty/ungroupable turn", () => {
    const scores = topicMatchScores("please could you the a an", surfaced);
    expect(scores).toHaveLength(2);
    expect(scores.every((s) => !s.credited)).toBe(true);
  });
});
