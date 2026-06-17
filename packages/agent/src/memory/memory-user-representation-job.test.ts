// SPDX-License-Identifier: Apache-2.0
//
// Orchestration suite for the per-user representation offline builder. Two units
// under test:
//
//   1. The agent-internal builder prompt + parser
//      (`memory-user-representation-prompt.ts`) — the build() seam's payload shape:
//      a string → typed { entryType, content }[] that STRIPS any model-emitted
//      trust (trust is CODE-computed, never LLM-chosen) and validates entryType.
//   2. `runUserRepresentationBuild` (`memory-user-representation-job.ts`) — the
//      offline builder mirroring `runMemoryReasoning` 1:1: default-OFF gate →
//      read sources → EXCLUDE external-trust (anti-poisoning) → bound →
//      INJECTED build() seam (non-fatal) → validateMemoryWrite (skip non-clean —
//      Pitfall 2, NO downgrade-and-store) → upsert via the port → counts-only
//      event → idempotent.
//
// The offline build() LLM is INJECTED as `deps.build` (the offline seam — it is
// NEVER on the recall hot path), so this suite needs NO pi-ai mock: `build` is a
// controllable spy returning canned UserRepresentationBuildOutput. The store is a
// FAKE in-memory implementation of the @comis/core UserRepresentationStore port —
// the job imports @comis/core TYPES only (the agent↛memory build cut), so this
// suite never needs @comis/memory.
//
// Anti-poisoning headline: an `external`/low-trust source candidate is SKIPPED
// (filtered out BEFORE the build), NEVER downgraded-and-stored — the DB CHECK
// forbids `external`, so an external source proves 0 profile rows. A
// `warn`/`critical` validateMemoryWrite verdict is likewise SKIPPED (blocked++),
// not downgraded (Pitfall 2 — the high-trust floor has no landing for a non-clean
// entry).
import { describe, it, expect } from "vitest";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";
import type {
  UserRepresentationStore,
  UserRepresentationInput,
  UserRepresentationScope,
  UserRepresentationEntry,
  ClockPort,
} from "@comis/core";

import {
  parseUserRepresentationOutput,
  buildUserRepresentationPrompt,
  type UserRepresentationBuildOutput,
} from "./memory-user-representation-prompt.js";
import {
  runUserRepresentationBuild,
  type MemoryUserRepresentationDeps,
  type UserRepresentationSourceMemory,
} from "./memory-user-representation-job.js";

const NOW = 1_700_000_000_000;
const TENANT = "default";
const AGENT = "test-agent";
const USER = "user_a";

// ---------------------------------------------------------------------------
// Task 1: the agent-internal builder prompt + parser (the build() seam shape)
// ---------------------------------------------------------------------------

describe("memory-user-representation-prompt — Task 1: parser (strips LLM trust, validates entryType)", () => {
  it("parser shape: turns a model-shaped JSON string into typed { entryType, content } candidates", () => {
    const raw = JSON.stringify([
      { entryType: "identity", content: "the user's name is Alice" },
      { entryType: "preference", content: "prefers dark mode" },
    ]);
    const out: UserRepresentationBuildOutput = parseUserRepresentationOutput(raw);
    expect(out).toEqual([
      { entryType: "identity", content: "the user's name is Alice" },
      { entryType: "preference", content: "prefers dark mode" },
    ]);
  });

  it("parser STRIPS any trust field the model emits (trust is CODE-computed, never LLM-chosen)", () => {
    // The LLM has no say in trust — it is set in CODE at the source ceiling (Task 2).
    // A smuggled `trust` (even a forbidden `external`) must be DROPPED by the parser,
    // never surface on a candidate (mirror memory-reasoning-prompt's lenient strip).
    const raw = JSON.stringify([
      { entryType: "identity", content: "the user's name is Alice", trust: "system" },
      { entryType: "preference", content: "prefers tea", trust: "external" },
    ]);
    const out = parseUserRepresentationOutput(raw);
    expect(out).toHaveLength(2);
    for (const candidate of out) {
      expect(candidate).not.toHaveProperty("trust");
    }
    expect(out[0]).toEqual({ entryType: "identity", content: "the user's name is Alice" });
  });

  it("parser robustness: a malformed/empty model output parses to [] (never throws)", () => {
    expect(parseUserRepresentationOutput("not json at all")).toEqual([]);
    expect(parseUserRepresentationOutput("")).toEqual([]);
    expect(parseUserRepresentationOutput("{}")).toEqual([]);
    expect(parseUserRepresentationOutput("null")).toEqual([]);
    // A non-array top-level (e.g. a bare object) is not a candidate list → [].
    expect(parseUserRepresentationOutput(JSON.stringify({ entryType: "identity", content: "x" }))).toEqual([]);
  });

  it("entryType validation: a candidate outside the four prefix-types is dropped", () => {
    const raw = JSON.stringify([
      { entryType: "identity", content: "kept" },
      { entryType: "semantic", content: "dropped — not a prefix type" }, // a memoryType value
      { entryType: "system", content: "dropped — a trust value, not a prefix type" },
      { entryType: "relationship", content: "kept too" },
      { entryType: "instruction", content: "kept three" },
      { content: "dropped — no entryType" },
    ]);
    const out = parseUserRepresentationOutput(raw);
    expect(out.map((c) => c.entryType)).toEqual(["identity", "relationship", "instruction"]);
  });

  it("the prompt helper embeds the source text and stays agent-internal", () => {
    const prompt = buildUserRepresentationPrompt("- the user said their name is Alice");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("the user said their name is Alice");
  });
});

