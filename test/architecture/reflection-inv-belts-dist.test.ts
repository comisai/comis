// SPDX-License-Identifier: Apache-2.0
/**
 * ARCHITECTURE — Phase 227 / D-02 (ACCEPT-01): the six reflection-engine security
 * invariants (INV-1..6) re-verified on the DEPLOYED DIST — the compiled
 * `packages/<pkg>/dist/<file>.js` (and the `.d.ts` for the type-only event
 * contract), NOT src. The source-level belts are reflection-no-exec-guard.test.ts
 * (INV-3) + the per-phase verifiers; this pins them on the built output the operator
 * ships (the milestone belt-and-suspenders over the per-phase source belts).
 *
 * ## Why dist, not src
 *
 * The per-phase verifiers asserted these invariants on the SOURCE. A build step can
 * (in principle) drop, inline, or transform a guard. This belt reads the COMPILED
 * artifacts — the exact bytes `npm install -g comisai` ships — so a guard that
 * survives in src but is lost in the build trips here.
 *
 * ## RED-provable + non-vacuity
 *
 * `readFileSync` throws at MODULE scope if a scanned dist artifact is missing → the
 * suite fails (the pre-build / moved-artifact failing state; this belt REQUIRES a
 * prior `pnpm build`). Each `it` ALSO asserts a non-vacuity ANCHOR token: a present-
 * token check so a moved/renamed/empty artifact FAILS rather than vacuously passing
 * an absence-assertion. (Verified RED-provable during authoring: temporarily renaming
 * a dist constant path makes the corresponding `it` fail at readFileSync; restored.)
 *
 * ## The comment-strip discipline (not self-invalidating)
 *
 * Mirrors reflection-no-exec-guard.test.ts: `stripCommentsOnly` removes line + block
 * comments BEFORE the scan but KEEPS string/template literals (the DDL lives inside a
 * `db.exec(`…`)` template literal, and the `reflect:funnel` event-key + the closed-enum
 * literals are string literals we must scan). So a forbidden token mentioned in PROSE
 * cannot self-trip the gate; only a real code/SQL/contract token trips it.
 *
 * ## This test runs in the `architecture` vitest project
 *
 * It is part of `pnpm validate` (via `test:coverage`'s architecture project) and
 * requires a prior `pnpm build` (it reads dist). The `validate` pipeline builds
 * before testing, so it is self-consistent in CI.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

// ---------------------------------------------------------------------------
// The DEPLOYED DIST artifacts each invariant pins (packages/*/dist/*.js / *.d.ts).
// A rename here is RED (readFileSync throws); the non-vacuity anchors below are RED
// if the artifact moved but still resolves to some other (wrong) file.
// ---------------------------------------------------------------------------
const DIST = {
  // INV-1 / INV-3: the mental_models DDL — trust CHECK + kind CHECK, NO scripts column.
  schemaMentalModels: "packages/memory/dist/schema-mental-models.js",
  // INV-2 / INV-3 / INV-5: the reflect SELECT/group/gate engine.
  reflectionJob: "packages/agent/dist/memory/reflection-job.js",
  // INV-3: the reflect-path files that must hold no exec surface.
  llmReflectionAdapter: "packages/agent/dist/memory/llm-reflection-adapter.js",
  reflectionPrompt: "packages/agent/dist/memory/reflection-prompt.js",
  // INV-3 / INV-6: the static admission body guard (the only admission scan).
  validateLearnedDocBody: "packages/core/dist/security/validate-learned-doc-body.js",
  // INV-4: the eviction-candidacy predicate + the FORGET-03 exemption disjunction.
  lifecycleStore: "packages/memory/dist/sqlite-memory-lifecycle-store.js",
  // INV-6: the content-free reflect:* funnel contract — the compiled .js is type-only
  // (`export {}`), so the funnel SHAPE lives in the emitted .d.ts; we scan that.
  eventsLearningDts: "packages/core/dist/event-bus/events-learning.d.ts",
} as const;

/**
 * Strip ONLY comments (line + block), KEEPING string/template literals — so the DDL
 * (inside a `db.exec(`…`)` template literal) and the event-key / closed-enum string
 * literals survive the scan, but a forbidden token in PROSE is removed. Mirrors
 * reflection-no-exec-guard.test.ts `stripCommentsOnly`.
 */
