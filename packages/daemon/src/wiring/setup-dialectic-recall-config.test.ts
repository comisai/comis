// SPDX-License-Identifier: Apache-2.0
/**
 * The dialectic recall (`memory.ask` via `buildDialecticRecall`) must construct its
 * `createMemoryRecall` with the SAME recall-config inputs the MAIN recall path
 * (prompt-assembly) passes, so `memory_ask` ranks IDENTICALLY to the main recall:
 *
 *   - The `forget` gate (`rag.forget`) — prompt-assembly.ts passes it.
 *     Omitted in the dialectic ⇒ no FadeMem decay on memory.ask even when `rag.forget.enabled`.
 *   - Recall scoring is the FIXED `rag.scoring` alphas. There is no UCB tuned-alpha
 *     bandit or overlay, so the dialectic path — like the main path — applies
 *     the config-sourced alphas only. There is no learned-weight read on memory.ask.
 *
 * This test drives the REAL `buildDialecticWiring` and SPIES on `createMemoryRecall` (mocking
 * @comis/agent, preserving every other actual export) to inspect the exact `(deps, config)` the
 * dialectic hands it.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PerAgentConfigSchema, type PerAgentConfig } from "@comis/core";

// Spy on createMemoryRecall — capture the (deps, config) the dialectic constructs it with.
// Preserve every other real export so the wiring builds exactly as in production.
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

function makeDeps(args: { agentConfig: PerAgentConfig; tenantId?: string }) {
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
  await recall.recall("q", SESSION_KEY, "default");
  expect(createMemoryRecallSpy).toHaveBeenCalled();
  const lastCall = createMemoryRecallSpy.mock.calls.at(-1)!;
  return lastCall[1] as Record<string, any>;
}

// --- Tests -----------------------------------------------------------------

describe("dialectic recall config parity with the main recall path", () => {
  it("the dialectic recall config carries `forget` (the same field the main path passes)", async () => {
    const agentConfig = makeAgentConfig();
    const config = await captureRecallConfig(makeDeps({ agentConfig }));
    expect(config.forget, "the dialectic must thread rag.forget into recall").toBeDefined();
    expect(config.forget).toEqual((agentConfig as any).rag.forget);
  });

  it("scoring is the FIXED config.rag.scoring alphas — no bandit overlay exists on the dialectic path", async () => {
    // No tuned-alpha read, no overlay: the dialectic recall passes rag.scoring straight through,
    // by OBJECT IDENTITY (the same reference the config holds) — exactly like the main path.
    const agentConfig = makeAgentConfig();
    const config = await captureRecallConfig(makeDeps({ agentConfig }));
    expect(config.scoring).toBe((agentConfig as any).rag.scoring);
  });

  it("a distinct trustAlpha in config is preserved verbatim on the dialectic path (no learned weight can move it)", async () => {
    const agentConfig = makeAgentConfig({
      scoring: {
        recencyAlpha: 0.2,
        temporalAlpha: 0.2,
        proofAlpha: 0.1,
        trustAlpha: 0.37,
        usefulnessAlpha: 0.1,
        forgetAlpha: 0.1,
      },
    });
    const config = await captureRecallConfig(makeDeps({ agentConfig }));
    expect(config.scoring.trustAlpha).toBe(0.37);
    expect(config.scoring.forgetAlpha).toBe(0.1);
  });
});