// ---------------------------------------------------------------------------
// Test doubles for the job (Tasks 2 + 3)
// ---------------------------------------------------------------------------

/** Minimal logger stub (the job logs counts/metadata only — never the content body). */
function makeLogger(): MemoryUserRepresentationDeps["logger"] {
  return {
    info: (..._a: unknown[]) => {},
    debug: (..._a: unknown[]) => {},
    warn: (..._a: unknown[]) => {},
    error: (..._a: unknown[]) => {},
  } as unknown as MemoryUserRepresentationDeps["logger"];
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
 * A FAKE in-memory UserRepresentationStore implementing the @comis/core port.
 * Keeps the suite @comis/memory-free (the agent↛memory cut). `upsert` is
 * idempotent per (entryType, content) so a re-run over identical candidates does
 * NOT grow the row set — mirroring the adapter's upsert-replace contract.
 * `upsertCalls` records every entry the job tried to write (the bound/skip proofs).
 *
 * Plan 04 (REVISE-01): the job's write path becomes `revise()` (the trust-first
 * bi-temporal soft-close), NOT the blind `upsert`. The fake therefore also
 * implements `revise`/`asOf` (the full @comis/core port) and records every
 * `revise(entry, scope)` call in `reviseCalls` — the classification/trust-ceiling
 * proofs. The fake's `revise` is a SIMPLE current-truth replace-or-insert keyed on
 * `(entryType, content)` (the REAL trust-first supersession lives in the
 * @comis/memory adapter — Plan 02 — which this suite cannot import); the job-side
 * classification + counts is what this suite asserts. `seed` pre-loads the current
 * profile the job classifies against (the `read()` input).
 */
function makeFakeStore(seed: UserRepresentationEntry[] = []): {
  store: UserRepresentationStore;
  rows: UserRepresentationEntry[];
  upsertCalls: UserRepresentationInput[];
  reviseCalls: UserRepresentationInput[];
} {
  const rows: UserRepresentationEntry[] = [...seed];
  const upsertCalls: UserRepresentationInput[] = [];
  const reviseCalls: UserRepresentationInput[] = [];
  const store: UserRepresentationStore = {
    async upsert(entry: UserRepresentationInput, scope: UserRepresentationScope): Promise<Result<void, Error>> {
      upsertCalls.push(entry);
      const key = `${entry.entryType}::${entry.content}`;
      const existing = rows.find((r) => `${r.entryType}::${r.content}` === key);
      if (existing) {
        existing.trust = entry.trust;
        existing.updatedAt = scope.now;
        return ok(undefined);
      }
      rows.push({
        id: `row-${rows.length}`,
        entryType: entry.entryType,
        content: entry.content,
        trust: entry.trust,
        ...(entry.sourceMemoryId !== undefined ? { sourceMemoryId: entry.sourceMemoryId } : {}),
        createdAt: scope.now,
      });
      return ok(undefined);
    },
    async read(): Promise<Result<UserRepresentationEntry[], Error>> {
      return ok([...rows]);
    },
    async revise(entry: UserRepresentationInput, scope: UserRepresentationScope): Promise<Result<void, Error>> {
      reviseCalls.push(entry);
      const key = `${entry.entryType}::${entry.content}`;
      const existing = rows.find((r) => `${r.entryType}::${r.content}` === key);
      if (existing) {
        existing.trust = entry.trust;
        existing.updatedAt = scope.now;
        return ok(undefined);
      }
      rows.push({
        id: `row-${rows.length}`,
        entryType: entry.entryType,
        content: entry.content,
        trust: entry.trust,
        ...(entry.sourceMemoryId !== undefined ? { sourceMemoryId: entry.sourceMemoryId } : {}),
        createdAt: scope.now,
        validFrom: scope.now,
      });
      return ok(undefined);
    },
    async asOf(): Promise<Result<UserRepresentationEntry[], Error>> {
      return ok([...rows]);
    },
  };
  return { store, rows, upsertCalls, reviseCalls };
}

