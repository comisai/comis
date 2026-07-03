// SPDX-License-Identifier: Apache-2.0
/**
 * A standing guard that the reflect:funnel admissionOutcome keeps each reason
 * distinct, so the dead-loop reason and the rejected_name_length vs
 * rejected_validation distinction stay diagnosable in ONE `comis explain` call.
 * A future collapse of two reasons is a failing test.
 *
 * ## Why this guard exists
 *
 * Two distinct diagnosability concerns both resolve to the
 * `reflect:funnel.admissionOutcome` closed enum (`ReflectAdmissionOutcome`,
 * @comis/core):
 *
 *   - The `promoteByName topicKey:''` dead-loop: the dead promote loop is read
 *     off `comis explain` as `admitted:N` with `skill_promoted:0`; the funnel's
 *     reason verdict (`no_successes` / `untrusted_origin` / `uncorroborated`)
 *     names WHY nothing was admitted. The `untrusted_origin` reason must stay
 *     DISTINCT from `no_successes` / `uncorroborated` or "all dropped for an
 *     untrusted origin" again hides behind a generic "no successes" verdict.
 *   - The profile-name overflow → false `rejected_validation`: a name-length
 *     rejection (`rejected_name_length`) must NEVER masquerade as the poison-scan
 *     `rejected_validation` verdict — they are DISTINCT members.
 *
 * Both rely on (a) the enum keeping each reason distinct, and (b) the
 * `translate-payload` fold continuing to surface `admissionOutcome` on
 * `comis explain`. A future change that collapses two reasons into one, or drops
 * `admissionOutcome` from the fold, silently re-hides a diagnosability class —
 * the name-length regression or the dead-loop ambiguity. This guard makes either
 * a RED test.
 *
 * ## What it asserts (each its own `it`)
 *
 *   1. The built `ReflectAdmissionOutcome` closed union declares all 7 distinct
 *      reasons, INCLUDING `rejected_name_length` AND `rejected_validation` as SEPARATE
 *      members (they must never collapse into one).
 *   2. `untrusted_origin` is present and distinct from `no_successes` /
 *      `uncorroborated`.
 *   3. (non-vacuity) the `reflect:funnel` fold in `translate-payload.js` actually
 *      returns `admissionOutcome` — so the enum REACHES `comis explain`. A regression
 *      that drops the field from the fold fails here.
 *
 * ## Reads the DEPLOYED DIST (not src)
 *
 * The `ReflectAdmissionOutcome` union is a TYPE — the compiled `events-learning.js`
 * is type-only (`export {}`), so the union SHAPE lives in the emitted `.d.ts`; we scan
 * that (mirrors `reflection-inv-belts-dist.test.ts` INV-6). The fold is real runtime
 * code, so we scan the compiled `translate-payload.js`. Reading the dist (not src) is
 * deliberate: it pins the contract an operator's `comis explain` actually runs.
 *
 * ## RED-provable
 *
 * `readFileSync` throws at module scope if a scanned dist artifact is missing → the
 * suite fails (the pre-build RED state). Collapsing `rejected_name_length` and
 * `rejected_validation` into one member, dropping `untrusted_origin`, or removing
 * `admissionOutcome` from the `translate-payload` `reflect:funnel` fold each fails its
 * respective `it`. (The contract is GREEN at HEAD — this is a REGRESSION guard, so the
 * pre-patch failing state it pins is a hypothetical FUTURE collapse; non-vacuity is
 * proven by asserting each member is PRESENT now.)
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
// The DEPLOYED DIST artifacts this guard pins. A rename here is RED (readFileSync
// throws at module scope). NB: dist paths only — never a `/src/` path constant, so
// the guard reads the contract `comis explain` actually runs.
// ---------------------------------------------------------------------------
const DIST = {
  // The CLOSED ReflectAdmissionOutcome union — the .js is type-only (`export {}`),
  // so the union shape lives in the emitted .d.ts (mirrors the INV-6 belt).
  eventsLearningDts: "packages/core/dist/event-bus/events-learning.d.ts",
  // The fold that surfaces admissionOutcome on `comis explain` (runtime code → .js).
  translatePayload: "packages/observability/dist/trajectory/translate-payload.js",
} as const;

/**
 * Strip ONLY comments (line + block), KEEPING string/template literals — so the
 * closed-enum string-literal members and the fold's object keys survive the scan, but
 * a token mentioned in PROSE / a doc-comment cannot self-trip the gate. Mirrors
 * `reflection-inv-belts-dist.test.ts` / `reflection-no-exec-guard.test.ts`
 * `stripCommentsOnly` (so the scan cannot self-trip on its own doc-comment tokens).
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

// Read both artifacts ONCE at module scope (a missing dist artifact fails the suite —
// the pre-build RED state). Comment-stripped (string literals KEPT) for the scans.
const eventsLearningDts = stripCommentsOnly(readDist(DIST.eventsLearningDts));
const translatePayload = stripCommentsOnly(readDist(DIST.translatePayload));

/**
 * The 7 closed reasons the `reflect:funnel` admissionOutcome verdict distinguishes.
 * Each is a content-free (INV-6) reason an operator reads off ONE `comis explain` call.
 * A doc-name over-cap is `rejected_name_length` (friction 4), NOT the poison
 * `rejected_validation`; an untrusted-origin drop is `untrusted_origin` (friction 1 /
 * D5 salvage), NOT a generic `no_successes`.
 */
const REQUIRED_REASONS = [
  "admitted",
  "uncorroborated",
  "rejected_validation",
  "rejected_name_length",
  "untrusted_origin",
  "empty_reflection",
  "no_successes",
] as const;

