// SPDX-License-Identifier: Apache-2.0
//
// Orchestration suite for the offline DIRECTIONAL relationship builder (Phase 108
// — SOCIAL-01, Track E2). Two units under test:
//
//   1. The agent-internal directional builder prompt + parser
//      (`memory-relationship-prompt.ts`) — the build() seam's payload shape: a
//      string → typed { subjectUserId, aboutUserId, content }[] that STRIPS any
//      model-emitted trust (trust is CODE-computed, never LLM-chosen) and drops a
//      candidate missing either directional endpoint.
//   2. `runRelationshipBuild` (`memory-relationship-job.ts`) — the offline
//      directional builder mirroring `runUserRepresentationBuild` 1:1: default-OFF
//      gate → read sources → EXCLUDE external-trust (anti-poisoning) → bound →
//      INJECTED build() seam (non-fatal) → validateMemoryWrite (skip non-clean —
//      Pitfall 2, NO downgrade-and-store) → upsert via the @comis/core port →
//      counts-only event → idempotent. The DELTA from 107: the candidate is
//      DIRECTIONAL (subjectUserId from the speaker, aboutUserId from the LLM), the
//      sourceText is SENDER-PREFIXED (`- [userId]: content`, RQ3), and the scope
//      carries channelId.
//
// The offline build() LLM is INJECTED as `deps.build` (the offline seam — it is
// NEVER on the recall hot path), so this suite needs NO pi-ai mock: `build` is a
// controllable spy returning canned RelationshipBuildOutput. The store is a FAKE
// in-memory implementation of the @comis/core RelationshipStore port — the job
// imports @comis/core TYPES only (the agent↛memory build cut), so this suite never
// needs @comis/memory.
//
// Anti-poisoning headline (SOCIAL-01): an `external`/low-trust source candidate is
// SKIPPED (filtered out BEFORE the build), NEVER downgraded-and-stored — the
// 108-02 DB CHECK forbids `external`, so an external source RED-proves 0
// relationship rows. A `warn`/`critical` validateMemoryWrite verdict is likewise
// SKIPPED (blocked++), not downgraded (Pitfall 2 — the high-trust floor has no
// landing for a non-clean entry).
import { describe, it, expect } from "vitest";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";
import type {
  RelationshipStore,
  RelationshipInput,
  RelationshipScope,
  RelationshipEntry,
  ClockPort,
} from "@comis/core";

import {
  parseRelationshipOutput,
  buildRelationshipPrompt,
  type RelationshipBuildOutput,
} from "./memory-relationship-prompt.js";
import {
  runRelationshipBuild,
  type MemoryRelationshipDeps,
  type RelationshipSourceMemory,
} from "./memory-relationship-job.js";

const NOW = 1_700_000_000_000;
const TENANT = "default";
const AGENT = "test-agent";
const CHANNEL = "channel_x";
const USER_A = "user_a";
const USER_B = "user_b";

// ---------------------------------------------------------------------------
// Task 1: the agent-internal directional builder prompt + parser
// ---------------------------------------------------------------------------

