// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION (Phase 223 / SKILL-04, success criterion #4): the **live A→B drive**
 * — the full Hindsight loop that has NEVER run end-to-end before this phase, driven
 * in-process through the PUBLIC `@comis/memory` + `@comis/agent` + `@comis/daemon`
 * dist barrels against a real temp SQLite database (NOT `~/.comis`):
 *
 *   A. ACCUMULATE + REFLECT
 *      observe 2 corroborating `success` outcomes on ONE topic from DISTINCT
 *      `(sessionId, sender)` (sess_1/alice, sess_2/bob) via the REAL
 *      `createSqliteOutcomeStore`  →  run the REAL `runReflection` (the ONLY mock is
 *      the reflection LLM `reflect` adapter, which returns a FIXED `{ sections }`
 *      playbook)  →  a `candidate`/`learned` skill doc is admitted to the REAL
 *      `createSqliteMentalModelStore` (GROUND TRUTH: `store.get`).
 *
 *   B. SURFACE + REUSE + PROMOTE
 *      a fresh session (sess_3) attributes that doc on a `success` outcome  →  the
 *      REAL `applySkillOutcomeTransitions` (the `@comis/daemon` resolve-seam loop
 *      body) drives `promoteByName`  →  the row ACTUALLY MOVES candidate→active and
 *      `proof_count` increments (GROUND TRUTH: a `learning:skill_promoted` event AND
 *      `store.get` shows `state:"active"`).
 *
 * This closes the headline gap: `SYNTH-EMBED-DEAD` made the OLD embedding-clustering
 * admission NEVER fire (every success became a singleton cluster → `admitted:0`
 * forever); the reflection engine (Plan 04) + the deterministic `topicKey`
 * (Plan 01) make admission fire on 2 corroborating, differently-worded successes,
 * and the source-agnostic reuse loop (proven by MODEL-04 at 222-03) promotes it.
 *
 * WHAT IS REAL vs MOCKED
 *  - REAL: the SQLite `mental_models` + `outcome_events` stores (same db); the
 *    `runReflection` SELECT→GROUP→GATE→REFLECT→GUARD→ADMIT pipeline; the
 *    deterministic `normalizeOpeningRequest` topicKey; the `validateLearnedDocBody`
 *    static guard; the `applySkillOutcomeTransitions`→`promoteByName` transition loop.
 *  - MOCKED: ONLY the reflection LLM `reflect` adapter (a fixed playbook) — the
 *    real-provider VPS drive is Phase 227 (LIVE-03). The standard test doubles
 *    (a captured `eventBus`, a fixed `clock`, a no-op logger) carry no behavior.
 *
 * FALSE-GREEN DEFENSE (T-223-25 / the 0-row-write-lies guard): the test reads
 * GROUND TRUTH at every assertion (`store.get` + the emitted `learning:skill_promoted`
 * payload), NEVER a chat reply. Part B asserts the row ACTUALLY MOVED
 * (candidate→active AND `proofCount` strictly increased past its admitted value) —
 * `applySkillOutcomeTransitions` only counts/emits on a `changed:true` store
 * transition, so an EMPTY `promoteByName({changed:false})` (an unknown/unmatched
 * name) would emit NOTHING and leave the row at `candidate`, FAILING this test. A
 * dedicated INVERSION case drives the loop with a NON-EXISTENT skill name and
 * asserts NO promote fires + the real doc is untouched — proving the GREEN in B
 * genuinely depends on the real name→row resolution (not a vacuous emit).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createSqliteMentalModelStore,
  createSqliteOutcomeStore,
  openSqliteDatabase,
  initSchema,
} from "@comis/memory";
// The REAL reflection engine (the ONLY thing we mock is its injected `reflect`).
import { runReflection } from "@comis/agent";
// The REAL resolve-seam promote loop (NOT a store-only shortcut) — the @comis/daemon
// barrel export added by 222-03 for exactly this characterization.
import { applySkillOutcomeTransitions, createSkillTrendTracker } from "@comis/daemon";
import type {
  ClockPort,
  ComisLogger,
  DocSection,
  LearningScope,
  OutcomeObservation,
  ResolvedOutcome,
  TypedEventBus,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Fixtures — one (tenant, agent) scope; two DISTINCT (sessionId, sender) on ONE topic.
// ---------------------------------------------------------------------------

const TENANT = "tenant_ab";
const AGENT = "agent_ab";
const SCOPE: LearningScope = { tenantId: TENANT, agentId: AGENT, now: 1_000 };

/** minConfidence the reflection SELECT gates on (the observed successes clear it). */
const MIN_CONFIDENCE = 0.5;

/**
 * Two genuinely same-topic requests, worded DIFFERENTLY. The deterministic
 * `normalizeOpeningRequest` token-SET hash MUST collapse them to ONE topicKey
 * (the SYNTH-EMBED-DEAD risk from the other direction — if they did NOT collide,
 * corroboration never reaches ≥2 and `admitted:0` persists). We assert the
 * collision explicitly below before relying on it.
 */
const SIGNATURE_ALICE = "please deploy the staging service";
const SIGNATURE_BOB = "deploy staging service"; // same {deploy, service, staging} token set, reordered + fewer fillers

/** The deterministic doc NAME the reflection job admits a topic under: `skill-<first16hex>`. */
function docNameFor(signature: string): string {
  // Mirror reflection-job.ts `docNameForTopic(normalizeOpeningRequest(signature))`.
  const tokens = signature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  const topicKey = createHash("sha256").update([...new Set(tokens)].sort().join(" ")).digest("hex");
  return `skill-${topicKey.slice(0, 16)}`;
}

/** The exact STOPWORDS the topicKey normalizer strips (kept in sync with topic-key.ts). */
const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "please", "can", "could",
  "would", "you", "i", "my", "our", "this", "that", "is", "are", "be", "do",
]);

