// SPDX-License-Identifier: Apache-2.0
//
// Orchestration suite for runMemoryConsolidation.
//
// The LLM is MOCKED (Pitfall 5) for determinism — completeSimple returns canned
// merge JSON. A STUB consolidationStore captures applyConsolidation plans and
// serves configurable candidates/observations. A fixed injected clock proves
// clock injection (never Date.now) and makes durations deterministic.
//
// The headline assertions are the SECURITY ones:
//   - RED 2: the observation's trust is min(sources) computed in CODE — a
//     [learned, external] cluster mints "external", NEVER "system"/"learned".
//   - RED 3: external clusters are excluded by default (consolidateExternal:false).
//   - RED 4: one LLM call PER homogeneous sub-cluster (never one over a mixed set).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "@comis/shared";
import type {
  MemoryConsolidationConfig,
  MemoryEntry,
  TrustLevel,
  ConsolidationCandidate,
  ConsolidationPlan,
  ConsolidationFoldPlan,
  MemoryConsolidationStore,
} from "@comis/core";

// Mock pi-ai — canned merge JSON, configured per-test via mockResolvedValueOnce.
vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

import { runMemoryConsolidation, type MemoryConsolidationDeps } from "./memory-consolidation-job.js";
import { completeSimple, getModel } from "@earendil-works/pi-ai";

const NOW = 1_700_000_000_000;

/** Wrap canned merge text in the pi-ai completeSimple response envelope. */
function llmText(text: string) {
  return { content: [{ type: "text", text }] };
}

/** Configure the mocked LLM to return the same merge JSON for every call. */
function mockMerge(content: string, confidence = 0.9): void {
  (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
    llmText(JSON.stringify({ content, confidence })),
  );
}

let uuidCounter = 0;
function nextId(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? nextId(),
    tenantId: "default",
    agentId: "test-agent",
    userId: "system",
    content: overrides.content ?? "a fact",
    trustLevel: overrides.trustLevel ?? "learned",
    source: { who: "system", channel: "test" },
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? NOW,
    ...overrides,
  };
}

function makeCand(overrides: Partial<MemoryEntry> = {}, embedding?: number[]): ConsolidationCandidate {
  return { entry: makeEntry(overrides), ...(embedding ? { embedding } : {}) };
}

function makeConfig(overrides: Partial<MemoryConsolidationConfig> = {}): MemoryConsolidationConfig {
  return {
    enabled: true,
    schedule: "30 3 * * *",
    similarityThreshold: 0.82,
    dedupThreshold: 0.9,
    maxCandidatesPerRun: 200,
    maxClusterSize: 12,
    maxClustersPerRun: 25,
    maxConsolidationTokens: 1024,
    consolidateExternal: false,
    autoTags: [],
    // GENERAL-01/02 default-OFF — byte-identical consolidation unless a test opts in.
    generalize: { enabled: false, minDistinctContexts: 3 },
    ...overrides,
  };
}

interface StubStore extends MemoryConsolidationStore {
  applied: ConsolidationPlan[];
  /** Captures every fold-vs-create FOLD decision (the plan the job hands the port). */
  foldCalls: ConsolidationFoldPlan[];
}

/**
 * A stub store capturing applyConsolidation plans (the CREATE path) AND
 * foldIntoExisting plans (the FOLD path), serving fixed candidates/observations.
 * The `observations` array doubles as both the dedup pre-check snapshot
 * (`listObservations`) and the fold-target pool.
 */
function makeStore(
  candidates: ConsolidationCandidate[],
  observations: MemoryEntry[] = [],
): StubStore {
  const applied: ConsolidationPlan[] = [];
  const foldCalls: ConsolidationFoldPlan[] = [];
  const byId = new Map(observations.map((o) => [o.id, o]));
  return {
    applied,
    foldCalls,
    listConsolidationCandidates: vi.fn().mockResolvedValue(ok(candidates)),
    listObservations: vi.fn().mockResolvedValue(ok(observations)),
    applyConsolidation: vi.fn(async (plan: ConsolidationPlan) => {
      applied.push(plan);
      return ok(plan.observation);
    }),
    foldIntoExisting: vi.fn(async (plan: ConsolidationFoldPlan) => {
      foldCalls.push(plan);
      // Return the GROWN observation (the adapter's contract): the target with a
      // UNIONed source set + the refreshed trust/confidence/occurredAt/content.
      const target = byId.get(plan.targetObservationId);
      const unioned = [...new Set([...(target?.sourceIds ?? []), ...plan.newSourceIds])];
      const grown: MemoryEntry = {
        ...(target ?? makeEntry({ id: plan.targetObservationId })),
        trustLevel: plan.trustLevel,
        confidence: plan.confidence,
        occurredAt: plan.occurredAt,
        sourceIds: unioned,
        proofCount: unioned.length,
        ...(plan.content !== undefined ? { content: plan.content } : {}),
      };
      return ok(grown);
    }),
  };
}

