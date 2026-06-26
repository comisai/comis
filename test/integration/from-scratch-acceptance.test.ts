// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION — Phase 227 / D-01: the CONSOLIDATED build-side acceptance of the
 * five "Hindsight" learning capabilities (LIVE-01..05), driven from a CLEAN temp
 * `memory.db` (mkdtempSync, NOT `~/.comis`) through the PUBLIC `@comis/memory` +
 * `@comis/agent` + `@comis/daemon` + `@comis/core` dist barrels. This is the
 * Darwin-buildable analog of the operator's real-provider VPS drive; the
 * real-provider VPS drive is operator-deferred (D-05, the rewritten
 * EXAMPLE-verified-learning.md runbook).
 *
 * Per D-01: the consolidated build-side acceptance of LIVE-01..05 driven from a
 * clean memory.db; the real-provider VPS drive is operator-deferred (D-05, the
 * rewritten EXAMPLE-verified-learning.md runbook).
 *
 * It ties together the per-phase proofs 222-226 already shipped (MODEL-04,
 * reflection-a-to-b, FORGET-02 reachability, FORGET-04 supersede, profile/topic
 * equivalence) into ONE clean-slate acceptance manifest — NOT new engine code.
 *
 * ## The five capabilities (one describe block each)
 *   (a) LIVE-01 ACCUMULATION — a fact `memories` row + a resolved `outcome_events` row.
 *   (b) LIVE-02 CROSS-SESSION RECALL — a fact written under session A recalls from
 *       the durable LTM table under a DIFFERENT session id (no LCD in the loop).
 *   (c) LIVE-03 REFLECT A→B + REUSE-PROMOTE — 2 corroborating successes → a candidate
 *       skill doc → a fresh-session reuse promotes it candidate→active (proof_count↑).
 *   (d) LIVE-04 PROFILE/TOPIC DOCS — kind:'profile' + kind:'topic' docs admitted +
 *       surface-eligible via the kind-filtered list.
 *   (e) LIVE-05 SUPERSESSION + ANTI-POISON EVICTION — a corrected fact supersedes
 *       (history kept, no delete); a corroborated low-proof memory soft-evicts under
 *       the LIVE policy; pinned/system/high-proof survive identical failures.
 *
 * ## WHAT IS REAL vs MOCKED (the 0-false-success discipline, I8)
 *  - REAL: the SQLite `memories` / `memory_usefulness` / `mental_models` /
 *    `outcome_events` stores (ONE db handle); the `SqliteMemoryAdapter`
 *    store/search/supersede; the `runReflection` SELECT→GROUP→GATE→REFLECT→GUARD→ADMIT
 *    pipeline; the deterministic `topicKey` normalizer; the `validateLearnedDocBody`
 *    static guard; the `createSqliteMemoryLifecycleStore` LIVE eviction sweep; the
 *    `applySkillOutcomeTransitions`→`promoteByName` transition loop.
 *  - MOCKED: ONLY the reflection LLM `reflect` adapter (a fixed `{ sections }`
 *    playbook). The standard test doubles (a captured `eventBus`, a fixed `clock`,
 *    a no-op logger) carry NO behavior.
 *
 * Every assertion reads GROUND TRUTH — store `.get`/`.list`/`.search`, the resolved
 * `outcome_events` ledger, a raw `SELECT`, the emitted counts-only event payloads —
 * NEVER a chat reply (I8).
 *
 * ## FALSE-GREEN DEFENSE (how each block FAILS on a real break)
 *  - (a) fails if the `memories` row is absent OR `resolve()` does not fuse to
 *        `success` (an observed-but-unresolved ledger would fail).
 *  - (b) fails if the LTM `search` under session B does not return the fact A wrote
 *        (a session-scoped leak / a lost durable row).
 *  - (c) fails if the candidate→active row did NOT move (proof_count must STRICTLY
 *        increase) — the loop emits ONLY on a `changed:true` store transition, so an
 *        empty `promoteByName({changed:false})` emits nothing and leaves the row at
 *        candidate. The INVERSION case (a non-existent name) proves the GREEN depends
 *        on the real name→row resolution, not a vacuous emit.
 *  - (d) fails if the kind filter leaks (a skill-only `list` returning the
 *        profile/topic docs) OR a profile/topic doc escapes `trust_level='learned'`.
 *  - (e) SUPERSEDE fails if a row was DELETED (count must be unchanged) or the prior
 *        content was not appended to history. EVICTION fails if the sweep did NOT
 *        soft-evict the corroborated low-proof row, OR — the inverse, the
 *        anti-induced-eviction guard — if the pinned/high-proof row WAS evicted under
 *        the SAME failures (INV-4 / FORGET-03). The eviction is driven under the LIVE
 *        policy (`evictionEnabled:true`), NOT the dormant default sweep (which evicts
 *        nothing by design — a dormant-default assertion would be a false green).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  SqliteMemoryAdapter,
  createSqliteMentalModelStore,
  createSqliteOutcomeStore,
  createSqliteMemoryLifecycleStore,
} from "@comis/memory";
// The REAL reflection engine (the ONLY thing we mock is its injected `reflect`).
import { runReflection } from "@comis/agent";
// The REAL resolve-seam promote loop (NOT a store-only shortcut).
import { applySkillOutcomeTransitions, createSkillTrendTracker } from "@comis/daemon";
import type {
  ClockPort,
  ComisLogger,
  DocSection,
  LearningScope,
  MemoryConfig,
  MemoryEntry,
  OutcomeObservation,
  ResolvedOutcome,
  SessionKey,
  TypedEventBus,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------

const TENANT = "tenant_accept";
const AGENT = "agent_accept";
const SCOPE: LearningScope = { tenantId: TENANT, agentId: AGENT, now: 1_000 };

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
} as unknown as ComisLogger;

