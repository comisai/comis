// SPDX-License-Identifier: Apache-2.0
/**
 * Audit fix — the dialectic
 * recall (`memory.ask` via `buildDialecticRecall`) must construct its `createMemoryRecall`
 * with the SAME two recall-config inputs the MAIN recall path (prompt-assembly) passes,
 * so `memory_ask` ranks IDENTICALLY to the main recall once an operator enables either feature:
 *
 *   - The `forget` gate (`rag.forget`) — prompt-assembly.ts:854 passes it.
 *     Omitted in the dialectic ⇒ no FadeMem decay on memory.ask even when `rag.forget.enabled`.
 *   - The `tunedAlphaStore` gated-read overlay — prompt-assembly.ts:803-839
 *     reads the learned 4-tuple (gated on `rag.onlineTuning.enabled` + a present store) and feeds
 *     it through `buildScoringAlphas` into the `scoring:` arg. Omitted in the dialectic ⇒ the
 *     tuned alphas never fire on memory.ask.
 *
 * Both are DEFAULT-OFF: with neither feature on, the dialectic recall config must be byte-identical
 * to today (the tuned store is NEVER read; `scoring`/`forget` are the static config values). The
 * TRUST-FREEZE (the ship-gate, belt #2) MUST hold on the dialectic path too: `scoring.trustAlpha`
 * is ALWAYS config-sourced, NEVER from the tuned vector.
 *
 * This test drives the REAL `buildDialecticWiring` and SPIES on `createMemoryRecall` (mocking
 * @comis/agent, preserving every other actual export) to inspect the exact `(deps, config)` the
 * dialectic hands it. RED before the fix (config has no `forget`; the tuned store is never read /
 * never threaded); GREEN after.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PerAgentConfigSchema, type PerAgentConfig } from "@comis/core";
import type { TunedAlphaVector } from "@comis/core";

// Spy on createMemoryRecall — capture the (deps, config) the dialectic constructs it with.
// Preserve every other real export (resolveOperationModel/resolveProviderFamily/
// createDialecticSeam/buildScoringAlphas) so the wiring builds exactly as in production.
const createMemoryRecallSpy = vi.fn(
  (_deps: unknown, _config: unknown) => ({ recall: vi.fn(async () => ({ ok: true, value: [] })) }),
);
vi.mock("@comis/agent", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createMemoryRecall: createMemoryRecallSpy };
});

// Import AFTER the mock is registered (vitest hoists vi.mock, but keep the order explicit).
const { buildDialecticWiring } = await import("./setup-dialectic.js");

// --- Harness ---------------------------------------------------------------

function makeLogger(): any {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function makeAgentConfig(ragOverrides?: Record<string, unknown>, dialecticOn = true): PerAgentConfig {
  const base = PerAgentConfigSchema.parse({
    name: "default",
    model: "anthropic:claude-sonnet-4-20250514",
    provider: "anthropic",
  });
  const cfg = {
    ...base,
    dialectic: { enabled: dialecticOn, maxOutputTokens: 512, maxRecall: 8 },
    rag: { ...(base as any).rag, ...(ragOverrides ?? {}) },
  } as PerAgentConfig;
  return cfg;
}

/** A tuned-alpha store stub whose `read` returns a learned 4-tuple (no trustAlpha — belt #1). */
function makeTunedAlphaStore(vector: TunedAlphaVector | undefined) {
  return {
    read: vi.fn(async () => ({ ok: true as const, value: vector })),
    upsert: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
}

function makeDeps(args: {
  agentConfig: PerAgentConfig;
  tunedAlphaStore?: ReturnType<typeof makeTunedAlphaStore>;
  tenantId?: string;
}) {
  return {
    defaultAgentId: "default",
    agentsConfig: { default: args.agentConfig },
    // Master cost-feature kill switch ON (the default) so the dialectic wiring is live.
    costFeaturesEnabled: true,
    secretManager: { get: vi.fn(() => "k"), has: vi.fn(() => true) } as any,
    providers: {},
    tenantId: args.tenantId ?? "tenant-a",
    stores: {
      memoryPort: { search: vi.fn(), searchLanes: undefined } as any,
      rerankerPort: undefined,
      entityStore: undefined,
      temporalStore: undefined,
      causalStore: undefined,
      tripleStore: undefined,
      embeddingStore: undefined,
      usefulnessStore: undefined,
      ...(args.tunedAlphaStore !== undefined ? { tunedAlphaStore: args.tunedAlphaStore } : {}),
    },
    clock: { now: () => 1_700_000_000_000 } as any,
    timers: { setTimeout: vi.fn(), clearTimeout: vi.fn() } as any,
    logger: makeLogger(),
  } as any;
}

const SESSION_KEY = "tenant-a:agent:default" as unknown as Parameters<
  ReturnType<NonNullable<ReturnType<typeof buildDialecticWiring>["buildDialecticRecall"]>>["recall"]
>[1];

beforeEach(() => {
  createMemoryRecallSpy.mockClear();
});

/** Run the dialectic recall once and return the config createMemoryRecall was built with. */
async function captureRecallConfig(deps: any): Promise<Record<string, any>> {
  const wiring = buildDialecticWiring(deps);
  const recall = wiring.buildDialecticRecall!("default");
  // The tuned-alpha gated read + buildScoringAlphas overlay happen at recall-call time
  // (where the tenant scope is live), so invoke .recall() to trigger the construction.
  await recall.recall("q", SESSION_KEY, "default");
  expect(createMemoryRecallSpy).toHaveBeenCalled();
  const lastCall = createMemoryRecallSpy.mock.calls.at(-1)!;
  return lastCall[1] as Record<string, any>;
}

// --- Tests -----------------------------------------------------------------

describe("dialectic recall config parity with the main recall path (audit fix)", () => {
  it("the dialectic recall config carries `forget` (the same field the main path passes at prompt-assembly.ts:854)", async () => {
    const agentConfig = makeAgentConfig();
    const config = await captureRecallConfig(makeDeps({ agentConfig }));
    // RED before the fix: setup-dialectic's createMemoryRecall config omits `forget`.
    expect(config.forget, "the dialectic must thread rag.forget into recall").toBeDefined();
    expect(config.forget).toEqual((agentConfig as any).rag.forget);
  });

  it("with onlineTuning EXPLICITLY OFF the tuned store is NEVER read and `scoring` is the static config (byte-identical)", async () => {
    // rag.onlineTuning now defaults ON (opt-out posture), so the OFF-path
    // guard must construct the OFF state EXPLICITLY. With onlineTuning:false the dialectic recall
    // must NOT read the tuned-alpha store and `scoring` stays the unchanged static config.
    const tunedAlphaStore = makeTunedAlphaStore({
      recencyAlpha: 0.9,
      temporalAlpha: 0.9,
      proofAlpha: 0.9,
      usefulnessAlpha: 0.9,
    });
    const agentConfig = makeAgentConfig({ onlineTuning: { enabled: false } }); // EXPLICIT OFF
    const config = await captureRecallConfig(makeDeps({ agentConfig, tunedAlphaStore }));
    expect(tunedAlphaStore.read, "tuned store NOT read when onlineTuning is OFF").not.toHaveBeenCalled();
    expect(config.scoring, "scoring is the unchanged static config when tuning OFF").toEqual(
      (agentConfig as any).rag.scoring,
    );
  });

  it("with onlineTuning ON + a tuned row, the four non-trust alphas come from the tuned vector (consistent with the main path)", async () => {
    const tuned: TunedAlphaVector = {
      recencyAlpha: 0.85,
      temporalAlpha: 0.75,
      proofAlpha: 0.65,
      usefulnessAlpha: 0.55,
    };
    const tunedAlphaStore = makeTunedAlphaStore(tuned);
    const agentConfig = makeAgentConfig({ onlineTuning: { enabled: true } });
    const config = await captureRecallConfig(makeDeps({ agentConfig, tunedAlphaStore, tenantId: "tenant-z" }));

    // The gated read fires, SCOPED to (tenant, agent).
    expect(tunedAlphaStore.read).toHaveBeenCalledWith({ tenantId: "tenant-z", agentId: "default" });
    // The four learned non-trust alphas overlay the static config.
    expect(config.scoring.recencyAlpha).toBe(tuned.recencyAlpha);
    expect(config.scoring.temporalAlpha).toBe(tuned.temporalAlpha);
    expect(config.scoring.proofAlpha).toBe(tuned.proofAlpha);
    expect(config.scoring.usefulnessAlpha).toBe(tuned.usefulnessAlpha);
  });

  it("TRUST-FREEZE (belt #2): trustAlpha STAYS config-sourced on the dialectic path even when the tuned overlay fires", async () => {
    const tuned: TunedAlphaVector = {
      recencyAlpha: 0.99,
      temporalAlpha: 0.99,
      proofAlpha: 0.99,
      usefulnessAlpha: 0.99,
    };
    const tunedAlphaStore = makeTunedAlphaStore(tuned);
    // Give the config a DISTINCT trustAlpha so we can prove it is NOT moved by the tuned overlay.
    const agentConfig = makeAgentConfig({
      onlineTuning: { enabled: true },
      scoring: {
        recencyAlpha: 0.2,
        temporalAlpha: 0.2,
        proofAlpha: 0.1,
        trustAlpha: 0.37,
        usefulnessAlpha: 0.1,
        forgetAlpha: 0.1,
      },
    });
    const config = await captureRecallConfig(makeDeps({ agentConfig, tunedAlphaStore }));
    // trustAlpha is the CONFIG value (0.37), never one of the tuned 0.99s — the bandit cannot move trust.
    expect(config.scoring.trustAlpha, "trustAlpha frozen to config on the dialectic path").toBe(0.37);
    // forgetAlpha likewise config-sourced (the tuned 4-tuple has no forget dimension).
    expect(config.scoring.forgetAlpha).toBe(0.1);
  });

  it("onlineTuning ON but NO tunedAlphaStore dep ⇒ scoring stays config (no crash; default-OFF byte-identity)", async () => {
    const agentConfig = makeAgentConfig({ onlineTuning: { enabled: true } });
    const config = await captureRecallConfig(makeDeps({ agentConfig })); // no tunedAlphaStore
    expect(config.scoring).toEqual((agentConfig as any).rag.scoring);
  });
});