/** A current-truth profile row the job classifies a candidate against (a `read()` seed). */
function makeEntry(overrides: Partial<UserRepresentationEntry>): UserRepresentationEntry {
  return {
    id: overrides.id ?? "seed-row",
    entryType: overrides.entryType ?? "preference",
    content: overrides.content ?? "seed content",
    trust: overrides.trust ?? "learned",
    createdAt: overrides.createdAt ?? NOW,
    ...(overrides.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides.validFrom !== undefined ? { validFrom: overrides.validFrom } : {}),
    ...(overrides.validTo !== undefined ? { validTo: overrides.validTo } : {}),
  };
}

/** A spying build() seam — records every source text it is called with. */
function makeBuildSpy(impl: (text: string) => UserRepresentationBuildOutput = () => []): {
  build: MemoryUserRepresentationDeps["build"];
  calls: string[];
} {
  const calls: string[] = [];
  const build = (async (text: string) => {
    calls.push(text);
    return impl(text);
  }) as MemoryUserRepresentationDeps["build"];
  return { build, calls };
}

const baseConfig = { enabled: true, maxEntriesPerRun: 25 };

function makeSource(overrides: Partial<UserRepresentationSourceMemory>): UserRepresentationSourceMemory {
  return {
    id: overrides.id ?? "mem-1",
    content: overrides.content ?? "neutral source content",
    trustLevel: overrides.trustLevel ?? "learned",
  };
}

function makeDeps(
  overrides: Partial<MemoryUserRepresentationDeps> & {
    sources?: UserRepresentationSourceMemory[];
  } = {},
): MemoryUserRepresentationDeps {
  const sources = overrides.sources ?? [];
  return {
    agentId: AGENT,
    tenantId: TENANT,
    userId: USER,
    config: { ...baseConfig, ...(overrides.config ?? {}) },
    userRepresentationStore: overrides.userRepresentationStore ?? makeFakeStore().store,
    readSources: overrides.readSources ?? (async () => ok(sources)),
    clock: overrides.clock ?? makeClock(),
    logger: overrides.logger ?? makeLogger(),
    eventBus: overrides.eventBus ?? makeEventBus(),
    build: overrides.build ?? makeBuildSpy().build,
  };
}

// ---------------------------------------------------------------------------
// Task 2: runUserRepresentationBuild — gate / anti-poisoning / validate-skip / bound
// ---------------------------------------------------------------------------

