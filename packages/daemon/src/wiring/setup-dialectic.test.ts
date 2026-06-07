// SPDX-License-Identifier: Apache-2.0
/**
 * The dialectic wiring + the field-plumbing forward-presence
 * belt. `buildDialecticWiring` resolves the cheap "cron"/cheap operation model + the
 * provider apiKey BY NAME (never the value), builds the ONE query-time `createDialecticSeam`
 * + a per-agent `buildDialecticRecall` factory (the FULL `createMemoryRecall` over the
 * daemon's store set + the agent's RagConfig), and returns BOTH so `buildRpcDispatchDeps`
 * spreads them into the memory.ask handler deps.
 *
 * THE FIELD-PLUMBING LESSON: a dep can be typed
 * (MemoryApiDeps.dialecticSeam?/buildDialecticRecall?) and the handler
 * can read it, yet the construction site can DROP it — a silent no-op (typed but never
 * populated). Test 4 is the forward-presence belt: it (a) drives the REAL
 * `buildDialecticWiring` and asserts it PRODUCES a functional seam + recall builder, and
 * (b) asserts daemon.ts SPREADS the wiring into the dispatch-deps object (the construction
 * site that feeds `createMemoryHandlers`). Both must hold or the live daemon's memory.ask
 * silently abstains forever.
 *
 * NO KEY: Test 2 proves the no-key path (secretManager.get → undefined ⇒ apiKey: "" ⇒ the
 * seam degrades to abstain at call time) AND that the wiring NEVER logs a key-shaped value.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// CR-01: keep the WHOLE @comis/agent module real (resolveModelProfile,
// createMemoryRecall, resolveOperationModel, …) but wrap createDialecticSeam so
// the test can capture the R6 deps the wiring threads into it. The wrapper
// delegates to the real factory so behavior is unchanged.
const capturedSeamDeps: Array<Record<string, unknown>> = [];
vi.mock("@comis/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/agent")>();
  return {
    ...actual,
    createDialecticSeam: vi.fn((deps: Record<string, unknown>) => {
      capturedSeamDeps.push(deps);
      return actual.createDialecticSeam(deps as Parameters<typeof actual.createDialecticSeam>[0]);
    }),
  };
});

import { buildDialecticWiring } from "./setup-dialectic.js";
import { PerAgentConfigSchema, type PerAgentConfig } from "@comis/core";

const here = dirname(fileURLToPath(import.meta.url));

// --- Harness ---------------------------------------------------------------

function makeLogger(captured?: unknown[]): any {
  const sink = captured ?? [];
  const logger: any = {
    info: (o: unknown) => sink.push(o),
    warn: (o: unknown) => sink.push(o),
    error: (o: unknown) => sink.push(o),
    debug: (o: unknown) => sink.push(o),
    trace: (o: unknown) => sink.push(o),
    fatal: (o: unknown) => sink.push(o),
    child: () => logger,
  };
  return logger;
}

/** A minimal but REAL store-set slice — each store is a stub object whose presence is
 *  what the recall builder threads (createMemoryRecall does not call them at build time). */
function makeStoreSet() {
  return {
    memoryPort: { search: vi.fn(), searchLanes: undefined } as any,
    rerankerPort: undefined,
    entityStore: { listEntities: vi.fn() } as any,
    temporalStore: undefined,
    causalStore: undefined,
    tripleStore: undefined,
    embeddingStore: undefined,
    usefulnessStore: undefined,
  };
}

function makeAgentConfig(overrides?: Partial<PerAgentConfig>): PerAgentConfig {
  const base = PerAgentConfigSchema.parse({ name: "default", model: "anthropic:claude-sonnet-4-20250514", provider: "anthropic" });
  return { ...base, ...overrides } as PerAgentConfig;
}

/** secretManager that resolves (or not) a key by NAME. */
function makeSecretManager(key: string | undefined) {
  return { get: vi.fn(() => key), has: vi.fn(() => key !== undefined) } as any;
}

function makeDeps(args: {
  agentConfig?: PerAgentConfig;
  agentsConfig?: Record<string, PerAgentConfig>;
  defaultAgentId?: string;
  key?: string | undefined;
  logger?: any;
  providers?: Record<string, { apiKeyName?: string; capabilities?: { capabilityClass?: "frontier" | "mid" | "small" | "nano" } }>;
  /** The master cost-feature kill switch (opt-out posture). Defaults to true (on). */
  costFeaturesEnabled?: boolean;
}) {
  // The wiring resolves PER-AGENT. Tests may pass a single `agentConfig`
  // (keyed under "default") or a full `agentsConfig` map + `defaultAgentId`.
  const defaultAgentId = args.defaultAgentId ?? "default";
  const agentsConfig =
    args.agentsConfig ?? { [defaultAgentId]: args.agentConfig as PerAgentConfig };
  return {
    defaultAgentId,
    agentsConfig,
    secretManager: makeSecretManager(args.key),
    providers: args.providers ?? {},
    stores: makeStoreSet(),
    // The (tenant, agent) scope for the tuned-alpha read on the dialectic recall path.
    tenantId: "default",
    clock: { now: () => 1_700_000_000_000 } as any,
    timers: { setTimeout: vi.fn(), clearTimeout: vi.fn() } as any,
    logger: args.logger ?? makeLogger(),
    // Default the master kill switch ON (opt-out posture) so existing tests are unaffected.
    costFeaturesEnabled: args.costFeaturesEnabled ?? true,
  };
}

