// SPDX-License-Identifier: Apache-2.0
/**
 * `setup-tools-orchestrate-repair` — the class-gated, keyless-safe repair-seam
 * resolver. Asserts `buildOrchestrateRepairResolver`:
 *  - returns a repair closure ONLY for a repair-eligible class (small/nano) whose
 *    utility-model key resolves;
 *  - returns `undefined` for a class-gated-off (frontier/mid) agent BEFORE any
 *    model/key lookup (the class-gate short-circuits first — no strong-model cost);
 *  - resolves keyless/local providers via the sentinel key (a closure on a
 *    baseUrl-only ollama entry — the repair fires on the small local models it targets);
 *  - returns `undefined` for a keyed provider whose API key is absent (no key → no
 *    repair; Defer != Retry).
 *
 * It mirrors the outcome-judge resolver (`resolveOutcomeJudge`) — same provider/key/
 * customModel resolution — so the repair rides the same keyless-safe path.
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildOrchestrateRepairResolver,
  type OrchestrateRepairResolverDeps,
} from "./setup-tools-orchestrate-repair.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

function makeLogger() {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { child: vi.fn(() => child), ...child } as never;
}

function makeDeps(over: Partial<OrchestrateRepairResolverDeps> = {}): OrchestrateRepairResolverDeps {
  return {
    config: { providers: { entries: {} } },
    secretManager: { get: () => "sk-test" },
    clock: createFakeClock(1_700_000_000_000),
    logger: makeLogger(),
    ...over,
  };
}

describe("buildOrchestrateRepairResolver", () => {
  it("returns a repair closure for a small-class agent whose utility-model key resolves", () => {
    const resolve = buildOrchestrateRepairResolver(
      makeDeps({
        config: { providers: { entries: { anthropic: { apiKeyName: "ANTHROPIC_API_KEY" } } } },
        secretManager: { get: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined) },
      }),
    );
    const seam = resolve(
      { provider: "anthropic", model: "anthropic:claude-sonnet-4-20250514" },
      "a1",
      "small",
    );
    expect(typeof seam).toBe("function");
  });

  it("returns undefined for a frontier-class agent WITHOUT resolving a model or key (class-gate first)", () => {
    // The class-gate must short-circuit BEFORE the key lookup — a stronger model
    // pays no resolution cost and never gets a repair seam.
    const getSpy = vi.fn(() => "sk-test");
    const resolve = buildOrchestrateRepairResolver(makeDeps({ secretManager: { get: getSpy } }));
    const seam = resolve(
      { provider: "anthropic", model: "anthropic:claude-sonnet-4-20250514" },
      "a1",
      "frontier",
    );
    expect(seam).toBeUndefined();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["small", true],
    ["nano", true],
    ["mid", false],
    ["frontier", false],
  ] as const)(
    "class-gate maps capability class %s to repair-eligible=%s through the resolver",
    (capabilityClass, eligible) => {
      const resolve = buildOrchestrateRepairResolver(
        makeDeps({
          config: { providers: { entries: { anthropic: { apiKeyName: "ANTHROPIC_API_KEY" } } } },
          secretManager: { get: () => "sk-test" },
        }),
      );
      const seam = resolve(
        { provider: "anthropic", model: "anthropic:claude-sonnet-4-20250514" },
        "a1",
        capabilityClass,
      );
      expect(typeof seam === "function").toBe(eligible);
    },
  );

  it("resolves a keyless local provider via the sentinel key and returns a closure (keyless-safe)", () => {
    // A baseUrl-only ollama entry with NO real key: the keyless sentinel resolves,
    // buildCustomJudgeModelSpec supplies the custom baseUrl, and the seam is built —
    // so one-shot repair fires on the small local models it targets.
    const resolve = buildOrchestrateRepairResolver(
      makeDeps({
        config: { providers: { entries: { ollama: { type: "ollama", baseUrl: "http://localhost:11434" } } } },
        secretManager: { get: () => undefined },
      }),
    );
    const seam = resolve({ provider: "ollama", model: "ollama:qwen3.6:35b" }, "a1", "small");
    expect(typeof seam).toBe("function");
  });

  it("returns undefined for a keyed provider whose API key is absent (no key → no repair)", () => {
    const resolve = buildOrchestrateRepairResolver(
      makeDeps({
        config: { providers: { entries: { openai: { apiKeyName: "OPENAI_API_KEY" } } } },
        secretManager: { get: () => undefined },
      }),
    );
    const seam = resolve({ provider: "openai", model: "openai:gpt-4o" }, "a1", "small");
    expect(seam).toBeUndefined();
  });

  it("treats an absent agent config as the default provider and still resolves when its key is present", () => {
    // agentConfig undefined → provider defaults to anthropic; the default
    // ANTHROPIC_API_KEY resolves, so a small-class agent still gets a seam.
    const resolve = buildOrchestrateRepairResolver(
      makeDeps({ secretManager: { get: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined) } }),
    );
    const seam = resolve(undefined, "a1", "small");
    expect(typeof seam).toBe("function");
  });
});
