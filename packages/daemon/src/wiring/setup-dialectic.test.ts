// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 109 (DIAL-01/02) — the dialectic wiring + the field-plumbing forward-presence
 * belt. `buildDialecticWiring` resolves the cheap "cron"/cheap operation model + the
 * provider apiKey BY NAME (never the value), builds the ONE query-time `createDialecticSeam`
 * + a per-agent `buildDialecticRecall` factory (the FULL `createMemoryRecall` over the
 * daemon's store set + the agent's RagConfig), and returns BOTH so `buildRpcDispatchDeps`
 * spreads them into the memory.ask handler deps.
 *
 * THE FIELD-PLUMBING LESSON (the carried 107-VERIFICATION blocker): a dep can be typed
 * (MemoryApiDeps.dialecticSeam?/buildDialecticRecall?, added in Plan 03) and the handler
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
  agentConfig: PerAgentConfig;
  key?: string | undefined;
  logger?: any;
  providers?: Record<string, { apiKeyName?: string }>;
}) {
  return {
    agentId: "default",
    agentConfig: args.agentConfig,
    secretManager: makeSecretManager(args.key),
    providers: args.providers ?? {},
    stores: makeStoreSet(),
    clock: { now: () => 1_700_000_000_000 } as any,
    timers: { setTimeout: vi.fn(), clearTimeout: vi.fn() } as any,
    logger: args.logger ?? makeLogger(),
  };
}

// --- Tests -----------------------------------------------------------------

describe("buildDialecticWiring (Phase 109 — the dialectic seam + recall builder)", () => {
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

  it("Test 3b: dialectic block ABSENT entirely ⇒ returns {} (default-OFF byte-identity)", () => {
    const deps = makeDeps({ agentConfig: makeAgentConfig(), key: "test-key-value" });
    const wiring = buildDialecticWiring(deps);
    expect(wiring.dialecticSeam).toBeUndefined();
    expect(wiring.buildDialecticRecall).toBeUndefined();
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
});