// --- Tests -----------------------------------------------------------------

describe("buildDialecticWiring (the dialectic seam + recall builder)", () => {
  it("Test 1: enabled + a resolvable key ⇒ returns { dialecticSeam, buildDialecticRecall } both functional", () => {
    const deps = makeDeps({
      agentConfig: makeAgentConfig({ dialectic: { enabled: true, maxOutputTokens: 512, maxRecall: 8 } } as any),
      key: "test-key-value",
    });
    const wiring = buildDialecticWiring(deps);

    expect(typeof wiring.dialecticSeam, "dialecticSeam is a function").toBe("function");
    expect(typeof wiring.buildDialecticRecall, "buildDialecticRecall is a function").toBe("function");

    // buildDialecticRecall(agentId) returns a real createMemoryRecall orchestrator (a
    // `.recall` method) built from the injected store set + the agent's RagConfig.
    const recall = wiring.buildDialecticRecall!("default");
    expect(typeof recall.recall, "the recall orchestrator exposes .recall()").toBe("function");
  });

  it("Test 2: no key resolves ⇒ still returns a dialecticSeam (apiKey:\"\" ⇒ abstain at call time) and NEVER logs a key shape", () => {
    const captured: unknown[] = [];
    const deps = makeDeps({
      agentConfig: makeAgentConfig({ dialectic: { enabled: true, maxOutputTokens: 1024, maxRecall: 10 } } as any),
      key: undefined, // secretManager.get → undefined
      logger: makeLogger(captured),
    });
    const wiring = buildDialecticWiring(deps);

    // The seam is STILL built (with apiKey: "") — it degrades to abstain when called, not
    // at wiring time (mirrors the cron no-key warn-and-continue, but the seam is the gate).
    expect(typeof wiring.dialecticSeam, "seam built even with no key").toBe("function");
    expect(typeof wiring.buildDialecticRecall).toBe("function");

    // The wiring NEVER logs the key value (no log field carries a key-shaped string).
    const logged = JSON.stringify(captured);
    expect(logged).not.toMatch(/sk-[A-Za-z0-9]{16,}|Bearer |apiKey"\s*:\s*"[^"]+"/);
  });

  it("Test 3: dialectic disabled for the agent ⇒ returns {} (no seam, no recall builder — the cost gate at the wiring layer)", () => {
    const deps = makeDeps({
      agentConfig: makeAgentConfig({ dialectic: { enabled: false, maxOutputTokens: 1024, maxRecall: 10 } } as any),
      key: "test-key-value",
    });
    const wiring = buildDialecticWiring(deps);
    expect(wiring.dialecticSeam, "no seam when disabled").toBeUndefined();
    expect(wiring.buildDialecticRecall, "no recall builder when disabled").toBeUndefined();
  });

  it("Test 3b: dialectic block ABSENT ⇒ schema default-ON (opt-out) ⇒ LIVE wiring", () => {
    // OPT-OUT posture: an omitted dialectic block now parses to the
    // schema default `{ enabled: true, ... }` (makeAgentConfig parses through PerAgentConfigSchema),
    // so a bare agent gets a LIVE memory_ask seam. The explicit-OFF off-path is guarded by Test 3
    // (enabled:false ⇒ {}) and the kill-switch off-path by Test 6 (costFeatures off ⇒ {}).
    const deps = makeDeps({ agentConfig: makeAgentConfig(), key: "test-key-value" });
    const wiring = buildDialecticWiring(deps);
    expect(wiring.dialecticSeam, "default-ON dialectic yields a live seam").toBeDefined();
    expect(wiring.buildDialecticRecall).toBeDefined();
  });

  it("Test 4 (forward-presence belt): the wiring PRODUCES the deps AND daemon.ts SPREADS them into the dispatch-deps object", () => {
    // (a) Runtime: an enabled agent yields BOTH populated deps (not a no-op).
    const deps = makeDeps({
      agentConfig: makeAgentConfig({ dialectic: { enabled: true, maxOutputTokens: 1024, maxRecall: 10 } } as any),
      key: "k",
    });
    const wiring = buildDialecticWiring(deps);
    expect(wiring.dialecticSeam).toBeDefined();
    expect(wiring.buildDialecticRecall).toBeDefined();

    // (b) Static: daemon.ts's buildRpcDispatchDeps must (i) call buildDialecticWiring and
    // (ii) SPREAD its result into the returned dispatch-deps object literal — the
    // construction site that feeds createMemoryHandlers. A typed-but-dropped field is the
    // exact silent no-op the field-plumbing lesson guards. We assert the source carries
    // BOTH the call and the spread (the deps object the handler reads is built here).
    const daemonSrc = readFileSync(resolve(here, "../daemon.ts"), "utf-8");
    expect(daemonSrc, "daemon.ts builds the dialectic wiring").toMatch(/buildDialecticWiring\(/);
    expect(
      daemonSrc,
      "daemon.ts SPREADS the wiring ({ dialecticSeam, buildDialecticRecall }) into the dispatch deps",
    ).toMatch(/\.\.\.dialecticWiring/);
  });

  it("Test 5: a NON-default agent with dialectic.enabled gets a LIVE seam even when the default agent is OFF", () => {
    // The default agent has the dialectic OFF; agent B has it ON. The wiring must NOT be the
    // dead `{}` (which would make agent B's registered memory_ask tool silently abstain) —
    // it must enable when ANY agent opts in.
    const deps = makeDeps({
      defaultAgentId: "default",
      agentsConfig: {
        default: makeAgentConfig({ dialectic: { enabled: false, maxOutputTokens: 1024, maxRecall: 10 } } as any),
        "agent-b": makeAgentConfig({ name: "agent-b", dialectic: { enabled: true, maxOutputTokens: 512, maxRecall: 7 } } as any),
      },
      key: "k",
    });
    const wiring = buildDialecticWiring(deps);
    expect(wiring.dialecticSeam, "seam live when a non-default agent opts in").toBeDefined();
    expect(wiring.buildDialecticRecall, "recall builder live when a non-default agent opts in").toBeDefined();
    expect(wiring.dialecticMaxRecall, "maxRecall resolver live").toBeDefined();
  });

  it("Test 5b: dialecticMaxRecall is resolved PER-AGENT (agent B's bound, not the default's)", () => {
    const deps = makeDeps({
      defaultAgentId: "default",
      agentsConfig: {
        default: makeAgentConfig({ dialectic: { enabled: true, maxOutputTokens: 1024, maxRecall: 10 } } as any),
        "agent-b": makeAgentConfig({ name: "agent-b", dialectic: { enabled: true, maxOutputTokens: 512, maxRecall: 3 } } as any),
      },
      key: "k",
    });
    const wiring = buildDialecticWiring(deps);
    // Each agent's OWN maxRecall — not the resolving/default agent's.
    expect(wiring.dialecticMaxRecall!("default")).toBe(10);
    expect(wiring.dialecticMaxRecall!("agent-b")).toBe(3);
  });

  it("Test 6 (kill switch): costFeaturesEnabled:false force-disables memory_ask wiring even when an agent has dialectic.enabled", () => {
    // The master cost-feature kill switch (opt-out posture): when the
    // operator sets memory.costFeatures.enabled:false, the dialectic (memory_ask) is the
    // ONE query-time LLM tool and is a cost-bearing feature — so the wiring must return the
    // dead {} (no seam, no recall builder ⇒ the handler abstains, the tool is not exposed)
    // EVEN THOUGH the agent's own dialectic.enabled is true. The cost switch wins over the
    // per-agent opt-in.
    const deps = makeDeps({
      agentConfig: makeAgentConfig({ dialectic: { enabled: true, maxOutputTokens: 1024, maxRecall: 10 } } as any),
      key: "test-key-value",
      costFeaturesEnabled: false,
    });
    const wiring = buildDialecticWiring(deps);
    expect(wiring.dialecticSeam, "no seam when the cost kill switch is off").toBeUndefined();
    expect(wiring.buildDialecticRecall, "no recall builder when the cost kill switch is off").toBeUndefined();
    expect(wiring.dialecticMaxRecall, "no maxRecall resolver when the cost kill switch is off").toBeUndefined();
  });

  it("Test 6b (kill switch): costFeaturesEnabled:false also force-disables a NON-default agent's enabled dialectic", () => {
    const deps = makeDeps({
      defaultAgentId: "default",
      agentsConfig: {
        default: makeAgentConfig({ dialectic: { enabled: false, maxOutputTokens: 1024, maxRecall: 10 } } as any),
        "agent-b": makeAgentConfig({ name: "agent-b", dialectic: { enabled: true, maxOutputTokens: 512, maxRecall: 7 } } as any),
      },
      key: "k",
      costFeaturesEnabled: false,
    });
    const wiring = buildDialecticWiring(deps);
    expect(wiring.dialecticSeam).toBeUndefined();
    expect(wiring.buildDialecticRecall).toBeUndefined();
  });

  it("Test 6c (kill switch on — the default): an enabled agent is UNAFFECTED (byte-identical to pre-switch)", () => {
    const deps = makeDeps({
      agentConfig: makeAgentConfig({ dialectic: { enabled: true, maxOutputTokens: 1024, maxRecall: 10 } } as any),
      key: "test-key-value",
      costFeaturesEnabled: true,
    });
    const wiring = buildDialecticWiring(deps);
    expect(wiring.dialecticSeam, "seam live when the kill switch is on").toBeDefined();
    expect(wiring.buildDialecticRecall, "recall builder live when the kill switch is on").toBeDefined();
  });

  it("Test 5c: buildDialecticRecall re-reads the CALLING agent's RagConfig (not the default's)", () => {
    // The default agent and agent B differ in rag.maxResults; building recall for agent B
    // must use agent B's rag (so its includeTrustLevels / maxResults / model are honored).
    const defaultAgent = makeAgentConfig({ dialectic: { enabled: true, maxOutputTokens: 1024, maxRecall: 10 } } as any);
    const agentB = makeAgentConfig({ name: "agent-b", dialectic: { enabled: true, maxOutputTokens: 512, maxRecall: 5 } } as any);
    // Make agent B's rag distinguishable from the default's.
    (agentB as any).rag = { ...(agentB as any).rag, maxResults: ((defaultAgent as any).rag?.maxResults ?? 5) + 11 };
    const deps = makeDeps({
      defaultAgentId: "default",
      agentsConfig: { default: defaultAgent, "agent-b": agentB },
      key: "k",
    });
    const wiring = buildDialecticWiring(deps);
    // Both build a real recall orchestrator (the per-agent rag is threaded into createMemoryRecall
    // at build time; the orchestrator exposes .recall()). The build must not throw for a
    // non-default agent (the prior code ignored the agentId param and always read the default).
    const recallDefault = wiring.buildDialecticRecall!("default");
    const recallB = wiring.buildDialecticRecall!("agent-b");
    expect(typeof recallDefault.recall).toBe("function");
    expect(typeof recallB.recall).toBe("function");
  });

  // -------------------------------------------------------------------------
  // CR-01: the dialectic seam is built with the R6 capabilityClass +
  // hasCapableModelOverride derived from the cron/memory model. Before the fix
  // neither was passed → createDialecticSeam defaulted to "frontier"/false →
  // "capable", so a small/nano model still ran the query-time synthesis call.
  // The seam is built lazily on first dialecticSeam(...) invocation.
  // -------------------------------------------------------------------------
  it("CR-01: a SMALL cron/memory model builds the seam with capabilityClass='small' + no override (abstain reachable)", async () => {
    capturedSeamDeps.length = 0;
    const deps = makeDeps({
      // An ollama agent → cron model resolves to ollama → small.
      agentConfig: makeAgentConfig({
        model: "ollama:qwen3.6:35b",
        provider: "ollama",
        dialectic: { enabled: true, maxOutputTokens: 512, maxRecall: 8 },
      } as any),
      key: "k",
    });
    const wiring = buildDialecticWiring(deps);
    // Trigger the lazy per-agent seam build.
    const result = await wiring.dialecticSeam!("default", "q?", "grounding");
    expect(capturedSeamDeps).toHaveLength(1);
    expect(capturedSeamDeps[0].capabilityClass).toBe("small");
    expect(capturedSeamDeps[0].hasCapableModelOverride).toBe(false);
    // Behavioral consequence: the seam abstains (R6) — no synthesis is produced.
    expect(result).toEqual({ abstain: true });
  });

  it("CR-01: an operator capable override on the cron provider builds the seam with hasCapableModelOverride=true", async () => {
    capturedSeamDeps.length = 0;
    const deps = makeDeps({
      agentConfig: makeAgentConfig({
        model: "ollama:qwen3.6:35b",
        provider: "ollama",
        dialectic: { enabled: true, maxOutputTokens: 512, maxRecall: 8 },
      } as any),
      key: "k",
      providers: { ollama: { capabilities: { capabilityClass: "mid" } } },
    });
    const wiring = buildDialecticWiring(deps);
    await wiring.dialecticSeam!("default", "q?", "grounding");
    expect(capturedSeamDeps).toHaveLength(1);
    expect(capturedSeamDeps[0].capabilityClass).toBe("mid");
    expect(capturedSeamDeps[0].hasCapableModelOverride).toBe(true);
  });
});