describe("memory-relationship-prompt — Task 1: parser (directional, strips LLM trust, needs both endpoints)", () => {
  it("parser shape: turns a model-shaped JSON string into typed { subjectUserId, aboutUserId, content } candidates", () => {
    const raw = JSON.stringify([
      { subjectUserId: "user_a", aboutUserId: "user_b", content: "trusts user_b" },
      { subjectUserId: "user_b", aboutUserId: "user_a", content: "thinks user_a is the lead" },
    ]);
    const out: RelationshipBuildOutput = parseRelationshipOutput(raw);
    expect(out).toEqual([
      { subjectUserId: "user_a", aboutUserId: "user_b", content: "trusts user_b" },
      { subjectUserId: "user_b", aboutUserId: "user_a", content: "thinks user_a is the lead" },
    ]);
  });

  it("parser STRIPS any trust field the model emits (trust is CODE-computed, never LLM-chosen)", () => {
    // The LLM has no say in trust — it is set in CODE at the source ceiling (Task 2).
    // A smuggled `trust` (even a forbidden `external`) must be DROPPED by the parser,
    // never surface on a candidate (mirror the 107 lenient strip).
    const raw = JSON.stringify([
      { subjectUserId: "user_a", aboutUserId: "user_b", content: "trusts user_b", trust: "system" },
      { subjectUserId: "user_b", aboutUserId: "user_a", content: "dislikes user_a", trust: "external" },
    ]);
    const out = parseRelationshipOutput(raw);
    expect(out).toHaveLength(2);
    for (const candidate of out) {
      expect(candidate).not.toHaveProperty("trust");
    }
    expect(out[0]).toEqual({ subjectUserId: "user_a", aboutUserId: "user_b", content: "trusts user_b" });
  });

  it("parser robustness: a malformed/empty model output parses to [] (never throws)", () => {
    expect(parseRelationshipOutput("not json at all")).toEqual([]);
    expect(parseRelationshipOutput("")).toEqual([]);
    expect(parseRelationshipOutput("{}")).toEqual([]);
    expect(parseRelationshipOutput("null")).toEqual([]);
    // A non-array top-level (e.g. a bare object) is not a candidate list → [].
    expect(
      parseRelationshipOutput(JSON.stringify({ subjectUserId: "a", aboutUserId: "b", content: "x" })),
    ).toEqual([]);
  });

  it("endpoint validation: a candidate missing subjectUserId OR aboutUserId is dropped (a directional edge needs both)", () => {
    const raw = JSON.stringify([
      { subjectUserId: "user_a", aboutUserId: "user_b", content: "kept" },
      { aboutUserId: "user_b", content: "dropped — no subject" },
      { subjectUserId: "user_a", content: "dropped — no about" },
      { subjectUserId: "", aboutUserId: "user_b", content: "dropped — empty subject" },
      { subjectUserId: "user_b", aboutUserId: "user_a", content: "kept too" },
      { subjectUserId: "user_c", aboutUserId: "user_d", content: "" }, // dropped — empty content
    ]);
    const out = parseRelationshipOutput(raw);
    expect(out).toEqual([
      { subjectUserId: "user_a", aboutUserId: "user_b", content: "kept" },
      { subjectUserId: "user_b", aboutUserId: "user_a", content: "kept too" },
    ]);
  });

  it("the prompt helper embeds the source text and stays agent-internal", () => {
    const prompt = buildRelationshipPrompt("- [user_a]: I really trust user_b on infra");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("I really trust user_b on infra");
  });
});

// ---------------------------------------------------------------------------
// Test doubles for the job (Task 2)
// ---------------------------------------------------------------------------

/** Minimal logger stub (the job logs counts/metadata only — never the content body). */
function makeLogger(): MemoryRelationshipDeps["logger"] {
  return {
    info: (..._a: unknown[]) => {},
    debug: (..._a: unknown[]) => {},
    warn: (..._a: unknown[]) => {},
    error: (..._a: unknown[]) => {},
  } as unknown as MemoryRelationshipDeps["logger"];
}

/** A spying event sink — records every (event, payload) the job emits. */
function makeEventBus(): {
  emit: (e: string, p: unknown) => void;
  events: Array<{ event: string; payload: unknown }>;
} {
  const events: Array<{ event: string; payload: unknown }> = [];
  return { emit: (event, payload) => events.push({ event, payload }), events };
}

/** A controllable, deterministic injected clock (NEVER a wall-clock global). */
function makeClock(): ClockPort {
  return { now: () => NOW, nowDate: () => new Date(NOW) } as ClockPort;
}

/**
 * A FAKE in-memory RelationshipStore implementing the @comis/core port. Keeps the
 * suite @comis/memory-free (the agent↛memory cut). `upsert` is idempotent per the
 * DIRECTIONAL key (subjectUserId, aboutUserId, content) so a re-run over identical
 * candidates does NOT grow the row set — mirroring the 108-02 adapter's
 * upsert-replace contract; A→B and B→A are DISTINCT keys (never collapsed).
 * `upsertCalls` records every entry the job tried to write (the bound/skip proofs).
 */