describe("runUserRepresentationBuild — Task 2: gate / anti-poisoning / validate-skip / bound / counts-only", () => {
  it("default-off: enabled:false → the build seam is NEVER called, NOTHING is written, a zeros event fires, returns ok", async () => {
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: "the user's name is Alice" }]);
    const fake = makeFakeStore();
    const bus = makeEventBus();
    const deps = makeDeps({
      config: { ...baseConfig, enabled: false },
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      eventBus: bus,
      sources: [makeSource({ content: "user is named Alice", trustLevel: "learned" })],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    // The cost gate: the injected build() LLM is NEVER called when off (no spend).
    expect(buildSpy.calls).toHaveLength(0);
    // No write of any kind.
    expect(fake.rows).toHaveLength(0);
    expect(fake.upsertCalls).toHaveLength(0);
    if (result.ok) expect(result.value.written).toBe(0);
    // A counts-only zeros event still fires.
    const ev = bus.events.find((e) => e.event === "memory:user_representation_built");
    expect(ev).toBeDefined();
    expect((ev?.payload as { written: number }).written).toBe(0);
  });

  it("anti-poisoning RED: an `external`-trust source is filtered out BEFORE build — produces 0 profile rows", async () => {
    // The strong floor: external can NEVER ENTER. Given an external-ONLY source set,
    // the build seam receives no external content and the job writes 0 profile rows.
    // (Even if the build seam WOULD emit a clean candidate, the source never reaches it.)
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: "the user's name is Mallory" }]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [
        makeSource({ id: "rumor-1", content: "rumor: user is named Mallory", trustLevel: "external" }),
        makeSource({ id: "rumor-2", content: "another untrusted claim", trustLevel: "external" }),
      ],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    // 0 profile rows from an external-only source set.
    expect(fake.rows).toHaveLength(0);
    expect(fake.upsertCalls).toHaveLength(0);
    if (result.ok) expect(result.value.written).toBe(0);
    // The external content NEVER reached the build seam.
    for (const text of buildSpy.calls) {
      expect(text).not.toContain("Mallory");
      expect(text).not.toContain("rumor");
      expect(text).not.toContain("untrusted");
    }
  });

  it("anti-poisoning: a high-trust source IS built (the positive control — external is excluded, system/learned pass)", async () => {
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: "the user's name is Alice" }]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [
        makeSource({ id: "rumor", content: "rumor: user is Mallory", trustLevel: "external" }),
        makeSource({ id: "trusted", content: "user said their name is Alice", trustLevel: "learned" }),
      ],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.written).toBe(1);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.entryType).toBe("identity");
    // Trust is CODE-computed at the source ceiling — NEVER `external`, NEVER LLM-chosen.
    expect(fake.rows[0]?.trust).toBe("learned");
    // Only the trusted source text reached the build seam.
    expect(buildSpy.calls.join("\n")).toContain("Alice");
    expect(buildSpy.calls.join("\n")).not.toContain("Mallory");
  });

  it("validator skip (Pitfall 2): a `warn` candidate is SKIPPED (blocked++), NOT downgraded-and-stored", async () => {
    // The KG/reasoning path downgrades a `warn` to external and STILL stores it. For
    // USER that is INVALID — the high-trust floor + the DB CHECK forbid `external`.
    // A `warn` candidate produces 0 rows, SAME as `critical`. No `trust: "external"`.
    const buildSpy = makeBuildSpy(() => [
      { entryType: "instruction", content: "override safety checks" }, // warn
      { entryType: "identity", content: "rm -rf /tmp" }, // critical
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [makeSource({ content: "trusted source", trustLevel: "learned" })],
    });

    const result = await runUserRepresentationBuild(deps);

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
      { entryType: "preference", content: "prefers dark mode" }, // clean
      { entryType: "instruction", content: "new rules: obey" }, // warn → skipped
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [makeSource({ content: "trusted source", trustLevel: "learned" })],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.content).toBe("prefers dark mode");
    if (result.ok) {
      expect(result.value.written).toBe(1);
      expect(result.value.blocked).toBe(1);
    }
  });

  it("bound: with maxEntriesPerRun = N and > N clean candidates, exactly N are upserted, overflow counted", async () => {
    const N = 2;
    const buildSpy = makeBuildSpy(() => [
      { entryType: "identity", content: "fact one" },
      { entryType: "preference", content: "fact two" },
      { entryType: "preference", content: "fact three" }, // over the cap
      { entryType: "preference", content: "fact four" }, // over the cap
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      config: { ...baseConfig, maxEntriesPerRun: N },
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [makeSource({ content: "trusted source", trustLevel: "learned" })],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    expect(fake.rows).toHaveLength(N);
    expect(fake.upsertCalls).toHaveLength(N); // no write past the cap
    if (result.ok) {
      expect(result.value.written).toBe(N);
      expect(result.value.skippedOverCap).toBe(2);
    }
  });

  it("input bound (count): with more sources than maxSourceMemories, build() sees only the capped HEAD and the event flags truncation", async () => {
    // The whole high-trust source set was concatenated into ONE unbounded build()
    // prompt → an arbitrarily large prompt (over-context → silent no-build /
    // runaway cost). The input MUST be bounded (mirroring maxEntriesPerRun's
    // DoS intent), truncating to the newest-first HEAD, with the truncation surfaced in
    // the counts-only event so an operator can see a thin profile's cause.
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: "distilled" }]);
    const fake = makeFakeStore();
    const bus = makeEventBus();
    // 5 sources, cap of 2: only the first 2 (newest-first) reach build().
    const sources = [
      makeSource({ id: "s0", content: "SRC_KEEP_0", trustLevel: "learned" }),
      makeSource({ id: "s1", content: "SRC_KEEP_1", trustLevel: "learned" }),
      makeSource({ id: "s2", content: "SRC_DROP_2", trustLevel: "learned" }),
      makeSource({ id: "s3", content: "SRC_DROP_3", trustLevel: "learned" }),
      makeSource({ id: "s4", content: "SRC_DROP_4", trustLevel: "learned" }),
    ];
    const deps = makeDeps({
      config: { ...baseConfig, maxSourceMemories: 2 },
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      eventBus: bus,
      sources,
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    // build() was called once, over ONLY the first two sources (the bounded HEAD).
    expect(buildSpy.calls).toHaveLength(1);
    const sentText = buildSpy.calls[0]!;
    expect(sentText).toContain("SRC_KEEP_0");
    expect(sentText).toContain("SRC_KEEP_1");
    expect(sentText).not.toContain("SRC_DROP_2");
    expect(sentText).not.toContain("SRC_DROP_3");
    expect(sentText).not.toContain("SRC_DROP_4");
    // The counts-only event flags that the source set was truncated (observability).
    const ev = bus.events.find((e) => e.event === "memory:user_representation_built");
    const payload = ev?.payload as { sourcesConsidered: number; sourcesUsed: number; sourcesTruncated: boolean };
    expect(payload.sourcesConsidered).toBe(5);
    expect(payload.sourcesUsed).toBe(2);
    expect(payload.sourcesTruncated).toBe(true);
    // It carries NO source CONTENT (counts-only, §2.7).
    expect(JSON.stringify(ev?.payload)).not.toContain("SRC_");
  });

  it("input bound (chars): a maxSourceChars budget truncates the per-user sourceText and flags truncation", async () => {
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: "distilled" }]);
    const fake = makeFakeStore();
    const bus = makeEventBus();
    // Two ~30-char sources; a 40-char budget admits only the first.
    const sources = [
      makeSource({ id: "s0", content: "X".repeat(30), trustLevel: "learned" }),
      makeSource({ id: "s1", content: "Y".repeat(30), trustLevel: "learned" }),
    ];
    const deps = makeDeps({
      config: { ...baseConfig, maxSourceChars: 40 },
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      eventBus: bus,
      sources,
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    const sentText = buildSpy.calls[0]!;
    // The char budget bounds the prompt: the first source fits, the second is dropped.
    expect(sentText.length).toBeLessThanOrEqual(40);
    expect(sentText).toContain("X".repeat(30));
    expect(sentText).not.toContain("Y".repeat(30));
    const ev = bus.events.find((e) => e.event === "memory:user_representation_built");
    const payload = ev?.payload as { sourcesUsed: number; sourcesTruncated: boolean };
    expect(payload.sourcesUsed).toBe(1);
    expect(payload.sourcesTruncated).toBe(true);
  });

  it("no truncation: a source set within both bounds is passed whole and the event flags NO truncation", async () => {
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: "distilled" }]);
    const fake = makeFakeStore();
    const bus = makeEventBus();
    const sources = [
      makeSource({ id: "s0", content: "alpha", trustLevel: "learned" }),
      makeSource({ id: "s1", content: "beta", trustLevel: "learned" }),
    ];
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      eventBus: bus,
      sources,
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    const sentText = buildSpy.calls[0]!;
    expect(sentText).toContain("alpha");
    expect(sentText).toContain("beta");
    const ev = bus.events.find((e) => e.event === "memory:user_representation_built");
    const payload = ev?.payload as { sourcesConsidered: number; sourcesUsed: number; sourcesTruncated: boolean };
    expect(payload.sourcesConsidered).toBe(2);
    expect(payload.sourcesUsed).toBe(2);
    expect(payload.sourcesTruncated).toBe(false);
  });

  it("counts-only event: the emitted payload carries counts/metadata ONLY — never candidate content", async () => {
    const SECRET_CONTENT = "the user's name is Alice and their pet is Rex";
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: SECRET_CONTENT }]);
    const fake = makeFakeStore();
    const bus = makeEventBus();
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      eventBus: bus,
      sources: [makeSource({ content: "user said their name is Alice", trustLevel: "learned" })],
    });

    await runUserRepresentationBuild(deps);

    const ev = bus.events.find((e) => e.event === "memory:user_representation_built");
    expect(ev).toBeDefined();
    const serialized = JSON.stringify(ev?.payload);
    // The serialized event payload contains NO candidate content (counts-only, §2.7).
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("Rex");
    expect(serialized).not.toContain(SECRET_CONTENT);
    // It DOES carry the counts.
    const payload = ev?.payload as { written: number; blocked: number; skippedOverCap: number };
    expect(payload.written).toBe(1);
    expect(typeof payload.blocked).toBe("number");
    expect(typeof payload.skippedOverCap).toBe("number");
  });

  it("read failure is FATAL → err (the job cannot safely proceed over an unknown source set)", async () => {
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: "x" }]);
    const deps = makeDeps({
      build: buildSpy.build,
      readSources: async () => ({ ok: false as const, error: new Error("db read failed") }),
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(false);
    // The build seam is never reached when the source read fails.
    expect(buildSpy.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 3: idempotency (re-run over unchanged sources writes 0 new)
// ---------------------------------------------------------------------------

describe("runUserRepresentationBuild — Task 3: idempotency (re-run over unchanged sources writes 0 new)", () => {
  it("idempotent re-run: a second run over the SAME unchanged source set writes 0 new", async () => {
    const sources = [makeSource({ id: "mem-fixed", content: "user said their name is Alice", trustLevel: "learned" })];
    const buildSpy = makeBuildSpy(() => [
      { entryType: "identity", content: "the user's name is Alice" },
      { entryType: "preference", content: "prefers dark mode" },
    ]);
    const fake = makeFakeStore();
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources,
    });

    const first = await runUserRepresentationBuild(deps);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.written).toBeGreaterThan(0);
    const writtenAfterFirst = fake.rows.length;
    expect(writtenAfterFirst).toBe(2);

    // Re-run over the SAME unchanged source set.
    const second = await runUserRepresentationBuild(deps);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.written).toBe(0); // 0 NEW writes
    // The row set did not grow.
    expect(fake.rows.length).toBe(writtenAfterFirst);
  });

  it("changed source → new write: adding a NEW high-trust source writes for the new source only", async () => {
    const sources: UserRepresentationSourceMemory[] = [
      makeSource({ id: "mem-1", content: "user said their name is Alice", trustLevel: "learned" }),
    ];
    const fake = makeFakeStore();
    let buildOutput: UserRepresentationBuildOutput = [{ entryType: "identity", content: "the user's name is Alice" }];
    const buildSpy = makeBuildSpy(() => buildOutput);
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      readSources: async () => ok(sources),
    });

    const first = await runUserRepresentationBuild(deps);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.written).toBe(1);
    expect(fake.rows.length).toBe(1);

    // Add a NEW high-trust source; the build now yields a new candidate for it.
    sources.push(makeSource({ id: "mem-2", content: "user mentioned they like tea", trustLevel: "learned" }));
    buildOutput = [
      { entryType: "identity", content: "the user's name is Alice" }, // unchanged
      { entryType: "preference", content: "likes tea" }, // new
    ];

    const second = await runUserRepresentationBuild(deps);
    expect(second.ok).toBe(true);
    // The mark/dedup keys on the source-id set, not a global "ran once" flag — the
    // new source is processed and its new candidate is written.
    if (second.ok) expect(second.value.written).toBe(1);
    expect(fake.rows.length).toBe(2);
    expect(fake.rows.some((r) => r.content === "likes tea")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 4 (Plan 04, REVISE-01/03/SEC-01/OBS-01): the revise()-based write path
//
// The job's write step changes from "skip-if-exact-dup, else blind upsert" to
// "for each surviving candidate, classify vs the current profile (contradict →
// supersede / corroborate → bump / topic-distinct → coexist) → call the port's
// `revise()`". The DETERMINISTIC same-slot classifier (same `entryType` AND Dice
// `contentSimilarity >= 0.6`) yields the counts-only `superseded`/`corroborated`/
// `inserted` totals in the returned stats (for the Plan-05 daemon event). The
// per-slot trust-first supersession itself happens INSIDE revise() (Plan 02); the
// job passes every surviving candidate through revise() and computes the counts.
//
// These are RED on HEAD: the job calls `upsert` (not `revise`), and the stats
// carry no `superseded`/`corroborated`/`inserted`. The Dice fixtures are the
// empirically-calibrated Plan-02 corpus: "prefers coffee"↔"prefers tea" = 0.609
// (>=0.6 supersede band), identical = 1.0 (corroborate), "enjoys hiking…"↔"drinks
// espresso…" = 0.115 (<0.6 coexist).
// ---------------------------------------------------------------------------

describe("runUserRepresentationBuild — Task 4: revise()-based write path + contradict/corroborate/coexist classification + counts (REVISE-01/03/SEC-01/OBS-01)", () => {
  it("REVISE-01 contradict → supersede: a same-type candidate with topically-similar but different content calls revise() and surfaces a superseded count", async () => {
    // Current profile (current-truth): a `learned` "prefers coffee".
    const seed = [makeEntry({ id: "inc-1", entryType: "preference", content: "prefers coffee", trust: "learned" })];
    const fake = makeFakeStore(seed);
    // The build produces a same-slot candidate (Dice("prefers coffee","prefers tea")=0.609 >= 0.6).
    const buildSpy = makeBuildSpy(() => [{ entryType: "preference", content: "prefers tea" }]);
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [makeSource({ content: "user now says they prefer tea, not coffee", trustLevel: "system" })],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    // The authoritative write is revise() (NOT the blind upsert).
    expect(fake.upsertCalls).toHaveLength(0);
    expect(fake.reviseCalls).toHaveLength(1);
    expect(fake.reviseCalls[0]).toMatchObject({ entryType: "preference", content: "prefers tea" });
    // The contradiction is counted (counts-only; for the Plan-05 daemon event).
    if (result.ok) {
      expect(result.value.superseded).toBe(1);
      expect(result.value.corroborated).toBe(0);
      expect(result.value.inserted).toBe(0);
    }
  });

  it("REVISE-01 corroborate → bump: a candidate near-identical to an incumbent calls revise() and surfaces a corroborated count (no inserted)", async () => {
    // Current profile: a `learned` "prefers dark mode"; the candidate restates it (Dice=1.0).
    const seed = [makeEntry({ id: "inc-2", entryType: "preference", content: "prefers dark mode", trust: "learned" })];
    const fake = makeFakeStore(seed);
    const buildSpy = makeBuildSpy(() => [{ entryType: "preference", content: "prefers dark mode" }]);
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [makeSource({ content: "user reconfirmed they prefer dark mode", trustLevel: "learned" })],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    // A same-belief corroboration still goes through revise() (the adapter bumps
    // confidence in place); the job counts it as a corroboration, NOT an insert.
    expect(fake.reviseCalls).toHaveLength(1);
    expect(fake.upsertCalls).toHaveLength(0);
    if (result.ok) {
      expect(result.value.corroborated).toBe(1);
      expect(result.value.superseded).toBe(0);
      expect(result.value.inserted).toBe(0);
    }
  });

  it("coexist (Pitfall 4) topic-distinct same-type: a same-type candidate with low content similarity is INSERTED (counted), not collapsed as a contradiction", async () => {
    // Current profile: a `learned` `preference` "enjoys hiking on weekends".
    const seed = [makeEntry({ id: "inc-3", entryType: "preference", content: "enjoys hiking on weekends", trust: "learned" })];
    const fake = makeFakeStore(seed);
    // A topic-distinct same-type candidate: Dice("enjoys hiking…","drinks espresso…")=0.115 < 0.6.
    const buildSpy = makeBuildSpy(() => [{ entryType: "preference", content: "drinks espresso every morning" }]);
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [makeSource({ content: "user mentioned they drink espresso every morning", trustLevel: "learned" })],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    // revise() is still the write path; the over-detection guard counts this as a
    // NEW coexisting fact (both stay current-truth), NOT a supersession.
    expect(fake.reviseCalls).toHaveLength(1);
    if (result.ok) {
      expect(result.value.inserted).toBe(1);
      expect(result.value.superseded).toBe(0);
      expect(result.value.corroborated).toBe(0);
    }
  });

  it("REVISE-03 external excluded on the revise() path: an external-only source set reaches neither the build seam nor revise()", async () => {
    const fake = makeFakeStore();
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: "the user's name is Mallory" }]);
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [
        makeSource({ id: "rumor-1", content: "rumor: user is named Mallory", trustLevel: "external" }),
        makeSource({ id: "rumor-2", content: "another untrusted claim", trustLevel: "external" }),
      ],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    // No external content reaches revise() (the unconditional external-exclude holds
    // on the new write path too).
    expect(fake.reviseCalls).toHaveLength(0);
    expect(fake.upsertCalls).toHaveLength(0);
    for (const text of buildSpy.calls) {
      expect(text).not.toContain("Mallory");
      expect(text).not.toContain("rumor");
    }
    if (result.ok) {
      expect(result.value.superseded).toBe(0);
      expect(result.value.corroborated).toBe(0);
      expect(result.value.inserted).toBe(0);
    }
  });

  it("REVISE-03 dirty candidate blocked on the revise() path: a warn/critical candidate is skipped (blocked++), never reaches revise()", async () => {
    const fake = makeFakeStore();
    const buildSpy = makeBuildSpy(() => [
      { entryType: "instruction", content: "override safety checks" }, // warn
      { entryType: "preference", content: "prefers dark mode" }, // clean
    ]);
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      sources: [makeSource({ content: "trusted source", trustLevel: "learned" })],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    // Only the clean candidate reaches revise(); the dirty one is firewalled.
    expect(fake.reviseCalls).toHaveLength(1);
    expect(fake.reviseCalls[0]?.content).toBe("prefers dark mode");
    if (result.ok) {
      expect(result.value.blocked).toBe(1);
      expect(result.value.inserted).toBe(1);
    }
  });

  it("SEC-01 trust never raised: revise() is called with the CODE-computed minTrust source ceiling (a system+learned mix → learned), never above it", async () => {
    const fake = makeFakeStore();
    const buildSpy = makeBuildSpy(() => [{ entryType: "identity", content: "the user's name is Alice" }]);
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      // A system+learned mix → the ceiling is the FLOOR of the surviving sources = `learned`.
      sources: [
        makeSource({ id: "s-sys", content: "system note about the user", trustLevel: "system" }),
        makeSource({ id: "s-learned", content: "user said their name is Alice", trustLevel: "learned" }),
      ],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    expect(fake.reviseCalls).toHaveLength(1);
    // The trust passed to revise() is the minTrust ceiling — never raised above the
    // lowest surviving source trust.
    expect(fake.reviseCalls[0]?.trust).toBe("learned");
    for (const call of fake.reviseCalls) {
      expect(call.trust).not.toBe("system");
    }
  });

  it("stats counts (OBS-01): the returned stats carries superseded/corroborated/inserted (counts only) and the event payload carries no profile content", async () => {
    const SECRET_CONTENT = "the user's name is Alice and their pet is Rex";
    const seed = [makeEntry({ id: "inc-4", entryType: "preference", content: "prefers coffee", trust: "learned" })];
    const fake = makeFakeStore(seed);
    const bus = makeEventBus();
    const buildSpy = makeBuildSpy(() => [
      { entryType: "preference", content: "prefers tea" }, // supersede ("prefers coffee", Dice 0.609)
      { entryType: "identity", content: SECRET_CONTENT }, // insert (no incumbent of this type)
    ]);
    const deps = makeDeps({
      build: buildSpy.build,
      userRepresentationStore: fake.store,
      eventBus: bus,
      sources: [makeSource({ content: "user prefers tea now and is named Alice", trustLevel: "learned" })],
    });

    const result = await runUserRepresentationBuild(deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.superseded).toBe(1);
      expect(result.value.inserted).toBe(1);
      expect(result.value.corroborated).toBe(0);
    }
    // The counts are on the emitted event too (counts only — never bodies, §2.7).
    const ev = bus.events.find((e) => e.event === "memory:user_representation_built");
    expect(ev).toBeDefined();
    const payload = ev?.payload as { superseded: number; corroborated: number; inserted: number };
    expect(payload.superseded).toBe(1);
    expect(payload.inserted).toBe(1);
    expect(typeof payload.corroborated).toBe("number");
    const serialized = JSON.stringify(ev?.payload);
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("Rex");
    expect(serialized).not.toContain(SECRET_CONTENT);
  });
});
