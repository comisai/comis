// SPDX-License-Identifier: Apache-2.0
//
// Orchestration suite for the per-user representation offline builder (Phase 107 —
// USER-02). Two units under test:
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
// Anti-poisoning headline (USER-02): an `external`/low-trust source candidate is
// SKIPPED (filtered out BEFORE the build), NEVER downgraded-and-stored — the
// 107-02 DB CHECK forbids `external`, so an external source RED-proves 0 profile
// rows. A `warn`/`critical` validateMemoryWrite verdict is likewise SKIPPED
// (blocked++), not downgraded (Pitfall 2 — the high-trust floor has no landing for
// a non-clean entry).
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
 * NOT grow the row set — mirroring the 107-02 adapter's upsert-replace contract.
 * `upsertCalls` records every entry the job tried to write (the bound/skip proofs).
 */
function makeFakeStore(): {
  store: UserRepresentationStore;
  rows: UserRepresentationEntry[];
  upsertCalls: UserRepresentationInput[];
} {
  const rows: UserRepresentationEntry[] = [];
  const upsertCalls: UserRepresentationInput[] = [];
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
  };
  return { store, rows, upsertCalls };
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