function makeFakeStore(): {
  store: RelationshipStore;
  rows: RelationshipEntry[];
  upsertCalls: RelationshipInput[];
} {
  const rows: RelationshipEntry[] = [];
  const upsertCalls: RelationshipInput[] = [];
  const store: RelationshipStore = {
    async upsert(entry: RelationshipInput, scope: RelationshipScope): Promise<Result<void, Error>> {
      upsertCalls.push(entry);
      const key = `${entry.subjectUserId}::${entry.aboutUserId}::${entry.content}`;
      const existing = rows.find(
        (r) => `${r.subjectUserId}::${r.aboutUserId}::${r.content}` === key,
      );
      if (existing) {
        existing.trust = entry.trust;
        existing.updatedAt = scope.now;
        return ok(undefined);
      }
      rows.push({
        id: `row-${rows.length}`,
        subjectUserId: entry.subjectUserId,
        aboutUserId: entry.aboutUserId,
        content: entry.content,
        trust: entry.trust,
        ...(entry.sourceMemoryId !== undefined ? { sourceMemoryId: entry.sourceMemoryId } : {}),
        createdAt: scope.now,
      });
      return ok(undefined);
    },
    async read(): Promise<Result<RelationshipEntry[], Error>> {
      return ok([...rows]);
    },
  };
  return { store, rows, upsertCalls };
}

/** A spying build() seam — records every source text it is called with. */
function makeBuildSpy(impl: (text: string) => RelationshipBuildOutput = () => []): {
  build: MemoryRelationshipDeps["build"];
  calls: string[];
} {
  const calls: string[] = [];
  const build = (async (text: string) => {
    calls.push(text);
    return impl(text);
  }) as MemoryRelationshipDeps["build"];
  return { build, calls };
}

const baseConfig = { enabled: true, maxEntriesPerRun: 25 };

function makeSource(overrides: Partial<RelationshipSourceMemory>): RelationshipSourceMemory {
  return {
    id: overrides.id ?? "mem-1",
    userId: overrides.userId ?? USER_A,
    content: overrides.content ?? "neutral source content",
    trustLevel: overrides.trustLevel ?? "learned",
  };
}

function makeDeps(
  overrides: Partial<MemoryRelationshipDeps> & {
    sources?: RelationshipSourceMemory[];
  } = {},
): MemoryRelationshipDeps {
  const sources = overrides.sources ?? [];
  return {
    agentId: AGENT,
    tenantId: TENANT,
    channelId: CHANNEL,
    config: { ...baseConfig, ...(overrides.config ?? {}) },
    relationshipStore: overrides.relationshipStore ?? makeFakeStore().store,
    readSources: overrides.readSources ?? (async () => ok(sources)),
    clock: overrides.clock ?? makeClock(),
    logger: overrides.logger ?? makeLogger(),
    eventBus: overrides.eventBus ?? makeEventBus(),
    build: overrides.build ?? makeBuildSpy().build,
  };
}

// ---------------------------------------------------------------------------
// Task 2: runRelationshipBuild — gate / anti-poisoning / directional / validate-skip / bound
// ---------------------------------------------------------------------------