function stripCommentsOnly(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Read a DEPLOYED-DIST artifact (throws at module scope if it is gone → RED-provable). */
function readDist(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

// Read all artifacts ONCE at module scope (a missing dist artifact fails the suite —
// the pre-build RED state). Comment-stripped (string literals kept) for the scans.
const schemaMentalModels = stripCommentsOnly(readDist(DIST.schemaMentalModels));
const reflectionJob = stripCommentsOnly(readDist(DIST.reflectionJob));
const llmReflectionAdapter = stripCommentsOnly(readDist(DIST.llmReflectionAdapter));
const reflectionPrompt = stripCommentsOnly(readDist(DIST.reflectionPrompt));
const validateLearnedDocBody = stripCommentsOnly(readDist(DIST.validateLearnedDocBody));
const lifecycleStore = stripCommentsOnly(readDist(DIST.lifecycleStore));
const eventsLearningDts = stripCommentsOnly(readDist(DIST.eventsLearningDts));

describe("INV-1..6 re-verified on the DEPLOYED DIST (Phase 227 / D-02, ACCEPT-01)", () => {
  it("INV-1 (trust ceiling): mental_models DDL restricts trust_level to ('learned') on the BUILT artifact", () => {
    // Non-vacuity anchor: the CREATE TABLE for mental_models is present (a moved DDL fails).
    expect(
      /CREATE TABLE IF NOT EXISTS mental_models/.test(schemaMentalModels),
      "non-vacuity anchor: the mental_models CREATE TABLE moved out of the built schema-mental-models.js",
    ).toBe(true);
    // The SEC-01 keystone: trust_level is CHECK-constrained to the single 'learned'
    // value — a learned doc can NEVER be inserted as 'system' (no EoP via the table).
    expect(
      /trust_level\s+TEXT[^,]*CHECK\s*\(\s*trust_level\s+IN\s*\(\s*'learned'\s*\)\s*\)/i.test(schemaMentalModels),
      "the built mental_models DDL must CHECK trust_level IN ('learned') (INV-1 / SEC-01 trust ceiling)",
    ).toBe(true);
    // The kind closed enum survives too (the kind:skill|profile|topic domain).
    expect(
      /kind\s+TEXT[^,]*CHECK\s*\(\s*kind\s+IN\s*\(\s*'skill'\s*,\s*'profile'\s*,\s*'topic'\s*\)\s*\)/i.test(schemaMentalModels),
      "the built mental_models DDL must CHECK kind IN ('skill','profile','topic')",
    ).toBe(true);
  });

  it("INV-2 (anti-domination ≥2 distinct): the built reflection-job carries the distinct-(session,sender) corroboration gate", () => {
    // Non-vacuity anchor: classifyReflectOutcome survives the build (the outcome
    // classifier the gate feeds). A renamed/inlined engine fails here.
    expect(
      /\bclassifyReflectOutcome\b/.test(reflectionJob),
      "non-vacuity anchor: classifyReflectOutcome missing from the built reflection-job.js",
    ).toBe(true);
    // The corroboration gate's input — the distinct-(session,sender) cardinality.
    expect(
      /\bdistinctSenderCardinality\b/.test(reflectionJob),
      "the built reflection-job.js must carry distinctSenderCardinality (the ≥2-distinct anti-domination gate, INV-2)",
    ).toBe(true);
    expect(
      /\bmaxTopicCardinality\b/.test(reflectionJob),
      "the built reflection-job.js must carry maxTopicCardinality (the funnel's distinct-sender count)",
    ).toBe(true);
    // The acute outcome literal a 1-distinct topic resolves to (an attacker replaying
    // ONE session is refused → 'uncorroborated', not admitted).
    expect(
      /'uncorroborated'|"uncorroborated"/.test(reflectionJob),
      "the built reflection-job.js must carry the 'uncorroborated' outcome literal (INV-2 anti-domination refusal)",
    ).toBe(true);
  });

  it("INV-3 (no learned-code exec): the built reflect path holds NO exec surface, and the DDL has NO scripts column", () => {
    // The reflect/validate path on dist — none of the dynamic-replay / spawn tokens.
    const reflectPath: ReadonlyArray<{ rel: string; code: string }> = [
      { rel: DIST.reflectionJob, code: reflectionJob },
      { rel: DIST.llmReflectionAdapter, code: llmReflectionAdapter },
      { rel: DIST.reflectionPrompt, code: reflectionPrompt },
      { rel: DIST.validateLearnedDocBody, code: validateLearnedDocBody },
    ];
    // Non-vacuity anchor: the static admission guard survives the build (the only
    // admission scan that remains — a doc is text, not code).
    expect(
      /validateLearnedDocBody/.test(validateLearnedDocBody),
      "non-vacuity anchor: validateLearnedDocBody missing from the built validate-learned-doc-body.js",
    ).toBe(true);
    const forbidden: ReadonlyArray<{ token: string; pattern: RegExp }> = [
      { token: "runDynamicReplay", pattern: /\brunDynamicReplay\b/ },
      { token: "spawn", pattern: /\bspawn(Sync)?\s*\(/ },
      { token: "child_process", pattern: /\bchild_process\b/ },
      { token: "bwrap", pattern: /\bbwrap\b/ },
      { token: "ALLOWED_SCRIPT_LANGS", pattern: /\bALLOWED_SCRIPT_LANGS\b/ },
    ];
    for (const { token, pattern } of forbidden) {
      const offenders = reflectPath.filter(({ code }) => pattern.test(code)).map(({ rel }) => rel);
      expect(
        offenders,
        `${token} reappeared in the BUILT reflect/validate path (a learned-code execution surface — forbidden by INV-3): ${offenders.join(", ")}`,
      ).toEqual([]);
    }
    // The mental_models DDL on dist carries NO executable `scripts` column.
    expect(
      /\bscripts\s+(TEXT|BLOB|INTEGER|REAL|NUMERIC)\b/i.test(schemaMentalModels),
      "the BUILT mental_models DDL re-introduced a `scripts` column — a learned doc must not carry executable scripts (INV-3)",
    ).toBe(false);
  });

  it("INV-4 (anti-induced-eviction): the built lifecycle store gates isEvictionCandidate on the pinned/system/high-proof exemption disjunction", () => {
    // Non-vacuity anchor: the eviction-candidacy predicate survives the build.
    expect(
      /\bisEvictionCandidate\b/.test(lifecycleStore),
      "non-vacuity anchor: isEvictionCandidate missing from the built sqlite-memory-lifecycle-store.js",
    ).toBe(true);
    // The exemption disjunction — pinned + a system trust check + the high-proof floor.
    // Compiled form: `const exempt = row.pinned === 1 || … 'system' … >= highProofFloor`.
    expect(/\bpinned\b/.test(lifecycleStore), "the built lifecycle store must reference `pinned` (FORGET-03 exemption)").toBe(true);
    expect(
      /'system'|"system"/.test(lifecycleStore),
      "the built lifecycle store must reference the 'system' trust exemption (FORGET-03)",
    ).toBe(true);
    expect(
      /\bhighProofFloor\b/.test(lifecycleStore),
      "the built lifecycle store must reference highProofFloor (the high-proof eviction exemption, INV-4)",
    ).toBe(true);
    // The exemption must GATE candidacy: `!exempt && …`.
    expect(
      /!\s*exempt\b/.test(lifecycleStore),
      "the built lifecycle store must gate isEvictionCandidate on `!exempt` (the exemption disjunction blocks eviction, INV-4)",
    ).toBe(true);
  });

  it("INV-5 (untrusted-origin seeds nothing): the built reflection-job filters on trustedOrigin and carries the untrusted_origin outcome", () => {
    // Non-vacuity anchor: the trusted-origin field name survives the build.
    expect(
      /\btrustedOrigin\b/.test(reflectionJob),
      "non-vacuity anchor: trustedOrigin missing from the built reflection-job.js (the SELECT trust filter)",
    ).toBe(true);
    // The D5-salvage acute reason: all-untrusted-origin successes dropped at SELECT
    // resolve to 'untrusted_origin' (an untrusted-origin trajectory seeds no doc).
    expect(
      /'untrusted_origin'|"untrusted_origin"/.test(reflectionJob),
      "the built reflection-job.js must carry the 'untrusted_origin' outcome literal (INV-5, the untrusted-origin anti-poison axis)",
    ).toBe(true);
  });

  it("INV-6 (content-free telemetry): the built reflect:* funnel contract carries ONLY counts/closed-enum — no body/procedure/text field", () => {
    // Non-vacuity anchor: the reflect:funnel event key + the ReflectAdmissionOutcome
    // closed union are present in the emitted contract (a moved/empty .d.ts fails).
    expect(
      /reflect:funnel/.test(eventsLearningDts),
      "non-vacuity anchor: the reflect:funnel event key is missing from the built events-learning.d.ts",
    ).toBe(true);
    expect(
      /\bReflectAdmissionOutcome\b/.test(eventsLearningDts),
      "non-vacuity anchor: the ReflectAdmissionOutcome closed union is missing from the built events-learning.d.ts",
    ).toBe(true);
    // The funnel declares ONLY counts + the closed-enum verdict.
    for (const field of ["synthesized", "validated", "admitted", "maxClusterCardinality", "admissionOutcome"]) {
      expect(
        new RegExp(`\\b${field}\\b`).test(eventsLearningDts),
        `the built reflect funnel must declare the content-free field \`${field}\` (counts/closed-enum only, INV-6)`,
      ).toBe(true);
    }
    // The ReflectAdmissionOutcome union is a CLOSED set of string literals (no `string`).
    expect(
      /ReflectAdmissionOutcome\s*=\s*("[^"]+"|'[^']+')(\s*\|\s*("[^"]+"|'[^']+'))+/.test(eventsLearningDts),
      "ReflectAdmissionOutcome must be a closed string-literal union (not an open `string`) — INV-6 content-free verdict",
    ).toBe(true);
    // FORBID a content-bearing field on the reflect funnel/admitted event blocks: a
    // `body` / `procedure` / `promptText` / a free `text:` field would leak doc content
    // onto the bus. Scan the reflect:* event blocks only (the funnel + admitted), so an
    // unrelated `text`/`body` token elsewhere in the file cannot false-positive.
    const reflectBlocks =
      sliceEventBlock(eventsLearningDts, "reflect:admitted") + "\n" + sliceEventBlock(eventsLearningDts, "reflect:funnel");
    for (const banned of [/\bbody\s*:/, /\bprocedure\s*:/, /\bpromptText\s*:/, /\bdocBody\s*:/, /\btext\s*:\s*string/]) {
      expect(
        banned.test(reflectBlocks),
        `the reflect:* funnel must NOT carry a content-bearing field matching ${banned} (a procedure body/text leak — INV-6)`,
      ).toBe(false);
    }
  });
});

/**
 * Slice the object-literal block for a given event key out of the emitted .d.ts so
 * the content-free-field forbid scans ONLY the reflect:* event shapes (not the whole
 * file). Returns the text from the event key to the matching close brace at the same
 * nesting depth; "" when the key is absent (handled by the non-vacuity anchor above).
 */
function sliceEventBlock(dts: string, eventKey: string): string {
  const keyIdx = dts.indexOf(`"${eventKey}"`);
  if (keyIdx < 0) return "";
  const open = dts.indexOf("{", keyIdx);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < dts.length; i++) {
    if (dts[i] === "{") depth++;
    else if (dts[i] === "}") {
      depth--;
      if (depth === 0) return dts.slice(keyIdx, i + 1);
    }
  }
  return dts.slice(keyIdx);
}