describe("reflect:funnel admissionOutcome keeps each reason distinct", () => {
  // Non-vacuity anchors (RED if the artifact moved but resolved to some other file):
  // the closed union must actually be DECLARED in the scanned .d.ts, and the
  // reflect:funnel case must actually be PRESENT in the scanned fold.
  it("the scanned dist artifacts are the real contract (non-vacuity anchors)", () => {
    expect(
      /\bReflectAdmissionOutcome\b/.test(eventsLearningDts),
      "non-vacuity anchor: the ReflectAdmissionOutcome closed union is missing from the built events-learning.d.ts — re-point the guard",
    ).toBe(true);
    // The union must be a CLOSED string-literal union (no open `string`) — the INV-6
    // content-free verdict shape; a `= string` would make the reason-distinctness
    // assertions vacuous.
    expect(
      /ReflectAdmissionOutcome\s*=\s*("[^"]+"|'[^']+')(\s*\|\s*("[^"]+"|'[^']+'))+/.test(
        eventsLearningDts,
      ),
      "ReflectAdmissionOutcome must be a CLOSED string-literal union (not an open `string`)",
    ).toBe(true);
    // The fold must carry the reflect:funnel case (proves we scanned the right file).
    expect(
      /reflect:funnel/.test(translatePayload),
      "non-vacuity anchor: the reflect:funnel case is missing from the built translate-payload.js — re-point the guard",
    ).toBe(true);
  });

  it("declares all 7 distinct reasons, with rejected_name_length AND rejected_validation BOTH present + distinct (friction 4: they must never collapse)", () => {
    // Isolate the union's RHS so we count members in the contract itself, not a
    // mention elsewhere in the .d.ts prose-free source.
    const unionMatch = /ReflectAdmissionOutcome\s*=\s*([^;]+);/.exec(eventsLearningDts);
    expect(unionMatch, "could not isolate the ReflectAdmissionOutcome union RHS").not.toBeNull();
    const rhs = unionMatch![1];
    // Each required reason is a string-literal member of the closed union.
    for (const reason of REQUIRED_REASONS) {
      expect(
        new RegExp(`["']${reason}["']`).test(rhs),
        `the reflect reason "${reason}" is missing from the ReflectAdmissionOutcome union — a friction class lost its distinct verdict`,
      ).toBe(true);
    }
    // The headline distinctness: rejected_name_length and rejected_validation
    // are SEPARATE members. If a future change merges them, a name-length rejection again
    // masquerades as the poison-scan verdict — this fails.
    expect(
      /["']rejected_name_length["']/.test(rhs) && /["']rejected_validation["']/.test(rhs),
      "rejected_name_length and rejected_validation must BOTH be distinct members — a collapse re-hides a name over-cap behind the poison verdict",
    ).toBe(true);
    // The union is exactly the 7 reasons — no member silently dropped, none added
    // un-reviewed (the closed-set discipline). Count distinct string literals on the RHS.
    const members = (rhs.match(/["'][a-z_]+["']/g) ?? []).map((m) => m.replace(/["']/g, ""));
    const distinct = new Set(members);
    expect(
      distinct.size,
      `the ReflectAdmissionOutcome union has ${distinct.size} distinct members, expected ${REQUIRED_REASONS.length} (${[...distinct].join(", ")})`,
    ).toBe(REQUIRED_REASONS.length);
  });

  it("includes untrusted_origin as a member distinct from no_successes / uncorroborated", () => {
    const unionMatch = /ReflectAdmissionOutcome\s*=\s*([^;]+);/.exec(eventsLearningDts);
    const rhs = unionMatch![1];
    // An "all successes dropped for an untrusted origin" run reads as
    // `untrusted_origin`, NOT a generic `no_successes`/`uncorroborated` — so `comis
    // explain` names the real reason. All three must coexist as distinct members.
    expect(/["']untrusted_origin["']/.test(rhs), "untrusted_origin missing").toBe(true);
    expect(/["']no_successes["']/.test(rhs), "no_successes missing").toBe(true);
    expect(/["']uncorroborated["']/.test(rhs), "uncorroborated missing").toBe(true);
  });

  it("the translate-payload reflect:funnel fold returns admissionOutcome (the enum reaches comis explain — non-vacuity)", () => {
    // Find the reflect:funnel case body and assert it folds admissionOutcome through.
    // The fold is `case "reflect:funnel": ... return { ... admissionOutcome: payload.admissionOutcome };`
    // A regression that drops the field from the fold (so `comis explain` no longer
    // names the reason) fails here.
    expect(
      /admissionOutcome/.test(translatePayload),
      "the translate-payload fold no longer mentions admissionOutcome — the reflect reason no longer reaches comis explain",
    ).toBe(true);
    // Tie the field to the reflect:funnel case specifically: between the case label and
    // its return, admissionOutcome must appear (not merely somewhere else in the file).
    const funnelCase = /case\s+["']reflect:funnel["'][\s\S]*?return\s*\{[\s\S]*?\}\s*;/.exec(
      translatePayload,
    );
    expect(
      funnelCase,
      "could not isolate the reflect:funnel case → return block in translate-payload.js",
    ).not.toBeNull();
    expect(
      /admissionOutcome/.test(funnelCase![0]),
      "the reflect:funnel fold's return object dropped admissionOutcome — `comis explain` would no longer surface the reflect reason (frictions 1 + 4 regress)",
    ).toBe(true);
  });
});