describe("runRelationshipBuild — Task 2: gate / anti-poisoning / directional / validate-skip / bound / counts-only", () => {
  it("default-off: enabled:false → the build seam is NEVER called, NOTHING is written, a zeros event fires, returns ok", async () => {
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "trusts user_b" },
    ]);
    const fake = makeFakeStore();
    const bus = makeEventBus();
    const deps = makeDeps({
      config: { ...baseConfig, enabled: false },
      build: buildSpy.build,
      relationshipStore: fake.store,
      eventBus: bus,
      sources: [makeSource({ userId: USER_A, content: "I trust user_b on infra", trustLevel: "learned" })],
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(true);
    // The cost gate: the injected build() LLM is NEVER called when off (no spend).
    expect(buildSpy.calls).toHaveLength(0);
    // No write of any kind.
    expect(fake.rows).toHaveLength(0);
    expect(fake.upsertCalls).toHaveLength(0);
    if (result.ok) expect(result.value.written).toBe(0);
    // A counts-only zeros event still fires.
    const ev = bus.events.find((e) => e.event === "memory:relationship_built");
    expect(ev).toBeDefined();
    expect((ev?.payload as { written: number }).written).toBe(0);
  });

  it("directional round-trip: a single A→B candidate upserts ONE directional edge scoped to (tenant, agent, channel)", async () => {
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "trusts user_b on infra" },
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      relationshipStore: fake.store,
      sources: [
        makeSource({ id: "m1", userId: USER_A, content: "I really trust user_b on infra", trustLevel: "learned" }),
        makeSource({ id: "m2", userId: USER_B, content: "user_a knows the deploy pipeline", trustLevel: "learned" }),
      ],
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.written).toBe(1);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.subjectUserId).toBe(USER_A);
    expect(fake.rows[0]?.aboutUserId).toBe(USER_B);
    // Trust is CODE-computed at the source ceiling — NEVER `external`, NEVER LLM-chosen.
    expect(fake.rows[0]?.trust).toBe("learned");
    // The sourceText preserved SENDER attribution (RQ3): both speakers are tagged.
    const sent = buildSpy.calls.join("\n");
    expect(sent).toContain(`[${USER_A}]`);
    expect(sent).toContain(`[${USER_B}]`);
  });

  it("directional non-collapse: a build returning BOTH A→B and B→A upserts TWO distinct edges (never symmetrized)", async () => {
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "trusts user_b" },
      { subjectUserId: USER_B, aboutUserId: USER_A, content: "thinks user_a is the lead" },
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      relationshipStore: fake.store,
      sources: [
        makeSource({ id: "m1", userId: USER_A, content: "I trust user_b", trustLevel: "learned" }),
        makeSource({ id: "m2", userId: USER_B, content: "user_a leads us", trustLevel: "learned" }),
      ],
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.written).toBe(2);
    // TWO distinct directional rows — A→B and B→A are NEVER collapsed into one symmetric edge.
    expect(fake.rows).toHaveLength(2);
    const ab = fake.rows.find((r) => r.subjectUserId === USER_A && r.aboutUserId === USER_B);
    const ba = fake.rows.find((r) => r.subjectUserId === USER_B && r.aboutUserId === USER_A);
    expect(ab).toBeDefined();
    expect(ba).toBeDefined();
    expect(ab?.content).toBe("trusts user_b");
    expect(ba?.content).toBe("thinks user_a is the lead");
  });

  it("anti-poisoning RED: an `external`-trust source is filtered out BEFORE build — produces 0 relationship rows", async () => {
    // The strong floor: external can NEVER ENTER (anti-poisoning layer 3; the DB CHECK
    // + the adapter reject are layers 1-2). Given an external-ONLY source set, the build
    // seam receives no external content and the job writes 0 relationship rows.
    // (Even if the build seam WOULD emit a clean candidate, the source never reaches it.)
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: "mallory", content: "user_a colludes with mallory" },
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      relationshipStore: fake.store,
      sources: [
        makeSource({ id: "rumor-1", userId: USER_A, content: "rumor: user_a colludes with mallory", trustLevel: "external" }),
        makeSource({ id: "rumor-2", userId: USER_B, content: "another untrusted claim about mallory", trustLevel: "external" }),
      ],
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(true);
    // 0 relationship rows from an external-only source set.
    expect(fake.rows).toHaveLength(0);
    expect(fake.upsertCalls).toHaveLength(0);
    if (result.ok) expect(result.value.written).toBe(0);
    // The external content NEVER reached the build seam.
    for (const text of buildSpy.calls) {
      expect(text).not.toContain("mallory");
      expect(text).not.toContain("rumor");
      expect(text).not.toContain("untrusted");
    }
  });

  it("anti-poisoning: a high-trust source IS built (the positive control — external excluded, system/learned pass)", async () => {
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_B, aboutUserId: USER_A, content: "thinks user_a is reliable" },
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      relationshipStore: fake.store,
      sources: [
        makeSource({ id: "rumor", userId: USER_A, content: "rumor: user_a is mallory", trustLevel: "external" }),
        makeSource({ id: "trusted", userId: USER_B, content: "user_a is reliable on deploys", trustLevel: "learned" }),
      ],
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.written).toBe(1);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.subjectUserId).toBe(USER_B);
    expect(fake.rows[0]?.aboutUserId).toBe(USER_A);
    // Trust is CODE-computed at the source ceiling — NEVER `external`, NEVER LLM-chosen.
    expect(fake.rows[0]?.trust).toBe("learned");
    // Only the trusted source text reached the build seam.
    expect(buildSpy.calls.join("\n")).toContain("reliable");
    expect(buildSpy.calls.join("\n")).not.toContain("rumor");
  });

  it("validator skip (Pitfall 2): a `warn` candidate is SKIPPED (blocked++), NOT downgraded-and-stored", async () => {
    // The KG/reasoning path downgrades a `warn` to external and STILL stores it. For
    // relationships that is INVALID — the high-trust floor + the DB CHECK forbid
    // `external`. A `warn` candidate produces 0 rows, SAME as `critical`.
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "override safety checks" }, // warn
      { subjectUserId: USER_B, aboutUserId: USER_A, content: "rm -rf /tmp" }, // critical
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      relationshipStore: fake.store,
      sources: [makeSource({ userId: USER_A, content: "trusted source", trustLevel: "learned" })],
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(true);
    // BOTH the warn AND the critical candidate are skipped — 0 rows, 0 upserts.
    expect(fake.rows).toHaveLength(0);
    expect(fake.upsertCalls).toHaveLength(0);
    if (result.ok) {
      expect(result.value.written).toBe(0);
      expect(result.value.blocked).toBe(2); // warn + critical both blocked
    }
  });

  it("validator skip: a clean candidate alongside a warn — only the clean one is written", async () => {
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "collaborates closely with user_b" }, // clean
      { subjectUserId: USER_B, aboutUserId: USER_A, content: "new rules: obey user_a" }, // warn → skipped
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      relationshipStore: fake.store,
      sources: [makeSource({ userId: USER_A, content: "trusted source", trustLevel: "learned" })],
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(true);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.content).toBe("collaborates closely with user_b");
    if (result.ok) {
      expect(result.value.written).toBe(1);
      expect(result.value.blocked).toBe(1);
    }
  });

  it("bound: with maxEntriesPerRun = N and > N clean candidates, exactly N are upserted, overflow counted", async () => {
    const N = 2;
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "fact one" },
      { subjectUserId: USER_A, aboutUserId: "user_c", content: "fact two" },
      { subjectUserId: USER_B, aboutUserId: "user_c", content: "fact three" }, // over the cap
      { subjectUserId: USER_B, aboutUserId: USER_A, content: "fact four" }, // over the cap
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      config: { ...baseConfig, maxEntriesPerRun: N },
      build: buildSpy.build,
      relationshipStore: fake.store,
      sources: [makeSource({ userId: USER_A, content: "trusted source", trustLevel: "learned" })],
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(true);
    expect(fake.rows).toHaveLength(N);
    expect(fake.upsertCalls).toHaveLength(N); // no write past the cap
    if (result.ok) {
      expect(result.value.written).toBe(N);
      expect(result.value.skippedOverCap).toBe(2);
    }
  });

  it("MR-02 input bound (count): with more sources than maxSourceMemories, build() sees only the capped HEAD and the event flags truncation", async () => {
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "distilled" },
    ]);
    const fake = makeFakeStore();
    const bus = makeEventBus();
    // 5 sources, cap of 2: only the first 2 (newest-first) reach build().
    const sources = [
      makeSource({ id: "s0", userId: USER_A, content: "SRC_KEEP_0", trustLevel: "learned" }),
      makeSource({ id: "s1", userId: USER_B, content: "SRC_KEEP_1", trustLevel: "learned" }),
      makeSource({ id: "s2", userId: USER_A, content: "SRC_DROP_2", trustLevel: "learned" }),
      makeSource({ id: "s3", userId: USER_B, content: "SRC_DROP_3", trustLevel: "learned" }),
      makeSource({ id: "s4", userId: USER_A, content: "SRC_DROP_4", trustLevel: "learned" }),
    ];
    const deps = makeDeps({
      config: { ...baseConfig, maxSourceMemories: 2 },
      build: buildSpy.build,
      relationshipStore: fake.store,
      eventBus: bus,
      sources,
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(true);
    expect(buildSpy.calls).toHaveLength(1);
    const sentText = buildSpy.calls[0]!;
    expect(sentText).toContain("SRC_KEEP_0");
    expect(sentText).toContain("SRC_KEEP_1");
    expect(sentText).not.toContain("SRC_DROP_2");
    expect(sentText).not.toContain("SRC_DROP_3");
    expect(sentText).not.toContain("SRC_DROP_4");
    const ev = bus.events.find((e) => e.event === "memory:relationship_built");
    const payload = ev?.payload as {
      sourcesConsidered: number;
      sourcesUsed: number;
      sourcesTruncated: boolean;
    };
    expect(payload.sourcesConsidered).toBe(5);
    expect(payload.sourcesUsed).toBe(2);
    expect(payload.sourcesTruncated).toBe(true);
    // It carries NO source CONTENT (counts-only, §2.7).
    expect(JSON.stringify(ev?.payload)).not.toContain("SRC_");
  });

  it("counts-only event: the emitted payload carries counts/metadata ONLY — never candidate content or the user pair as content", async () => {
    const SECRET_CONTENT = "user_a privately confides in user_b about the merger";
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: SECRET_CONTENT },
    ]);
    const fake = makeFakeStore();
    const bus = makeEventBus();
    const deps = makeDeps({
      build: buildSpy.build,
      relationshipStore: fake.store,
      eventBus: bus,
      sources: [makeSource({ userId: USER_A, content: "user_a trusts user_b", trustLevel: "learned" })],
    });

    await runRelationshipBuild(deps);

    const ev = bus.events.find((e) => e.event === "memory:relationship_built");
    expect(ev).toBeDefined();
    const serialized = JSON.stringify(ev?.payload);
    // The serialized event payload contains NO candidate content (counts-only, §2.7).
    expect(serialized).not.toContain("merger");
    expect(serialized).not.toContain("confides");
    expect(serialized).not.toContain(SECRET_CONTENT);
    // It DOES carry the counts.
    const payload = ev?.payload as { written: number; blocked: number; skippedOverCap: number };
    expect(payload.written).toBe(1);
    expect(typeof payload.blocked).toBe("number");
    expect(typeof payload.skippedOverCap).toBe("number");
  });

  it("read failure is FATAL → err (the job cannot safely proceed over an unknown source set)", async () => {
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "x" },
    ]);
    const deps = makeDeps({
      build: buildSpy.build,
      readSources: async () => ({ ok: false as const, error: new Error("db read failed") }),
    });

    const result = await runRelationshipBuild(deps);

    expect(result.ok).toBe(false);
    // The build seam is never reached when the source read fails.
    expect(buildSpy.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 2 (cont.): idempotency (re-run over unchanged sources writes 0 new)
// ---------------------------------------------------------------------------

describe("runRelationshipBuild — Task 2: idempotency (re-run over unchanged sources writes 0 new)", () => {
  it("idempotent re-run: a second run over the SAME unchanged source set writes 0 new", async () => {
    const sources = [
      makeSource({ id: "m1", userId: USER_A, content: "user_a trusts user_b", trustLevel: "learned" }),
      makeSource({ id: "m2", userId: USER_B, content: "user_b respects user_a", trustLevel: "learned" }),
    ];
    const buildSpy = makeBuildSpy(() => [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "trusts user_b" },
      { subjectUserId: USER_B, aboutUserId: USER_A, content: "respects user_a" },
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      relationshipStore: fake.store,
      sources,
    });

    const first = await runRelationshipBuild(deps);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.written).toBeGreaterThan(0);
    const writtenAfterFirst = fake.rows.length;
    expect(writtenAfterFirst).toBe(2);

    // Re-run over the SAME unchanged source set.
    const second = await runRelationshipBuild(deps);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.written).toBe(0); // 0 NEW writes
    // The row set did not grow.
    expect(fake.rows.length).toBe(writtenAfterFirst);
  });

  it("changed source → new write: a NEW directional candidate writes for the new edge only", async () => {
    const sources: RelationshipSourceMemory[] = [
      makeSource({ id: "m1", userId: USER_A, content: "user_a trusts user_b", trustLevel: "learned" }),
    ];
    const fake = makeFakeStore();
    let buildOutput: RelationshipBuildOutput = [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "trusts user_b" },
    ];
    const buildSpy = makeBuildSpy(() => buildOutput);
    const deps = makeDeps({
      build: buildSpy.build,
      relationshipStore: fake.store,
      readSources: async () => ok(sources),
    });

    const first = await runRelationshipBuild(deps);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.written).toBe(1);
    expect(fake.rows.length).toBe(1);

    // Add a NEW high-trust source; the build now yields a new directional candidate.
    sources.push(makeSource({ id: "m2", userId: USER_B, content: "user_b respects user_a", trustLevel: "learned" }));
    buildOutput = [
      { subjectUserId: USER_A, aboutUserId: USER_B, content: "trusts user_b" }, // unchanged
      { subjectUserId: USER_B, aboutUserId: USER_A, content: "respects user_a" }, // new
    ];

    const second = await runRelationshipBuild(deps);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.written).toBe(1);
    expect(fake.rows.length).toBe(2);
    expect(
      fake.rows.some((r) => r.subjectUserId === USER_B && r.aboutUserId === USER_A && r.content === "respects user_a"),
    ).toBe(true);
  });
});