/**
 * A real on-disk `memory.db` config (NOT `:memory:`, NOT `~/.comis`). The adapter's
 * constructor runs the REAL `initSchema`, which provisions EVERY table the five
 * capabilities touch — `memories` + FTS twins, `memory_usefulness`, `mental_models`,
 * `outcome_events`. So one `SqliteMemoryAdapter` over a clean temp db is the whole
 * clean-slate substrate; the stores below share its `getDb()` handle.
 */
function dbConfig(dir: string): MemoryConfig {
  return {
    enabled: true,
    dbPath: join(dir, "memory.db"),
    walMode: false,
    recall: {
      embeddingModel: "test-model",
      embeddingDimensions: 4,
      rerankerModel: "hf:test/reranker.gguf",
    },
    compaction: { enabled: false, threshold: 1000, targetSize: 500 },
    retention: { maxAgeDays: 0 },
    rerankerModelsDir: "models",
    rerankerGpu: "false",
    rerankerThreads: 4,
  };
}

function makeEntry(over: Partial<MemoryEntry> & { content: string; id: string }): MemoryEntry {
  return {
    tenantId: TENANT,
    agentId: AGENT,
    userId: "user-1",
    trustLevel: "learned",
    source: { who: "agent", channel: "telegram" },
    tags: [],
    createdAt: 1_000,
    ...over,
  };
}

// ===========================================================================
// (a) LIVE-01 — ACCUMULATION: a `memories` row + a resolved `outcome_events` row.
// ===========================================================================

