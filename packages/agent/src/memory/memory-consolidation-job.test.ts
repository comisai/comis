// SPDX-License-Identifier: Apache-2.0
//
// Orchestration suite for runMemoryConsolidation (Phase 84 — CONS-01/02/04/06/07).
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
    ...overrides,
  };
}

interface StubStore extends MemoryConsolidationStore {
  applied: ConsolidationPlan[];
}

/** A stub store capturing applyConsolidation plans + serving fixed candidates/observations. */
function makeStore(
  candidates: ConsolidationCandidate[],
  observations: MemoryEntry[] = [],
): StubStore {
  const applied: ConsolidationPlan[] = [];
  return {
    applied,
    listConsolidationCandidates: vi.fn().mockResolvedValue(ok(candidates)),
    listObservations: vi.fn().mockResolvedValue(ok(observations)),
    applyConsolidation: vi.fn(async (plan: ConsolidationPlan) => {
      applied.push(plan);
      return ok(plan.observation);
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

describe("runMemoryConsolidation — trust ceiling end-to-end (CONS-02, the escalation guard)", () => {
  it("a homogeneous external cluster mints an external observation (ceiling = min(sources) = external)", async () => {
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

  it("a [learned, learned] cluster mints a learned observation", async () => {
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
    // the two are never combined (CONS-06 + CONS-02).
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

describe("runMemoryConsolidation — external excluded by default (CONS-02)", () => {
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

describe("runMemoryConsolidation — no trust/tag mix per LLM call (CONS-06)", () => {
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

describe("runMemoryConsolidation — deterministic dedup pre-check (CONS-04)", () => {
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

describe("runMemoryConsolidation — bounded run + minimal event (CONS-07)", () => {
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

  it("carries proofCount and sourceIds on the created observation (CONS-01)", async () => {
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
