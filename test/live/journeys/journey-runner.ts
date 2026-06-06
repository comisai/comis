// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01 / E2E-03 / E2E-05 — the ONE generic journey-runner.
 *
 * `runJourney(story, deps)` interprets ANY UserStory by its DATA alone — there
 * are NO per-story branches (the open/closed contract: adding a story changes
 * nothing here). It:
 *   1. lifecycle gate — a `deprecated` story is excluded (skipped);
 *   2. requires gate — `evaluateRequires` maps providers/capabilities/platform/
 *      channelAccounts/components onto the rig credential+platform registry; an
 *      unmet requirement returns `{status:"skipped", reason}` and NEVER throws
 *      (the universal skip ≠ fail invariant);
 *   3. interpret — runs each `step` through the shared interpreter against the
 *      bound channel (echo in sandbox; a real channel at Stage-D);
 *   4. acceptance — aggregates step outcomes; at Stage-D adds judged task-success,
 *      one stitched traceId, and journey-level obs.billing (E2E-05);
 *   5. emits a per-story `JourneyResult`.
 *
 * Sandbox vs Stage-D split: in sandbox (`isLive:false`, no certs) every real-LLM
 * journey's requires gate short-circuits to skip-with-reason; the framework +
 * spec shape + the echo+mock interpretation of an UNGATED story run
 * deterministically. The Stage-D real-model execution (goal-achieved + judged
 * task-success + stitched traceId + obs.billing, the N-run × model grid) is
 * reached only when `isLive` + the component certs are present.
 *
 * @module
 */
import { interpretStep, type ConversationDriverLike, type StepContext, type StepOutcome } from "./steps.js";
import type { CredentialRegistry } from "../credentials.js";
import type { Capability } from "../credentials.js";
import type { JourneyResult, Requires, UserStory } from "./types.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface JourneyRunnerDeps {
  creds: CredentialRegistry;
  /** COMIS_LIVE — gates real-LLM execution + Stage-D acceptance. */
  isLive: boolean;
  /** Bound channel driver (echo in sandbox; absent ⇒ shape-only run → skip). */
  driver?: ConversationDriverLike;
  /**
   * Component Stage-C certs that ARE available this run (e.g. "MEM-StageC"). A
   * `requires.components` entry is met only when isLive AND this set has it —
   * otherwise the journey is "gated: component Stage-C cert deferred". Empty/
   * absent in sandbox ⇒ every component-gated journey skips.
   */
  certAllowlist?: Set<string>;
}

// ---------------------------------------------------------------------------
// evaluateRequires — returns the FIRST unmet reason, or null when all met.
// NEVER throws. skip ≠ fail.
// ---------------------------------------------------------------------------

/** True when at least one unlocked category bears the given capability. */
function capabilityMet(cap: Capability, creds: CredentialRegistry): boolean {
  const cats = creds.getUnlockedCategories();
  if (cap === "vision") {
    return cats.some((c) => c.startsWith("vision("));
  }
  // tools / structured-output / thinking are model capabilities — present when
  // any LLM provider key is unlocked (a provider implies a capable model).
  return cats.some((c) => c.startsWith("LLM("));
}

export function evaluateRequires(req: Requires, deps: JourneyRunnerDeps): string | null {
  // platform — via the rig platform verdicts (linux-only / macos-only)
  if (req.platform === "linux") {
    const v = deps.creds.getSkipVerdict("linux-only");
    if (v) return `requires platform linux — ${v}`;
  }
  if (req.platform === "macos") {
    const v = deps.creds.getSkipVerdict("macos-only");
    if (v) return `requires platform macos — ${v}`;
  }

  // providers — each must be an unlocked LLM(...) category
  if (req.providers && req.providers.length > 0) {
    const cats = deps.creds.getUnlockedCategories();
    for (const p of req.providers) {
      if (!cats.includes(`LLM(${p})`)) {
        return `requires provider ${p} — SKIPPED(no-creds)`;
      }
    }
  }

  // capabilities — each must be borne by an unlocked category
  if (req.capabilities && req.capabilities.length > 0) {
    for (const cap of req.capabilities) {
      if (!capabilityMet(cap, deps.creds)) {
        return `requires capability ${cap} — SKIPPED(no-capability)`;
      }
    }
  }

  // channelAccounts — each must be an unlocked category (a real account)
  if (req.channelAccounts && req.channelAccounts.length > 0) {
    const cats = deps.creds.getUnlockedCategories();
    for (const acct of req.channelAccounts) {
      if (!cats.includes(acct)) {
        return `requires channel account ${acct} — SKIPPED(no-creds)`;
      }
    }
  }

  // components — Stage-C cert gate: met only when isLive AND the allowlist has it
  if (req.components && req.components.length > 0) {
    for (const comp of req.components) {
      const met = deps.isLive && deps.certAllowlist?.has(comp);
      if (!met) {
        return `gated: component Stage-C cert deferred (${comp})`;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// runJourney
// ---------------------------------------------------------------------------

/**
 * Run one user story. NEVER throws on a gated/skipped condition (skip ≠ fail).
 *
 * @param story - The user story (DATA — no per-story branch is taken).
 * @param deps  - Credential registry, isLive flag, optional bound driver + cert allowlist.
 * @returns A per-story JourneyResult.
 */
export async function runJourney(story: UserStory, deps: JourneyRunnerDeps): Promise<JourneyResult> {
  const quarantined = story.status === "quarantined";
  const flag = quarantined ? { quarantined: true } : {};

  // 1. lifecycle gate
  if (story.status === "deprecated") {
    return {
      storyId: story.id,
      status: "skipped",
      reason: "deprecated story — excluded from the active run grid",
    };
  }

  // 2. requires gate — skip-with-reason, never fail
  const unmet = evaluateRequires(story.requires, deps);
  if (unmet !== null) {
    return { storyId: story.id, status: "skipped", reason: unmet, ...flag };
  }

  // 3. interpret — needs a bound driver
  if (!deps.driver) {
    return {
      storyId: story.id,
      status: "skipped",
      reason: "no driver bound (shape-only run)",
      ...flag,
    };
  }

  const ctx: StepContext = {
    driver: deps.driver,
    creds: deps.creds,
    isLive: deps.isLive,
    collected: [],
    rubricAnswers: [],
  };

  for (const step of story.steps) {
    // interpretStep never throws on a tolerated/gated condition and catches real
    // assertion failures into a `failed` step outcome — so one bad step does not
    // abort the journey; all outcomes are reported.
    await interpretStep(step, ctx);
  }

  // 4. acceptance — aggregate step outcomes.
  // A journey FAILS if any non-skipped step failed; otherwise it PASSED.
  // (Stage-D adds: judged task-success via the judge steps' verdicts, one stitched
  //  traceId, and journey-level obs.billing — see acceptance.expectStitchedTraceId
  //  / minBillingTokens. In sandbox those are skip-notes inside the step outcomes.)
  const anyFailed = ctx.collected.some((o: StepOutcome) => o.status === "failed");
  const status: JourneyResult["status"] = anyFailed ? "failed" : "passed";

  return {
    storyId: story.id,
    status,
    steps: ctx.collected,
    ...flag,
  };
}