describe("LIVE-01 ACCUMULATION (the memories + resolved outcome_events floor, from a clean memory.db)", () => {
  let tmpDir: string;
  let adapter: SqliteMemoryAdapter;
  let outcomeStore: ReturnType<typeof createSqliteOutcomeStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-accept-live01-"));
    adapter = new SqliteMemoryAdapter(dbConfig(tmpDir));
    outcomeStore = createSqliteOutcomeStore({ db: adapter.getDb() });
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {
      /* harmless */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("a teach turn produces a memories row AND a resolved outcome_events row (GROUND TRUTH)", async () => {
    // Write a fact via the REAL adapter store path.
    const stored = await adapter.store(makeEntry({ id: "fact_acc_1", content: "the prod deploy command is ./deploy --prod" }));
    expect(stored.ok).toBe(true);

    // GROUND TRUTH #1 — the `memories` row exists (a raw SELECT, not a chat reply).
    const row = adapter
      .getDb()
      .prepare("SELECT id, content, trust_level FROM memories WHERE id = ? AND tenant_id = ?")
      .get("fact_acc_1", TENANT) as { id: string; content: string; trust_level: string } | undefined;
    expect(row, "the accumulated fact must persist in the memories table").toBeDefined();
    expect(row!.content).toBe("the prod deploy command is ./deploy --prod");
    expect(row!.trust_level).toBe("learned");

    // Observe a tool success on a trajectory via the REAL outcome store.
    const obs: OutcomeObservation = {
      tenantId: TENANT,
      agentId: AGENT,
      sessionId: "sess_1",
      trajectoryId: "traj_acc_1",
      outcome: "success",
      source: "tool",
      confidence: 0.9,
      observedAt: 500,
    };
    expect((await outcomeStore.observe(obs)).ok).toBe(true);

    // GROUND TRUTH #2 — the outcome ledger RESOLVES (fuses) to success — not merely
    // observed; the REAL precedence+confidence fusion the reflection SELECT calls.
    const resolved = await outcomeStore.resolve("traj_acc_1", SCOPE);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.value.outcome).toBe("success");
  });
});

// ===========================================================================
// (b) LIVE-02 — CROSS-SESSION RECALL: a fact written under session A recalls from
//     the durable LTM table under a DIFFERENT session id (no LCD in the loop).
// ===========================================================================

describe("LIVE-02 CROSS-SESSION RECALL (sever the LCD → a fresh session recalls the fact from LTM)", () => {
  let tmpDir: string;
  let adapter: SqliteMemoryAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-accept-live02-"));
    adapter = new SqliteMemoryAdapter(dbConfig(tmpDir));
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {
      /* harmless */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("a fact stored under session A surfaces from the durable LTM table when recalled under session B", async () => {
    // Session A writes a durable fact. The `memories` table is the LTM store — it is
    // (tenant, agent)-scoped, NOT session-scoped, so a different session sees it as
    // long as the (tenant, agent) match: the "sever LCD → recall from LTM" shape.
    const stored = await adapter.store(
      makeEntry({ id: "fact_xsession", content: "the on-call engineer is named Mallory and prefers Signal" }),
    );
    expect(stored.ok).toBe(true);

    // Recall from a DIFFERENT session — a fresh SessionKey (a different channelId =
    // a different conversation = no shared LCD). The REAL adapter FTS/vec recall path.
    // NOTE: the real-provider vec+FTS hybrid recall against a running daemon is the
    // operator drive (D-05); here we assert the durable-row recall through the
    // adapter's content search — ground truth, not a chat reply.
    const sessionB: SessionKey = { tenantId: TENANT, userId: "user-2", channelId: "a-different-channel" };
    const found = await adapter.search(sessionB, "who is the on-call engineer Mallory", { limit: 10 });
    expect(found.ok).toBe(true);
    const hit = found.ok ? found.value.find((r) => r.entry.id === "fact_xsession") : undefined;
    expect(hit, "the fact written under session A must recall from LTM under session B").toBeDefined();
    expect(hit!.entry.content).toContain("Mallory");
  });
});

// ===========================================================================
// (c) LIVE-03 — REFLECT A→B + REUSE-PROMOTE. Reuses the reflection-a-to-b loop.
// ===========================================================================

/** The exact STOPWORDS the topicKey normalizer strips (kept in sync with topic-key.ts). */
const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "please", "can", "could",
  "would", "you", "i", "my", "our", "this", "that", "is", "are", "be", "do",
]);

/** The deterministic doc NAME the reflection job admits a topic under: `skill-<full-topicKey>`. */
function docNameFor(signature: string): string {
  const tokens = signature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  const topicKey = createHash("sha256").update([...new Set(tokens)].sort().join(" ")).digest("hex");
  return `skill-${topicKey}`;
}