function makeDeps(
  store: StubStore,
  configOverrides: Partial<MemoryConsolidationConfig> = {},
): MemoryConsolidationDeps {
  return {
    agentId: "test-agent",
    tenantId: "default",
    config: makeConfig(configOverrides),
    consolidationStore: store,
    eventBus: { emit: vi.fn() },
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "test-key",
    clock: { now: () => NOW, nowDate: () => new Date(NOW) },
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

beforeEach(() => {
  uuidCounter = 0;
  vi.clearAllMocks();
  (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock-model" });
});

describe("runMemoryConsolidation — trust ceiling end-to-end (the escalation guard)", () => {
  it("mints an external observation for a homogeneous external cluster (ceiling = min(sources) = external)", async () => {
    mockMerge("merged");
    // Two near-parallel embeddings so they cluster; both external + same tags →
    // ONE homogeneous sub-cluster. minTrust([external,external]) = "external".
    const store = makeStore([
      makeCand({ trustLevel: "external", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "external", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    const result = await runMemoryConsolidation(makeDeps(store, { consolidateExternal: true }));
    expect(result.ok).toBe(true);
    expect(store.applied).toHaveLength(1);
    expect(store.applied[0].observation.trustLevel).toBe("external");
  });

  it("mints a learned observation for a [learned, learned] cluster", async () => {
    mockMerge("merged");
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    const result = await runMemoryConsolidation(makeDeps(store));
    expect(result.ok).toBe(true);
    expect(store.applied).toHaveLength(1);
    expect(store.applied[0].observation.trustLevel).toBe("learned");
  });

  it("NEVER merges mixed-trust sources together — a [system, learned] cluster is split into two singletons and neither is consolidated (no escalation path)", async () => {
    // This is the strongest escalation guard: a low-trust + high-trust pair can
    // never even REACH a merge call. groupByTrustAndTagScope splits the cosine
    // cluster into (system)×1 and (learned)×1; both are singletons → dropped.
    // There is no observation that could outrank its lower-trust member because
    // the two are never combined.
    mockMerge("merged");
    const store = makeStore([
      makeCand({ trustLevel: "system", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    const result = await runMemoryConsolidation(makeDeps(store));
    expect(result.ok).toBe(true);
    expect(store.applied).toHaveLength(0);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("the LLM is never allowed to set trust — a smuggled trustLevel is ignored, code wins", async () => {
    // LLM tries to escalate to "system"; the parser strips it and minTrust("learned") wins.
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(
      llmText(JSON.stringify({ content: "merged", confidence: 0.9, trustLevel: "system" })),
    );
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    await runMemoryConsolidation(makeDeps(store));
    expect(store.applied[0].observation.trustLevel).toBe("learned");
  });
});

describe("runMemoryConsolidation — external excluded by default", () => {
  it("skips an all-external cluster when consolidateExternal is false (no observation, no LLM call)", async () => {
    mockMerge("merged");
    const store = makeStore([
      makeCand({ trustLevel: "external", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "external", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    const result = await runMemoryConsolidation(makeDeps(store, { consolidateExternal: false }));
    expect(result.ok).toBe(true);
    expect(store.applied).toHaveLength(0);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("processes an external cluster when consolidateExternal is true", async () => {
    mockMerge("merged");
    const store = makeStore([
      makeCand({ trustLevel: "external", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "external", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    await runMemoryConsolidation(makeDeps(store, { consolidateExternal: true }));
    expect(store.applied).toHaveLength(1);
    expect(store.applied[0].observation.trustLevel).toBe("external");
  });
});

describe("runMemoryConsolidation — no trust/tag mix per LLM call", () => {
  it("invokes the LLM ONCE per homogeneous sub-cluster, never once over a mixed set", async () => {
    mockMerge("merged");
    // One cosine-tight cluster mixing two trust levels → two homogeneous sub-clusters.
    const store = makeStore([
      makeCand({ trustLevel: "system", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "system", tags: ["t"] }, [0.9999, 0.0001, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.9998, 0.0002, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.9997, 0.0003, 0]),
    ]);
    await runMemoryConsolidation(makeDeps(store, { similarityThreshold: 0.9 }));
    // Two sub-clusters (system×2, learned×2) → two LLM calls, two observations.
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(store.applied).toHaveLength(2);
    const trusts = store.applied.map((p) => p.observation.trustLevel).sort();
    expect(trusts).toEqual<TrustLevel[]>(["learned", "system"]);
  });
});

describe("runMemoryConsolidation — deterministic dedup pre-check", () => {
  it("does not create a second observation when an equivalent one already exists; dedupHits increments", async () => {
    mockMerge("merged");
    const s1 = nextId();
    const s2 = nextId();
    // An existing observation whose source-id set equals the cluster's.
    const existing = makeEntry({
      content: "already merged",
      proofCount: 2,
      sourceIds: [s1, s2],
      trustLevel: "learned",
    });
    const store = makeStore(
      [
        makeCand({ id: s1, trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
        makeCand({ id: s2, trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
      ],
      [existing],
    );
    const deps = makeDeps(store);
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);
    // No new observation created (dedup hit → skip).
    expect(store.applied).toHaveLength(0);
    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>;
    const payload = emit.mock.calls.find((c) => c[0] === "memory:consolidated")?.[1] as {
      dedupHits: number;
      observationsCreated: number;
    };
    expect(payload.dedupHits).toBe(1);
    expect(payload.observationsCreated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The fold-vs-create decision (the secondary content-dedup seam,
// converted from a SKIP into a FOLD).
//
// When a merged cluster's content matches a SAME-TRUST PRIOR-RUN observation
// (>= dedupThreshold) AND the cluster carries source ids NOT already in that
// observation, the job FOLDs the truly-new sources into it (growing proof)
// instead of creating a second observation — via consolidationStore
// .foldIntoExisting (the port TYPE). Otherwise it falls through to
// the UNCHANGED create path.
//
// Headline guards:
//   - FOLD ON CONTENT MATCH: same-trust + content-similar + NEW sources → one
//     fold with the right plan (target id, truly-new sources, min ceiling,
//     confidence 1, refreshed occurredAt); no create; observationsCreated flat;
//     foldsApplied increments.
//   - IDEMPOTENCY PRE-FILTER: a content match whose sourceIds already cover the
//     cluster → trulyNew empty → SKIP (dedupHit), no fold.
//   - CROSS-TRUST → NO FOLD: a content match against a DIFFERENT-trust obs is
//     filtered out → no fold, falls through to CREATE (scope separation).
//   - TRUST-CEILING-DOWN: the fold plan's trustLevel is minTrustLevel(obs,
//     cluster) (never above the more-trusted input).
//   - EVENT: memory:consolidated carries foldsApplied (counts-only).
// ---------------------------------------------------------------------------
describe("runMemoryConsolidation — fold-vs-create decision", () => {
  /** Read the memory:consolidated payload off the eventBus spy. */
  function consolidatedPayload(deps: MemoryConsolidationDeps): {
    observationsCreated: number;
    dedupHits: number;
    foldsApplied: number;
  } {
    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>;
    return emit.mock.calls.find((c) => c[0] === "memory:consolidated")?.[1] as {
      observationsCreated: number;
      dedupHits: number;
      foldsApplied: number;
    };
  }

  it("FOLDS a same-trust content match into the existing observation (truly-new sources, min ceiling, confidence 1, refreshed occurredAt) — no create", async () => {
    // The merged content equals the prior observation's content → similarity 1.
    mockMerge("alice prefers tea");
    // Prior-run observation: same trust, content match, sourceIds {old1} — the
    // cluster's {new1,new2} are NOT a subset, so the PRIMARY source-id key does
    // NOT match (no skip) and the content match routes to a FOLD.
    const old1 = nextId();
    const obs = makeEntry({
      content: "alice prefers tea",
      trustLevel: "learned",
      proofCount: 1,
      sourceIds: [old1],
      occurredAt: 1000,
    });
    const new1 = nextId();
    const new2 = nextId();
    const store = makeStore(
      [
        makeCand({ id: new1, trustLevel: "learned", tags: ["t"], occurredAt: 5000 }, [1, 0, 0]),
        makeCand({ id: new2, trustLevel: "learned", tags: ["t"], occurredAt: 8000 }, [0.999, 0.001, 0]),
      ],
      [obs],
    );
    const deps = makeDeps(store);
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);

    // Exactly one fold, no create.
    expect(store.foldCalls).toHaveLength(1);
    expect(store.applied).toHaveLength(0);

    const fold = store.foldCalls[0];
    expect(fold.targetObservationId).toBe(obs.id);
    // Only the truly-new ids (old1 already in the target → excluded).
    expect([...fold.newSourceIds].sort()).toEqual([new1, new2].sort());
    expect(fold.newSourceIds).not.toContain(old1);
    // Same-trust fold → ceiling is a no-op (learned).
    expect(fold.trustLevel).toBe("learned");
    // Deterministic refresh.
    expect(fold.confidence).toBe(1);
    // occurredAt refreshed to max(existing 1000, max(newSources 5000,8000)) = 8000.
    expect(fold.occurredAt).toBe(8000);
    expect(fold.tenantId).toBe("default");
    expect(fold.now).toBe(NOW);

    const payload = consolidatedPayload(deps);
    expect(payload.foldsApplied).toBe(1);
    expect(payload.observationsCreated).toBe(0);
  });

  it("IDEMPOTENCY PRE-FILTER: a content match whose sourceIds already cover the cluster → no fold (dedup skip)", async () => {
    mockMerge("alice prefers tea");
    const a = nextId();
    const b = nextId();
    // The observation already carries BOTH cluster ids (a superset). The cluster
    // {a,b} differs from the obs source set {a,b,extra} so the PRIMARY key does
    // not match (routes to the secondary content match), but trulyNew is empty.
    const extra = nextId();
    const obs = makeEntry({
      content: "alice prefers tea",
      trustLevel: "learned",
      proofCount: 3,
      sourceIds: [a, b, extra],
    });
    const store = makeStore(
      [
        makeCand({ id: a, trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
        makeCand({ id: b, trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
      ],
      [obs],
    );
    const deps = makeDeps(store);
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);
    // Nothing new to fold → skip, no fold call, no create.
    expect(store.foldCalls).toHaveLength(0);
    expect(store.applied).toHaveLength(0);
    const payload = consolidatedPayload(deps);
    expect(payload.dedupHits).toBe(1);
    expect(payload.foldsApplied).toBe(0);
    expect(payload.observationsCreated).toBe(0);
  });

  it("CROSS-TRUST → NO FOLD: a content match against a DIFFERENT-trust observation is filtered out → CREATE fires (scope separation, anti-laundering)", async () => {
    mockMerge("alice prefers tea");
    // The prior observation is SYSTEM-trust; the cluster is LEARNED-trust with
    // identical content. The same-trust filter rejects it as a fold target → the
    // learned cluster CREATEs a separate observation (never folds into system).
    const old1 = nextId();
    const obs = makeEntry({
      content: "alice prefers tea",
      trustLevel: "system",
      proofCount: 1,
      sourceIds: [old1],
    });
    const store = makeStore(
      [
        makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
        makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
      ],
      [obs],
    );
    const deps = makeDeps(store);
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);
    // No fold across trust; a NEW learned observation is created instead.
    expect(store.foldCalls).toHaveLength(0);
    expect(store.applied).toHaveLength(1);
    expect(store.applied[0].observation.trustLevel).toBe("learned");
    const payload = consolidatedPayload(deps);
    expect(payload.foldsApplied).toBe(0);
    expect(payload.observationsCreated).toBe(1);
  });

  it("TRUST-CEILING-DOWN (defense-in-depth): the fold plan's trustLevel never exceeds the more-trusted input", async () => {
    // Same-trust fold (the only fold path) — assert the plan trust equals the
    // shared trust and is never raised. (Cross-trust never reaches a fold, proven
    // above; this guards the ceiling computation on the path that DOES fold.)
    mockMerge("bob lives in berlin");
    const old1 = nextId();
    const obs = makeEntry({
      content: "bob lives in berlin",
      trustLevel: "learned",
      proofCount: 1,
      sourceIds: [old1],
    });
    const store = makeStore(
      [
        makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
        makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
      ],
      [obs],
    );
    const deps = makeDeps(store);
    await runMemoryConsolidation(deps);
    expect(store.foldCalls).toHaveLength(1);
    const rank: Record<TrustLevel, number> = { system: 0, learned: 1, external: 2 };
    // The plan trust is never MORE trusted (lower rank) than the obs trust.
    expect(rank[store.foldCalls[0].trustLevel]).toBeGreaterThanOrEqual(rank[obs.trustLevel]);
    expect(store.foldCalls[0].trustLevel).toBe("learned");
  });

  it("CREATE STILL FIRES: a cluster with NO matching prior observation runs the unchanged create path", async () => {
    mockMerge("a totally novel fact");
    // A prior observation with UNRELATED content → no content match → create.
    const obs = makeEntry({
      content: "something entirely unrelated about quarks",
      trustLevel: "learned",
      proofCount: 1,
      sourceIds: [nextId()],
    });
    const store = makeStore(
      [
        makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
        makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
      ],
      [obs],
    );
    const deps = makeDeps(store);
    await runMemoryConsolidation(deps);
    expect(store.foldCalls).toHaveLength(0);
    expect(store.applied).toHaveLength(1);
    const payload = consolidatedPayload(deps);
    expect(payload.observationsCreated).toBe(1);
    expect(payload.foldsApplied).toBe(0);
  });

  it("a failed/rejected fold is non-fatal: the run returns ok, foldsApplied does not increment, and a WARN fires", async () => {
    mockMerge("alice prefers tea");
    const obs = makeEntry({
      content: "alice prefers tea",
      trustLevel: "learned",
      proofCount: 1,
      sourceIds: [nextId()],
    });
    const store = makeStore(
      [
        makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
        makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
      ],
      [obs],
    );
    // The port rejects the fold (inner Result.err) — non-fatal.
    (store.foldIntoExisting as ReturnType<typeof vi.fn>).mockResolvedValue(
      err(new Error("fold target vanished")),
    );
    const deps = makeDeps(store);
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);
    expect(store.applied).toHaveLength(0);
    expect(deps.logger.warn).toHaveBeenCalled();
    expect(consolidatedPayload(deps).foldsApplied).toBe(0);
  });

  it("emits foldsApplied:0 on the empty-candidates early return (additive counts-only field)", async () => {
    const store = makeStore([]);
    const deps = makeDeps(store);
    await runMemoryConsolidation(deps);
    expect(consolidatedPayload(deps).foldsApplied).toBe(0);
  });
});

describe("runMemoryConsolidation — bounded run + minimal event", () => {
  it("processes at most maxClustersPerRun clusters and emits one minimal memory:consolidated event", async () => {
    mockMerge("merged");
    // Three independent (orthogonal) clusters of two each.
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["a"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["a"] }, [0.999, 0.001, 0]),
      makeCand({ trustLevel: "learned", tags: ["b"] }, [0, 1, 0]),
      makeCand({ trustLevel: "learned", tags: ["b"] }, [0.001, 0.999, 0]),
      makeCand({ trustLevel: "learned", tags: ["c"] }, [0, 0, 1]),
      makeCand({ trustLevel: "learned", tags: ["c"] }, [0.001, 0, 0.999]),
    ]);
    const deps = makeDeps(store, { maxClustersPerRun: 1, similarityThreshold: 0.9 });
    await runMemoryConsolidation(deps);
    expect(store.applied).toHaveLength(1);
    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>;
    const consolidatedCalls = emit.mock.calls.filter((c) => c[0] === "memory:consolidated");
    expect(consolidatedCalls).toHaveLength(1);
    const payload = consolidatedCalls[0][1] as {
      agentId: string;
      clustersProcessed: number;
      observationsCreated: number;
      dedupHits: number;
      durationMs: number;
    };
    expect(payload).toMatchObject({
      agentId: "test-agent",
      clustersProcessed: 1,
      observationsCreated: 1,
      dedupHits: 0,
    });
    expect(typeof payload.durationMs).toBe("number");
  });

  it("carries proofCount and sourceIds on the created observation", async () => {
    mockMerge("merged");
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    await runMemoryConsolidation(makeDeps(store));
    const obs = store.applied[0].observation;
    expect(obs.proofCount).toBe(2);
    expect(obs.sourceIds).toHaveLength(2);
    expect(store.applied[0].markConsolidated).toHaveLength(2);
  });
});

describe("runMemoryConsolidation — a dedup-hit cluster must NOT consume the maxClustersPerRun budget", () => {
  it("with maxClustersPerRun=1 and a dedup-hit cluster ordered before a real-merge cluster, the real merge still happens (budget not wasted on the dedup skip)", async () => {
    // The starvation bug: `clustersProcessed++` runs BEFORE the dedup check, and
    // the loop guard is `clustersProcessed >= maxClustersPerRun`. So a leading
    // dedup-hit cluster burns the entire budget and the loop BREAKs before the
    // mergeable cluster — genuinely-new observations are starved under churn.
    mockMerge("merged");

    // dedupS1/dedupS2 are the source ids of the FIRST (tag "a") cluster. We seed
    // an EXISTING observation whose source-id set equals {dedupS1, dedupS2}, so
    // the primary deterministic dedup key matches → cluster 1 is a dedup hit.
    const dedupS1 = nextId();
    const dedupS2 = nextId();
    const existing = makeEntry({
      content: "already merged fact A",
      proofCount: 2,
      sourceIds: [dedupS1, dedupS2],
      trustLevel: "learned",
    });

    // Two ORTHOGONAL clusters (no cosine neighbour between them → two separate
    // clusters; input order is preserved as cluster order). Cluster 1 (tag "a")
    // is the dedup hit; cluster 2 (tag "b") is a NOVEL source set that must merge.
    const store = makeStore(
      [
        // Cluster 1 — dedup hit (its source set already has an observation).
        makeCand({ id: dedupS1, trustLevel: "learned", tags: ["a"] }, [1, 0, 0]),
        makeCand({ id: dedupS2, trustLevel: "learned", tags: ["a"] }, [0.999, 0.001, 0]),
        // Cluster 2 — novel, mergeable; orthogonal embedding so it is a distinct cluster.
        makeCand({ trustLevel: "learned", tags: ["b"] }, [0, 1, 0]),
        makeCand({ trustLevel: "learned", tags: ["b"] }, [0.001, 0.999, 0]),
      ],
      [existing],
    );

    const deps = makeDeps(store, { maxClustersPerRun: 1, similarityThreshold: 0.9 });
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);

    // The dedup hit must NOT have consumed the budget: the real merge (cluster 2)
    // STILL produces exactly one observation. Pre-fix, store.applied is empty
    // (the budget was burned by the dedup skip and the loop broke).
    expect(store.applied).toHaveLength(1);
    // The created observation is the NOVEL cluster (tag "b"), not the dedup'd set.
    expect(store.applied[0].observation.sourceIds).not.toContain(dedupS1);
    expect(store.applied[0].observation.sourceIds).not.toContain(dedupS2);

    // dedupHits still counts the skipped cluster; observationsCreated reflects the
    // one real merge that the budget correctly funded.
    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>;
    const payload = emit.mock.calls.find((c) => c[0] === "memory:consolidated")?.[1] as {
      dedupHits: number;
      observationsCreated: number;
      clustersProcessed: number;
    };
    expect(payload.dedupHits).toBe(1);
    expect(payload.observationsCreated).toBe(1);
  });

  it("a dedup-hit followed by a real merge under maxClustersPerRun=1 invokes the LLM once (only for the cluster that actually merges)", async () => {
    // Corollary cost-bound assertion: the dedup-hit cluster must not even reach an
    // LLM call, and — crucially — must not block the budget the mergeable cluster
    // needs. Exactly ONE completeSimple call (the tag-"b" merge).
    mockMerge("merged");
    const dedupS1 = nextId();
    const dedupS2 = nextId();
    const existing = makeEntry({
      content: "already merged fact A",
      proofCount: 2,
      sourceIds: [dedupS1, dedupS2],
      trustLevel: "learned",
    });
    const store = makeStore(
      [
        makeCand({ id: dedupS1, trustLevel: "learned", tags: ["a"] }, [1, 0, 0]),
        makeCand({ id: dedupS2, trustLevel: "learned", tags: ["a"] }, [0.999, 0.001, 0]),
        makeCand({ trustLevel: "learned", tags: ["b"] }, [0, 1, 0]),
        makeCand({ trustLevel: "learned", tags: ["b"] }, [0.001, 0.999, 0]),
      ],
      [existing],
    );
    const deps = makeDeps(store, { maxClustersPerRun: 1, similarityThreshold: 0.9 });
    await runMemoryConsolidation(deps);
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });
});

describe("runMemoryConsolidation — the consolidation LLM INPUT prompt is bounded, not just the output", () => {
  /** The per-member content cap the merge prompt must enforce (mirror of the production constant). */
  const MAX_MEMORY_CHARS = 2_000;

  /** Pull the user-message content string that the (mocked) LLM call received. */
  function userPromptOf(callIndex = 0): string {
    const call = (completeSimple as ReturnType<typeof vi.fn>).mock.calls[callIndex];
    // completeSimple(model, { systemPrompt, messages }, opts) — read messages[0].content.
    const req = call[1] as { messages: { role: string; content: string }[] };
    return req.messages[0].content;
  }

  it("truncates each oversized member's content to the per-member cap before building the merge prompt", async () => {
    mockMerge("merged");
    // Two members, each WAY over the cap (10k chars). Pre-fix the prompt embeds
    // both in full (~20k+); post-fix each is sliced to MAX_MEMORY_CHARS.
    const huge = "x".repeat(10_000);
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"], content: huge }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"], content: huge }, [0.999, 0.001, 0]),
    ]);
    await runMemoryConsolidation(makeDeps(store));
    expect(completeSimple).toHaveBeenCalledTimes(1);

    const prompt = userPromptOf();
    // The full 10k-char content must NOT appear verbatim (it was sliced).
    expect(prompt).not.toContain(huge);
    // No run of the filler char may exceed the per-member cap (the only place a
    // long run can come from is an un-truncated member content).
    const longestRun = prompt.match(/x+/g)?.reduce((m, s) => Math.max(m, s.length), 0) ?? 0;
    expect(longestRun).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
    // And the assembled prompt stays far below the unbounded 2×10k it would be.
    expect(prompt.length).toBeLessThan(2 * MAX_MEMORY_CHARS + 500); // 2 members × cap + small framing
  });

  it("leaves a small (sub-cap) member content intact — the bound only clips oversized content", async () => {
    mockMerge("merged");
    const small = "the sky is blue";
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"], content: small }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"], content: small }, [0.999, 0.001, 0]),
    ]);
    await runMemoryConsolidation(makeDeps(store));
    const prompt = userPromptOf();
    // A short fact is preserved verbatim — no over-aggressive truncation.
    expect(prompt).toContain(small);
  });
});

describe("runMemoryConsolidation — non-fatal LLM failure (mirrors review-job posture)", () => {
  it("returns ok and creates nothing when the LLM throws", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    const deps = makeDeps(store);
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);
    expect(store.applied).toHaveLength(0);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("returns ok and skips a cluster whose merge JSON fails to parse", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(llmText("not json {{{"));
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    const result = await runMemoryConsolidation(makeDeps(store));
    expect(result.ok).toBe(true);
    expect(store.applied).toHaveLength(0);
  });

  it("returns err when the store cannot list candidates (fatal — cannot read)", async () => {
    const store = makeStore([]);
    (store.listConsolidationCandidates as ReturnType<typeof vi.fn>).mockResolvedValue(
      err(new Error("db locked")),
    );
    const result = await runMemoryConsolidation(makeDeps(store));
    expect(result.ok).toBe(false);
  });
});

describe("runMemoryConsolidation — singletons left for a future run", () => {
  it("does not consolidate a lone candidate with no neighbour (no observation)", async () => {
    mockMerge("merged");
    const store = makeStore([makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0])]);
    const result = await runMemoryConsolidation(makeDeps(store));
    expect(result.ok).toBe(true);
    expect(store.applied).toHaveLength(0);
    expect(completeSimple).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Candidate-missing-embedding degradation signal (the last gap).
//
// A ConsolidationCandidate arrives with `embedding === undefined` when
// sqlite-vec is unavailable (the adapter's LEFT JOIN finds no vec row). The
// agent-side clusterer then silently degrades that candidate to entity/FTS
// overlap. RESEARCH's Degradation Signal Audit flags this as the ONE remaining
// unsignalled degradation: ADD a WARN with errorKind:"precondition" + hint + a
// COUNT so the operator can see "N candidates clustered without an embedding".
// errorKind is the closed 10-member union; "precondition" = an unmet
// precondition for vector clustering. Counts only — never memory content.
// ---------------------------------------------------------------------------
describe("runMemoryConsolidation — candidate-missing-embedding signal", () => {
  /** Find the WARN (obj,msg) pair carrying errorKind:"precondition". */
  function preconditionWarn(deps: MemoryConsolidationDeps): Record<string, unknown> | undefined {
    return ((deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>, string]>)
      .find(([obj]) => obj.errorKind === "precondition")?.[0];
  }

  it("logs ONE precondition WARN with the missing count when ≥1 candidate has no embedding", async () => {
    mockMerge("merged");
    // Two candidates WITH embeddings (so a merge still runs) + two WITHOUT.
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }), // no embedding
      makeCand({ trustLevel: "learned", tags: ["t"] }), // no embedding
    ]);
    const deps = makeDeps(store);
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);

    const warn = preconditionWarn(deps);
    expect(warn).toBeDefined();
    // The COUNT is a structured field (queryable), not just buried in the message.
    expect(warn?.missingEmbedding).toBe(2);
    expect(warn?.agentId).toBe("test-agent");
    expect(typeof warn?.hint).toBe("string");
    // Degradation is queryable — the hint names the fallback path.
    expect(String(warn?.hint)).toMatch(/embedding/i);
  });

  it("does NOT log a precondition WARN when ALL candidates have embeddings", async () => {
    mockMerge("merged");
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    const deps = makeDeps(store);
    await runMemoryConsolidation(deps);
    expect(preconditionWarn(deps)).toBeUndefined();
  });

  it("counts-only — the missing-embedding WARN never carries memory content", async () => {
    mockMerge("merged");
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"], content: "SECRET FACT ABOUT ALICE" }),
      makeCand({ trustLevel: "learned", tags: ["t"], content: "ANOTHER SECRET" }),
    ]);
    const deps = makeDeps(store);
    await runMemoryConsolidation(deps);
    const warn = preconditionWarn(deps);
    expect(warn).toBeDefined();
    const serialized = JSON.stringify(warn);
    expect(serialized).not.toContain("SECRET FACT ABOUT ALICE");
    expect(serialized).not.toContain("ANOTHER SECRET");
  });
});

// ---------------------------------------------------------------------------
// Per-stage step-tagged INFO logs (cluster / apply) with durationMs.
//
// `runMemoryConsolidation` already uses step:"consolidate" on DEBUG skip-logs
// and emits a final INFO with durationMs, but NO per-stage INFO. ADD
// step:"cluster" (after clustering, candidate/cluster/sub-cluster counts) and
// step:"apply" (after a successful apply, observationsCreated) — O(1)/run lines
// at INFO per AGENTS.md §2.6. Logger-spy assertions only.
// ---------------------------------------------------------------------------
describe("runMemoryConsolidation — step-tagged stage logs", () => {
  /** The first INFO (obj) carrying the given step tag (or undefined). */
  function infoWithStep(deps: MemoryConsolidationDeps, step: string): Record<string, unknown> | undefined {
    return ((deps.logger.info as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>, string]>)
      .find(([obj]) => obj.step === step)?.[0];
  }

  it("emits an INFO step:'cluster' with candidate/cluster counts + durationMs", async () => {
    mockMerge("merged");
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    const deps = makeDeps(store);
    await runMemoryConsolidation(deps);

    const cluster = infoWithStep(deps, "cluster");
    expect(cluster).toBeDefined();
    expect(cluster?.candidates).toBe(2);
    expect(typeof cluster?.durationMs).toBe("number");
    expect(cluster?.agentId).toBe("test-agent");
  });

  it("emits an INFO step:'apply' reporting observationsCreated + durationMs", async () => {
    mockMerge("merged");
    const store = makeStore([
      makeCand({ trustLevel: "learned", tags: ["t"] }, [1, 0, 0]),
      makeCand({ trustLevel: "learned", tags: ["t"] }, [0.999, 0.001, 0]),
    ]);
    const deps = makeDeps(store);
    await runMemoryConsolidation(deps);

    const apply = infoWithStep(deps, "apply");
    expect(apply).toBeDefined();
    expect(apply?.observationsCreated).toBe(1);
    expect(typeof apply?.durationMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// GENERAL-01/02: the diversity-gated, wrapExternalContent-wrapped generalization
// synthesis pass (the §12 WS6 first-RED).
//
// When `generalize.enabled` and a sub-cluster spans >= minDistinctContexts
// distinct (sessionKey, sender) contexts, the job synthesizes EXACTLY ONE
// higher-order `semantic` MemoryEntry via the EXISTING applyConsolidation:
//   - observationKind: "generalization"
//   - trustLevel: minTrust(cluster) (the learned ceiling — NEVER raised)
//   - proofCount: cluster.length, sourceIds = the member ids (sources kept,
//     non-destructive — a NEW node, never a replacement)
//
// Below the diversity threshold (members from ONE session) → NO generalization.
// small/nano abstain (the existing gate) → NO generalization, benign. The cluster
// input is wrapExternalContent-wrapped before the synthesis LLM (SEC-01). A re-run
// over the same cluster does NOT double-create (deterministic dedup key). When
// disabled → byte-identical consolidation (no generalization MemoryEntry).
// ---------------------------------------------------------------------------
describe("runMemoryConsolidation — diversity-gated generalization synthesis (GENERAL-01/02, SEC-01)", () => {
  const NEUTRAL_CHANNEL = "telegram";

  /** A candidate in a specific (sessionKey, sender) context with a clustering embedding. */
  function candInContext(
    sessionKey: string,
    sender: string,
    id: string,
    embedding: number[],
  ): ConsolidationCandidate {
    return makeCand(
      {
        id,
        trustLevel: "learned",
        tags: ["t"],
        userId: sender,
        source: { who: sender, channel: NEUTRAL_CHANNEL, sessionKey },
      },
      embedding,
    );
  }

  /** The CREATE plans whose observation is a higher-order generalization. */
  function generalizations(store: StubStore): ConsolidationPlan[] {
    return store.applied.filter((p) => p.observation.observationKind === "generalization");
  }

  /** Three near-parallel embeddings so the members cluster into ONE sub-cluster. */
  const E1 = [1, 0, 0];
  const E2 = [0.9999, 0.0001, 0];
  const E3 = [0.9998, 0.0002, 0];

  it("synthesizes EXACTLY ONE higher-order generalization memory for a >=3 distinct-context cluster (proofCount=|cluster|, sources kept, learned ceiling)", async () => {
    mockMerge("alice prefers concise answers in general");
    const ids = [
      "00000000-0000-4000-8000-0000000003a1",
      "00000000-0000-4000-8000-0000000003a2",
      "00000000-0000-4000-8000-0000000003a3",
    ];
    // Three members, three DISTINCT sessions → distinctContexts 3 >= threshold 3.
    const store = makeStore([
      candInContext("session-a", "user_a", ids[0], E1),
      candInContext("session-b", "user_a", ids[1], E2),
      candInContext("session-c", "user_a", ids[2], E3),
    ]);
    const deps = makeDeps(store, { generalize: { enabled: true, minDistinctContexts: 3 } });
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);

    const gens = generalizations(store);
    expect(gens).toHaveLength(1);
    const obs = gens[0].observation;
    expect(obs.observationKind).toBe("generalization");
    // proofCount = |cluster| (3 members).
    expect(obs.proofCount).toBe(3);
    // Sources RETAINED + linked (non-destructive — the new node keeps its sources).
    expect([...(obs.sourceIds ?? [])].sort()).toEqual([...ids].sort());
    expect(gens[0].markConsolidated).toHaveLength(3);
    // Trust = minTrust(cluster) = learned ceiling, NEVER raised.
    expect(obs.trustLevel).toBe("learned");
    // It is a NEW semantic node (memory-generalization channel), never a replacement.
    expect(obs.source.channel).toBe("memory-generalization");
  });

  it("does NOT generalize when the SAME three members all come from ONE session (below the diversity threshold)", async () => {
    mockMerge("alice prefers concise answers in general");
    const ids = [
      "00000000-0000-4000-8000-0000000003b1",
      "00000000-0000-4000-8000-0000000003b2",
      "00000000-0000-4000-8000-0000000003b3",
    ];
    // Three members, but all ONE session → distinctContexts 1 < threshold 3.
    const store = makeStore([
      candInContext("session-a", "user_a", ids[0], E1),
      candInContext("session-a", "user_a", ids[1], E2),
      candInContext("session-a", "user_a", ids[2], E3),
    ]);
    const deps = makeDeps(store, { generalize: { enabled: true, minDistinctContexts: 3 } });
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);
    // The normal merge still fires, but NO generalization is written.
    expect(generalizations(store)).toHaveLength(0);
  });

  it("ABSTAINS on a small-capability model with no capable override — no generalization, benign (no failure inflation)", async () => {
    mockMerge("alice prefers concise answers in general");
    const store = makeStore([
      candInContext("session-a", "user_a", "00000000-0000-4000-8000-0000000003c1", E1),
      candInContext("session-b", "user_a", "00000000-0000-4000-8000-0000000003c2", E2),
      candInContext("session-c", "user_a", "00000000-0000-4000-8000-0000000003c3", E3),
    ]);
    const deps: MemoryConsolidationDeps = {
      ...makeDeps(store, { generalize: { enabled: true, minDistinctContexts: 3 } }),
      capabilityClass: "small",
      hasCapableModelOverride: false,
    };
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);
    // Abstain early-return PRECEDES the generalization pass — nothing written, no LLM call.
    expect(generalizations(store)).toHaveLength(0);
    expect(store.applied).toHaveLength(0);
    expect(completeSimple).not.toHaveBeenCalled();
    // Benign: no error log (Defer != Retry) — only the precondition WARN heartbeat.
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it("wraps the cluster input with wrapExternalContent BEFORE the synthesis LLM (SEC-01 injection boundary)", async () => {
    mockMerge("alice prefers concise answers in general");
    const store = makeStore([
      candInContext("session-a", "user_a", "00000000-0000-4000-8000-0000000003d1", E1),
      candInContext("session-b", "user_a", "00000000-0000-4000-8000-0000000003d2", E2),
      candInContext("session-c", "user_a", "00000000-0000-4000-8000-0000000003d3", E3),
    ]);
    const deps = makeDeps(store, { generalize: { enabled: true, minDistinctContexts: 3 } });
    await runMemoryConsolidation(deps);

    // The synthesis call is the SECOND completeSimple call (the first is the merge).
    // Its user message must carry the wrapExternalContent boundary sentinel.
    const calls = (completeSimple as ReturnType<typeof vi.fn>).mock.calls;
    const wrappedPrompt = calls
      .map((c) => (c[1] as { messages: { content: string }[] }).messages[0].content)
      .find((content) => content.includes("<<<UNTRUSTED_"));
    expect(wrappedPrompt).toBeDefined();
    expect(wrappedPrompt).toContain("<<<END_UNTRUSTED_");
  });

  it("does NOT double-create the same generalization on a re-run (deterministic dedup key already present)", async () => {
    mockMerge("alice prefers concise answers in general");
    const ids = [
      "00000000-0000-4000-8000-0000000003e1",
      "00000000-0000-4000-8000-0000000003e2",
      "00000000-0000-4000-8000-0000000003e3",
    ];
    // A prior-run generalization observation already covers this exact source set
    // (its deterministicDedupKey is in existingKeys) → the re-run must skip it.
    const prior = makeEntry({
      content: "alice prefers concise answers in general",
      trustLevel: "learned",
      proofCount: 3,
      sourceIds: ids,
      observationKind: "generalization",
    });
    const store = makeStore(
      [
        candInContext("session-a", "user_a", ids[0], E1),
        candInContext("session-b", "user_a", ids[1], E2),
        candInContext("session-c", "user_a", ids[2], E3),
      ],
      [prior],
    );
    const deps = makeDeps(store, { generalize: { enabled: true, minDistinctContexts: 3 } });
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);
    // No second generalization created (the source-set dedup key already exists).
    expect(generalizations(store)).toHaveLength(0);
  });

  it("is byte-identical when generalize.enabled is false (no generalization MemoryEntry, same observation count as pre-patch)", async () => {
    mockMerge("alice prefers concise answers in general");
    const store = makeStore([
      candInContext("session-a", "user_a", "00000000-0000-4000-8000-0000000003f1", E1),
      candInContext("session-b", "user_a", "00000000-0000-4000-8000-0000000003f2", E2),
      candInContext("session-c", "user_a", "00000000-0000-4000-8000-0000000003f3", E3),
    ]);
    // generalize disabled (the default) → only the normal merge observation.
    const deps = makeDeps(store, { generalize: { enabled: false, minDistinctContexts: 3 } });
    const result = await runMemoryConsolidation(deps);
    expect(result.ok).toBe(true);
    expect(generalizations(store)).toHaveLength(0);
    // Exactly one (the merge) observation — the pre-patch behavior.
    expect(store.applied).toHaveLength(1);
    expect(store.applied[0].observation.observationKind).toBeUndefined();
  });

  it("returns generalized/clustersConsidered counts on the memory:consolidated event payload", async () => {
    mockMerge("alice prefers concise answers in general");
    const store = makeStore([
      candInContext("session-a", "user_a", "00000000-0000-4000-8000-00000000040a", E1),
      candInContext("session-b", "user_a", "00000000-0000-4000-8000-00000000040b", E2),
      candInContext("session-c", "user_a", "00000000-0000-4000-8000-00000000040c", E3),
    ]);
    const deps = makeDeps(store, { generalize: { enabled: true, minDistinctContexts: 3 } });
    await runMemoryConsolidation(deps);
    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>;
    const payload = emit.mock.calls.find((c) => c[0] === "memory:consolidated")?.[1] as {
      generalized: number;
      clustersConsidered: number;
    };
    expect(payload.generalized).toBe(1);
    expect(payload.clustersConsidered).toBeGreaterThanOrEqual(1);
  });
});