/** A fixed reflect playbook — the ONLY mock. A non-empty `{ sections }` so the job admits. */
const FIXED_SECTIONS: DocSection[] = [
  { id: "use-when", heading: "Use when", body: "Deploying the staging service on request." },
  { id: "steps", heading: "Steps", body: "1. read the current status\n2. trigger the deploy\n3. report the result" },
];

/** Build one source trajectory (distinct identity, shared signature ⇒ same topicKey). */
function source(over: { trajectoryId: string; sessionId: string; sender: string; signature: string }) {
  return {
    trajectoryId: over.trajectoryId,
    sessionId: over.sessionId,
    sender: over.sender,
    text: `[transcript ${over.trajectoryId}] deployed staging successfully`, // UNTRUSTED; the (mocked) adapter wraps it
    signature: over.signature,
    trustedOrigin: true, // INV-5/D-04: trusted-origin (the daemon derives this; here it is fixed)
  };
}

/** One observed success outcome (the REAL outcome store persists it; resolve fuses to `success`). */
function successObservation(over: { sessionId: string; trajectoryId: string }): OutcomeObservation {
  return {
    tenantId: TENANT,
    agentId: AGENT,
    sessionId: over.sessionId,
    trajectoryId: over.trajectoryId,
    outcome: "success",
    source: "tool", // the deterministic top-tier source
    confidence: 0.9, // >= MIN_CONFIDENCE
    observedAt: 500,
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
} as unknown as ComisLogger;

describe("INTEGRATION: SKILL-04 — the live A→B reflect+reuse+promote drive (the never-run loop)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof openSqliteDatabase>;
  let skillStore: ReturnType<typeof createSqliteMentalModelStore>;
  let outcomeStore: ReturnType<typeof createSqliteOutcomeStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-reflect-ab-"));
    db = openSqliteDatabase({
      dbPath: join(tmpDir, "memory.db"),
      initSchema: (d) => void initSchema(d, 384), // a realistic runtime-probed embedding dim
    });
    // BOTH stores on the SAME db (the daemon wires them over one handle).
    skillStore = createSqliteMentalModelStore({ db });
    outcomeStore = createSqliteOutcomeStore({ db });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // a close after the test finished is harmless
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("A: observe 2 corroborating successes → reflect a candidate doc; B: reuse → the REAL loop promotes candidate→active (GROUND TRUTH)", async () => {
    // PRECONDITION: the two differently-worded same-topic signatures MUST collapse
    // to ONE topicKey (the deterministic-key risk; if this fails, corroboration can
    // never reach ≥2 and the whole loop is dead — exactly the SYNTH-EMBED-DEAD shape).
    const docName = docNameFor(SIGNATURE_ALICE);
    expect(docNameFor(SIGNATURE_BOB)).toBe(docName); // same token set ⇒ same name

    // --- A (ACCUMULATE): persist 2 success outcomes via the REAL outcome store. ---
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_1", trajectoryId: "traj_a" }))).ok).toBe(true);
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_2", trajectoryId: "traj_b" }))).ok).toBe(true);

    // GROUND TRUTH that the outcome ledger actually resolves these to `success`
    // (the REAL fusion the reflection SELECT calls — not a stub).
    const resolvedA = await outcomeStore.resolve("traj_a", SCOPE);
    expect(resolvedA.ok && resolvedA.value.outcome).toBe("success");

    // The ONLY mock: a reflect adapter returning a FIXED playbook (a real, non-empty
    // `{ sections }` so the job's empty-content guard does NOT skip the admit).
    const reflect = vi.fn(async () => ({ ok: true as const, value: { sections: FIXED_SECTIONS } }));

    // --- A (REFLECT): run the REAL engine. Only `reflect` is mocked. ---
    const r = await runReflection({
      agentId: AGENT,
      tenantId: TENANT,
      scope: SCOPE,
      config: { enabled: true, minConfidence: MIN_CONFIDENCE, maxDocsPerRun: 5 },
      sourceTrajectories: [
        source({ trajectoryId: "traj_a", sessionId: "sess_1", sender: "alice", signature: SIGNATURE_ALICE }),
        source({ trajectoryId: "traj_b", sessionId: "sess_2", sender: "bob", signature: SIGNATURE_BOB }),
      ],
      reflectionAdapter: { reflect },
      outcomeSignal: outcomeStore, // the REAL resolve seam
      mentalModelStore: skillStore, // the REAL admit/get target
      clock: { now: () => 1_000 },
      eventBus: { emit: () => {} }, // the job emits NO learning:* event (the daemon does, Plan 05)
      logger: noopLogger,
    });

    // The funnel verdict is GROUND TRUTH-derived (counts from the real pipeline).
    expect(r.ok).toBe(true);
    const result = r.ok ? r.value : undefined;
    expect(result?.admissionOutcome).toBe("admitted");
    expect(result?.selected).toBe(2); // both trusted-origin successes cleared SELECT
    expect(result?.maxTopicCardinality).toBeGreaterThanOrEqual(2); // ≥2 distinct (session,sender)
    expect(result?.admitted).toBe(1); // exactly one candidate doc admitted
    expect(reflect).toHaveBeenCalledTimes(1); // ONE cheap-model call for the one corroborated topic

    // GROUND TRUTH (store.get): the doc admitted at candidate / learned / LOW proof / structured.
    const afterAdmit = await skillStore.get(docName, SCOPE);
    expect(afterAdmit.ok).toBe(true);
    const candidate = afterAdmit.ok ? afterAdmit.value : undefined;
    expect(candidate, "the reflected doc must exist in the REAL store").toBeDefined();
    expect(candidate!.state).toBe("candidate");
    expect(candidate!.trustLevel).toBe("learned"); // SEC-01 ceiling: never `system`
    expect(candidate!.kind).toBe("skill");
    expect(candidate!.mutating).toBe(false); // advisory / read-only (INV-3)
    expect(candidate!.structuredBody?.sections.length).toBe(FIXED_SECTIONS.length); // the AST round-tripped
    const admittedProof = candidate!.proofCount;
    expect(admittedProof).toBe(1); // LOW_PROOF_COUNT — the anti-domination cap, regardless of cardinality

    // --- B (SURFACE + REUSE + PROMOTE): a fresh session attributes the doc on a
    //     success outcome, driven through the REAL resolve-seam loop. ---
    const emit = vi.fn<TypedEventBus["emit"]>(() => true);
    const eventBus = { emit } as unknown as TypedEventBus;
    const clock: ClockPort = { now: () => 6_000, nowDate: () => new Date(6_000) };

    const verdict: ResolvedOutcome = {
      outcome: "success",
      confidence: 0.9,
      sources: ["tool", "judge"],
      recalledIds: [],
      usedSkillIds: [docName], // attribute the REFLECTED doc (ATTR-01: skill NAME)
    };

    await applySkillOutcomeTransitions(
      { eventBus, clock, logger: noopLogger },
      { tenantId: TENANT, agentId: AGENT, sessionId: "sess_3", trajectoryId: "traj_c" },
      verdict,
      {
        skillStore,
        threshold: 1, // proof bar 1 ⇒ a single attributed success crosses candidate→active
        skillFailureCorroborationTally: new Map<string, Set<string>>(),
        skillTrend: createSkillTrendTracker(),
      },
    );

    // GROUND TRUTH #1 — the REAL loop emitted `learning:skill_promoted` (count ≥ 1).
    // (The loop emits ONLY on a `changed:true` row move, so this fires iff a row moved.)
    const promotedEmits = emit.mock.calls.filter(([event]) => event === "learning:skill_promoted");
    expect(promotedEmits.length, "a real candidate→active promotion must emit learning:skill_promoted").toBeGreaterThanOrEqual(1);
    const payload = promotedEmits[0]?.[1] as { agentId: string; count: number } | undefined;
    expect(payload?.agentId).toBe(AGENT);
    expect(payload?.count).toBeGreaterThanOrEqual(1);

    // GROUND TRUTH #2 — the row ACTUALLY MOVED in the store (NOT an empty {changed:false}).
    const afterReuse = await skillStore.get(docName, SCOPE);
    expect(afterReuse.ok).toBe(true);
    const promoted = afterReuse.ok ? afterReuse.value : undefined;
    expect(promoted).toBeDefined();
    expect(promoted!.state).toBe("active"); // candidate→active crossed the proof bar
    expect(promoted!.proofCount).toBeGreaterThan(admittedProof); // proof_count STRICTLY increased (the row moved)
    expect(promoted!.trustLevel).toBe("learned"); // SEC-01 holds through promote
  });

  it("INVERSION (false-green guard, T-223-25): the loop driven with a NON-EXISTENT name emits nothing and leaves the real doc untouched", async () => {
    // Admit the SAME candidate via the real reflect path so there IS a real doc to (not) move.
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_1", trajectoryId: "traj_a" }))).ok).toBe(true);
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_2", trajectoryId: "traj_b" }))).ok).toBe(true);
    const reflect = vi.fn(async () => ({ ok: true as const, value: { sections: FIXED_SECTIONS } }));
    await runReflection({
      agentId: AGENT,
      tenantId: TENANT,
      scope: SCOPE,
      config: { enabled: true, minConfidence: MIN_CONFIDENCE, maxDocsPerRun: 5 },
      sourceTrajectories: [
        source({ trajectoryId: "traj_a", sessionId: "sess_1", sender: "alice", signature: SIGNATURE_ALICE }),
        source({ trajectoryId: "traj_b", sessionId: "sess_2", sender: "bob", signature: SIGNATURE_BOB }),
      ],
      reflectionAdapter: { reflect },
      outcomeSignal: outcomeStore,
      mentalModelStore: skillStore,
      clock: { now: () => 1_000 },
      eventBus: { emit: () => {} },
      logger: noopLogger,
    });
    const docName = docNameFor(SIGNATURE_ALICE);
    const before = await skillStore.get(docName, SCOPE);
    expect(before.ok && before.value?.state).toBe("candidate");

    // Drive the loop with a name that does NOT match any row → promoteByName returns
    // {changed:false} → NO emit, the real doc stays candidate. This proves the part-A/B
    // GREEN above genuinely depends on the real name→row resolution (a vacuous emit
    // cannot pass), closing the false-green hole.
    const emit = vi.fn<TypedEventBus["emit"]>(() => true);
    const clock: ClockPort = { now: () => 6_000, nowDate: () => new Date(6_000) };
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as unknown as TypedEventBus, clock, logger: noopLogger },
      { tenantId: TENANT, agentId: AGENT, sessionId: "sess_3", trajectoryId: "traj_c" },
      {
        outcome: "success",
        confidence: 0.9,
        sources: ["tool"],
        recalledIds: [],
        usedSkillIds: ["skill-does-not-exist"], // unmatched name ⇒ {changed:false}
      },
      {
        skillStore,
        threshold: 1,
        skillFailureCorroborationTally: new Map<string, Set<string>>(),
        skillTrend: createSkillTrendTracker(),
      },
    );

    expect(emit.mock.calls.filter(([e]) => e === "learning:skill_promoted").length).toBe(0); // NO promote
    const after = await skillStore.get(docName, SCOPE);
    expect(after.ok && after.value?.state).toBe("candidate"); // the REAL doc is untouched
    expect(after.ok && after.value?.proofCount).toBe(1); // proof_count unchanged (no 0-row write fakery)
  });

  it("CORROBORATION counter-case (INV-2 end-to-end): a SINGLE (sessionId, sender) repeated admits NO doc", async () => {
    // A single (sess_1, alice) repeated TWICE on the same topic — two DISTINCT
    // trajectories, but the SAME (sessionId, sender), so distinctSenderCardinality
    // counts 1, the anti-domination gate refuses, and NO doc is admitted. The belt
    // an attacker would attack by replaying ONE successful session, proven at the
    // integration layer (reinforces REFLECT-03 / INV-2).
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_1", trajectoryId: "traj_a" }))).ok).toBe(true);
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_1", trajectoryId: "traj_b" }))).ok).toBe(true);

    const reflect = vi.fn(async () => ({ ok: true as const, value: { sections: FIXED_SECTIONS } }));
    const r = await runReflection({
      agentId: AGENT,
      tenantId: TENANT,
      scope: SCOPE,
      config: { enabled: true, minConfidence: MIN_CONFIDENCE, maxDocsPerRun: 5 },
      sourceTrajectories: [
        source({ trajectoryId: "traj_a", sessionId: "sess_1", sender: "alice", signature: SIGNATURE_ALICE }),
        source({ trajectoryId: "traj_b", sessionId: "sess_1", sender: "alice", signature: SIGNATURE_BOB }),
      ],
      reflectionAdapter: { reflect },
      outcomeSignal: outcomeStore,
      mentalModelStore: skillStore,
      clock: { now: () => 1_000 },
      eventBus: { emit: () => {} },
      logger: noopLogger,
    });

    expect(r.ok).toBe(true);
    const result = r.ok ? r.value : undefined;
    expect(result?.selected).toBe(2); // both successes cleared SELECT
    expect(result?.maxTopicCardinality).toBe(1); // ONE distinct (session,sender) — the gate's input
    expect(result?.admitted).toBe(0); // the anti-domination gate refused
    expect(result?.admissionOutcome).toBe("uncorroborated");
    expect(reflect).not.toHaveBeenCalled(); // no LLM call for an uncorroborated topic

    // GROUND TRUTH: no doc exists in the store.
    const miss = await skillStore.get(docNameFor(SIGNATURE_ALICE), SCOPE);
    expect(miss.ok).toBe(true);
    expect(miss.ok ? miss.value : "leak").toBeUndefined();
  });
});