const SIGNATURE_ALICE = "please deploy the staging service";
const SIGNATURE_BOB = "deploy staging service"; // same {deploy, service, staging} token set

const FIXED_SECTIONS: DocSection[] = [
  { id: "use-when", heading: "Use when", body: "Deploying the staging service on request." },
  { id: "steps", heading: "Steps", body: "1. read the current status\n2. trigger the deploy\n3. report the result" },
];

function source(over: { trajectoryId: string; sessionId: string; sender: string; signature: string }) {
  return {
    trajectoryId: over.trajectoryId,
    sessionId: over.sessionId,
    sender: over.sender,
    text: `[transcript ${over.trajectoryId}] deployed staging successfully`,
    signature: over.signature,
    trustedOrigin: true,
  };
}

function successObservation(over: { sessionId: string; trajectoryId: string }): OutcomeObservation {
  return {
    tenantId: TENANT,
    agentId: AGENT,
    sessionId: over.sessionId,
    trajectoryId: over.trajectoryId,
    outcome: "success",
    source: "tool",
    confidence: 0.9,
    observedAt: 500,
  };
}

describe("LIVE-03 REFLECT A→B + REUSE-PROMOTE (the full Hindsight loop, GROUND TRUTH)", () => {
  let tmpDir: string;
  let adapter: SqliteMemoryAdapter;
  let skillStore: ReturnType<typeof createSqliteMentalModelStore>;
  let outcomeStore: ReturnType<typeof createSqliteOutcomeStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-accept-live03-"));
    adapter = new SqliteMemoryAdapter(dbConfig(tmpDir));
    // BOTH stores share the adapter's db handle (the daemon wires them over one db).
    skillStore = createSqliteMentalModelStore({ db: adapter.getDb() });
    outcomeStore = createSqliteOutcomeStore({ db: adapter.getDb() });
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {
      /* harmless */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("A: 2 corroborating successes → a candidate skill doc; B: a fresh-session reuse promotes it candidate→active (proof_count↑)", async () => {
    // PRECONDITION: the two differently-worded same-topic signatures MUST collapse to
    // ONE topicKey, else corroboration never reaches ≥2 and admission is dead.
    const docName = docNameFor(SIGNATURE_ALICE);
    expect(docNameFor(SIGNATURE_BOB)).toBe(docName);

    // --- A (ACCUMULATE): 2 success outcomes via the REAL outcome store. ---
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_1", trajectoryId: "traj_a" }))).ok).toBe(true);
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_2", trajectoryId: "traj_b" }))).ok).toBe(true);
    const resolvedA = await outcomeStore.resolve("traj_a", SCOPE);
    expect(resolvedA.ok && resolvedA.value.outcome).toBe("success");

    // The ONLY mock: a reflect adapter returning a FIXED playbook.
    const reflect = vi.fn(async () => ({ ok: true as const, value: { sections: FIXED_SECTIONS } }));

    // --- A (REFLECT): the REAL engine. Only `reflect` is mocked. ---
    const r = await runReflection({
      agentId: AGENT,
      tenantId: TENANT,
      scope: SCOPE,
      config: { enabled: true, minConfidence: 0.5, maxDocsPerRun: 5 },
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

    expect(r.ok).toBe(true);
    const result = r.ok ? r.value : undefined;
    expect(result?.admissionOutcome).toBe("admitted");
    expect(result?.maxTopicCardinality).toBeGreaterThanOrEqual(2); // ≥2 distinct (session,sender)
    expect(result?.admitted).toBe(1);
    expect(reflect).toHaveBeenCalledTimes(1);

    // GROUND TRUTH (store.get): the candidate doc admitted at learned / skill / LOW proof.
    const afterAdmit = await skillStore.get(docName, SCOPE);
    const candidate = afterAdmit.ok ? afterAdmit.value : undefined;
    expect(candidate, "the reflected doc must exist in the REAL store").toBeDefined();
    expect(candidate!.state).toBe("candidate");
    expect(candidate!.trustLevel).toBe("learned"); // SEC-01 ceiling: never `system`
    expect(candidate!.kind).toBe("skill");
    const admittedProof = candidate!.proofCount;

    // --- B (REUSE + PROMOTE): a fresh session attributes the doc through the REAL loop. ---
    const emit = vi.fn<TypedEventBus["emit"]>(() => true);
    const clock: ClockPort = { now: () => 6_000, nowDate: () => new Date(6_000) };
    const verdict: ResolvedOutcome = {
      outcome: "success",
      confidence: 0.9,
      sources: ["tool", "judge"],
      recalledIds: [],
      usedSkillIds: [docName],
    };

    await applySkillOutcomeTransitions(
      { eventBus: { emit } as unknown as TypedEventBus, clock, logger: noopLogger },
      { tenantId: TENANT, agentId: AGENT, sessionId: "sess_3", trajectoryId: "traj_c" },
      verdict,
      { skillStore, threshold: 1, skillFailureCorroborationTally: new Map<string, Set<string>>(), skillTrend: createSkillTrendTracker() },
    );

    // GROUND TRUTH #1 — the loop emitted `learning:skill_promoted` (fires ONLY on a row move).
    const promotedEmits = emit.mock.calls.filter(([event]) => event === "learning:skill_promoted");
    expect(promotedEmits.length, "a real candidate→active promotion must emit learning:skill_promoted").toBeGreaterThanOrEqual(1);

    // GROUND TRUTH #2 — the row ACTUALLY MOVED (not an empty {changed:false}).
    const afterReuse = await skillStore.get(docName, SCOPE);
    const promoted = afterReuse.ok ? afterReuse.value : undefined;
    expect(promoted).toBeDefined();
    expect(promoted!.state).toBe("active"); // candidate→active crossed the proof bar
    expect(promoted!.proofCount).toBeGreaterThan(admittedProof); // proof_count STRICTLY increased
    expect(promoted!.trustLevel).toBe("learned");
  });

  it("INVERSION (false-green guard): the loop driven with a NON-EXISTENT name emits nothing and leaves the real doc untouched", async () => {
    // Admit the SAME candidate via the real reflect path so there IS a real doc to (not) move.
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_1", trajectoryId: "traj_a" }))).ok).toBe(true);
    expect((await outcomeStore.observe(successObservation({ sessionId: "sess_2", trajectoryId: "traj_b" }))).ok).toBe(true);
    const reflect = vi.fn(async () => ({ ok: true as const, value: { sections: FIXED_SECTIONS } }));
    await runReflection({
      agentId: AGENT,
      tenantId: TENANT,
      scope: SCOPE,
      config: { enabled: true, minConfidence: 0.5, maxDocsPerRun: 5 },
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
    expect((await skillStore.get(docName, SCOPE)).ok && (await skillStore.get(docName, SCOPE)).value?.state).toBe("candidate");

    // Drive the loop with a name that matches NO row → promoteByName returns
    // {changed:false} → NO emit, the real doc stays candidate. This proves the A→B
    // GREEN above genuinely depends on the real name→row resolution.
    const emit = vi.fn<TypedEventBus["emit"]>(() => true);
    const clock: ClockPort = { now: () => 6_000, nowDate: () => new Date(6_000) };
    await applySkillOutcomeTransitions(
      { eventBus: { emit } as unknown as TypedEventBus, clock, logger: noopLogger },
      { tenantId: TENANT, agentId: AGENT, sessionId: "sess_3", trajectoryId: "traj_c" },
      { outcome: "success", confidence: 0.9, sources: ["tool"], recalledIds: [], usedSkillIds: ["skill-does-not-exist"] },
      { skillStore, threshold: 1, skillFailureCorroborationTally: new Map<string, Set<string>>(), skillTrend: createSkillTrendTracker() },
    );

    expect(emit.mock.calls.filter(([e]) => e === "learning:skill_promoted").length).toBe(0); // NO promote
    const after = await skillStore.get(docName, SCOPE);
    expect(after.ok && after.value?.state).toBe("candidate"); // the REAL doc is untouched
    expect(after.ok && after.value?.proofCount).toBe(1); // proof_count unchanged
  });
});

// ===========================================================================
// (d) LIVE-04 — PROFILE/TOPIC DOCS maintained + surface-eligible (the kind filter).
//
// The real-LLM profile/topic CONTENT equivalence is proven by the Phase-225 FOLD-03
// tests; here we assert the store/kind SURFACE (MODEL-04 source-agnostic downstream).
// ===========================================================================

describe("LIVE-04 PROFILE/TOPIC DOCS (kind:'profile' + kind:'topic' admitted + surface-eligible)", () => {
  let tmpDir: string;
  let adapter: SqliteMemoryAdapter;
  let store: ReturnType<typeof createSqliteMentalModelStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-accept-live04-"));
    adapter = new SqliteMemoryAdapter(dbConfig(tmpDir));
    store = createSqliteMentalModelStore({ db: adapter.getDb() });
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {
      /* harmless */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("a kind:'profile' and a kind:'topic' doc admit at trust=learned, and list(scope, kind) filters by kind", async () => {
    // Admit one profile doc + one topic doc directly via store.admit (the
    // source-agnostic downstream — no real LLM needed for the surface assertion).
    const profileAdmit = await store.admit(
      {
        name: "user-prefers-signal",
        description: "The user's standing profile",
        body: "Prefers Signal; on-call is Mallory.",
        mutating: false,
        kind: "profile",
        topicKey: "profile-user", // distinct topicKey so the UNIQUE tuple does not collide with the topic doc
        proofCount: 0,
        confidence: 0.9,
        sourceTrajIds: [],
        createdAt: 5_000,
      },
      SCOPE,
    );
    expect(profileAdmit.ok && profileAdmit.value.admitted).toBe(true);

    const topicAdmit = await store.admit(
      {
        name: "topic-deploy-runbook",
        description: "Accumulated knowledge about the deploy topic",
        body: "Deploys go through ./deploy --prod after a green build.",
        mutating: false,
        kind: "topic",
        topicKey: "topic-deploy",
        proofCount: 0,
        confidence: 0.9,
        sourceTrajIds: [],
        createdAt: 5_000,
      },
      SCOPE,
    );
    expect(topicAdmit.ok && topicAdmit.value.admitted).toBe(true);

    // GROUND TRUTH: both docs admitted at trust='learned' (the SEC-01 ceiling holds
    // for every kind — a profile/topic doc cannot escalate trust).
    const profileGet = await store.get("user-prefers-signal", SCOPE);
    expect(profileGet.ok && profileGet.value?.kind).toBe("profile");
    expect(profileGet.ok && profileGet.value?.trustLevel).toBe("learned");
    const topicGet = await store.get("topic-deploy-runbook", SCOPE);
    expect(topicGet.ok && topicGet.value?.kind).toBe("topic");
    expect(topicGet.ok && topicGet.value?.trustLevel).toBe("learned");

    // The kind filter HOLDS: list(scope, 'profile') returns ONLY the profile doc;
    // list(scope, 'topic') ONLY the topic doc; and a 'skill'-only list returns NEITHER.
    const profiles = await store.list(SCOPE, "profile");
    expect(profiles.ok).toBe(true);
    const profileNames = profiles.ok ? profiles.value.map((d) => d.name) : [];
    expect(profileNames).toContain("user-prefers-signal");
    expect(profileNames).not.toContain("topic-deploy-runbook");

    const topics = await store.list(SCOPE, "topic");
    const topicNames = topics.ok ? topics.value.map((d) => d.name) : [];
    expect(topicNames).toContain("topic-deploy-runbook");
    expect(topicNames).not.toContain("user-prefers-signal");

    // A skill-only list must NOT return the profile/topic docs (the filter is not a no-op).
    const skills = await store.list(SCOPE, "skill");
    const skillNames = skills.ok ? skills.value.map((d) => d.name) : [];
    expect(skillNames).not.toContain("user-prefers-signal");
    expect(skillNames).not.toContain("topic-deploy-runbook");
  });
});

// ===========================================================================
// (e) LIVE-05 — SUPERSESSION + ANTI-POISON EVICTION.
//
// THE EVICTION CAVEAT: the lifecycle SWEEP is scaffold-dormant by default (it evicts
// NOTHING unless `evictionEnabled:true`). This block drives the sweep under the LIVE
// policy (`evictionEnabled:true`, an explicit `failureEvictionFloor`/`highProofFloor`)
// — the FORGET-02 corroborated-failure eviction the design intends — NOT the dormant
// default (which would make the assertion a false green).
// ===========================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = 100 * DAY_MS;

/** Seed `memory_usefulness.failure_count` (the FORGET-02 wrongness signal the sweep reads). */
function seedFailureCount(db: ReturnType<SqliteMemoryAdapter["getDb"]>, memoryId: string, failureCount: number): void {
  db.prepare(
    `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, failure_count)
     VALUES (?, ?, ?, '', 0, 0, ?)
     ON CONFLICT(tenant_id, agent_id, memory_id, intent) DO UPDATE SET failure_count = excluded.failure_count`,
  ).run(TENANT, AGENT, memoryId, failureCount);
}

/** Seed `memory_usefulness.last_useful_at` (so dormancy keys off recency, isolating the failure disjunct). */
function seedLastUseful(db: ReturnType<SqliteMemoryAdapter["getDb"]>, memoryId: string, at: number): void {
  db.prepare(
    `INSERT INTO memory_usefulness (tenant_id, agent_id, memory_id, intent, used_count, ignored_count, last_useful_at)
     VALUES (?, ?, ?, '', 1, 0, ?)
     ON CONFLICT(tenant_id, agent_id, memory_id, intent) DO UPDATE SET used_count = excluded.used_count, last_useful_at = excluded.last_useful_at`,
  ).run(TENANT, AGENT, memoryId, at);
}

/** Insert a `memories` row with explicit proof/pinned/trust (the eviction-candidacy inputs). */
function insertMemory(
  db: ReturnType<SqliteMemoryAdapter["getDb"]>,
  opts: { id: string; content: string; occurredAt: number; proofCount?: number | null; pinned?: boolean; trustLevel?: string },
): void {
  db.prepare(
    `INSERT INTO memories
       (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, occurred_at, proof_count, pinned)
     VALUES (?, ?, ?, 'u1', ?, ?, 'semantic', 'agent', '[]', ?, ?, ?, ?)`,
  ).run(
    opts.id,
    TENANT,
    AGENT,
    opts.content,
    opts.trustLevel ?? "learned",
    opts.occurredAt,
    opts.occurredAt,
    opts.proofCount ?? null,
    opts.pinned ? 1 : 0,
  );
}

function evictedAtOf(db: ReturnType<SqliteMemoryAdapter["getDb"]>, id: string): number | null {
  return (db.prepare("SELECT evicted_at FROM memories WHERE id = ?").get(id) as { evicted_at: number | null }).evicted_at;
}

describe("LIVE-05 SUPERSESSION + ANTI-POISON EVICTION (supersede keeps history; the LIVE-policy sweep evicts poison, exempts pinned/high-proof)", () => {
  let tmpDir: string;
  let adapter: SqliteMemoryAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "comis-accept-live05-"));
    adapter = new SqliteMemoryAdapter(dbConfig(tmpDir));
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {
      /* harmless */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("SUPERSEDE: a corrected fact UPDATES content, APPENDS prior to history, and DELETES no row (non-destructive)", async () => {
    const entry = makeEntry({ id: "fact_supersede", content: "user lives in Boston", createdAt: 1_000 });
    expect((await adapter.store(entry)).ok).toBe(true);
    const countBefore = (adapter.getDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;

    const res = await adapter.supersede(entry.id, "user lives in Seattle", { tenantId: TENANT, agentId: AGENT }, 5_000);
    expect(res.ok).toBe(true);
    expect(res.ok && res.value).toBe("superseded");

    // GROUND TRUTH (raw row): content moved to C2; prior content appended to history.
    const row = adapter
      .getDb()
      .prepare("SELECT content, history FROM memories WHERE id = ? AND tenant_id = ?")
      .get(entry.id, TENANT) as { content: string; history: string | null };
    expect(row.content).toBe("user lives in Seattle");
    expect(row.history).not.toBeNull();
    const history = JSON.parse(row.history!) as Array<{ previousContent: string }>;
    expect(history).toHaveLength(1);
    expect(history[0]!.previousContent).toBe("user lives in Boston");

    // NO row deleted — supersession is a revise, not a delete (history kept).
    const countAfter = (adapter.getDb().prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
    expect(countAfter).toBe(countBefore);
  });

  it("EVICTION (LIVE policy): a corroborated low-proof memory soft-evicts; pinned + high-proof survive IDENTICAL failures (INV-4 / FORGET-03, RED both directions)", async () => {
    const db = adapter.getDb();

    // The LIVE eviction policy — the design intent (NOT the dormant default sweep).
    const lifecycle = createSqliteMemoryLifecycleStore({
      db,
      policy: { maxDormantDays: 90, evictionEnabled: true, highProofFloor: 5, failureEvictionFloor: 3 },
    });

    // POISON: a NON-exempt LOW-proof memory, RECENT (so dormancy is OFF, isolating the
    // failure disjunct), corroborated-WRONG (failure_count >= failureEvictionFloor).
    insertMemory(db, { id: "poison-low-proof", content: "a corroborated-wrong low-proof fact", occurredAt: T0 - 1 * DAY_MS, proofCount: 1 });
    seedLastUseful(db, "poison-low-proof", T0 - 1 * DAY_MS);
    seedFailureCount(db, "poison-low-proof", 8); // >> floor 3

    // EXEMPT #1 (pinned) and EXEMPT #2 (high-proof), under the SAME failure pressure.
    insertMemory(db, { id: "exempt-pinned", content: "pinned fact", occurredAt: T0 - 1 * DAY_MS, proofCount: 1, pinned: true });
    seedLastUseful(db, "exempt-pinned", T0 - 1 * DAY_MS);
    seedFailureCount(db, "exempt-pinned", 8);
    insertMemory(db, { id: "exempt-highproof", content: "well-corroborated fact", occurredAt: T0 - 1 * DAY_MS, proofCount: 20 });
    seedLastUseful(db, "exempt-highproof", T0 - 1 * DAY_MS);
    seedFailureCount(db, "exempt-highproof", 8);

    const before = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE tenant_id = ? AND agent_id = ?").get(TENANT, AGENT) as { c: number }).c;

    const res = await lifecycle.runLifecycleSweep({ tenantId: TENANT, agentId: AGENT, now: T0 });
    expect(res.ok).toBe(true);
    expect(res.ok && res.value.evicted).toBeGreaterThanOrEqual(1);

    // GROUND TRUTH — RED direction 1: the corroborated low-proof poison IS soft-evicted.
    expect(evictedAtOf(db, "poison-low-proof"), "the corroborated low-proof memory must be soft-evicted under the LIVE policy").not.toBeNull();

    // GROUND TRUTH — RED direction 2 (the anti-induced-eviction guard): pinned +
    // high-proof memories under the SAME failures are NOT evicted. A poisoner inducing
    // failures cannot evict a pinned/well-corroborated memory (INV-4 / FORGET-03).
    expect(evictedAtOf(db, "exempt-pinned"), "a pinned memory must survive identical failures").toBeNull();
    expect(evictedAtOf(db, "exempt-highproof"), "a high-proof memory must survive identical failures").toBeNull();

    // SOFT eviction (not a hard delete): the row count is unchanged — the poison row
    // still resolves via a direct read (the marker is reversible by design).
    const after = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE tenant_id = ? AND agent_id = ?").get(TENANT, AGENT) as { c: number }).c;
    expect(after).toBe(before);
  });
});
