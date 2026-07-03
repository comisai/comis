// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor tests for the LLM-judge conversational-breadth fallback
 * (`maybeUpgradeWithJudge`), extracted into its own leaf to keep setup-learning.ts /
 * setup-learning-reactions.ts under the 800-line cap. Pins: upgrade-on-unknown,
 * skip-on-resolved, byte-identical-when-disabled/absent, and non-fatal-on-throw.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { buildOutcomeJudgeWiring, maybeUpgradeWithJudge } from "./setup-learning-judge.js";

const NOW = 1_700_000_000_000;
const TENANT = "tenant-x";
const TRACE = "trace-judge-001";

const SCOPE = { tenantId: "t", agentId: "a", sessionId: "s", trajectoryId: "traj" };
const noopLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
const clock = { now: () => 1000 } as never;
const UNKNOWN = { outcome: "unknown" as const, confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] };

describe("maybeUpgradeWithJudge — conversational-breadth fallback", () => {
  it("upgrades an UNKNOWN verdict to the judge's success (observe source:judge + re-resolve)", async () => {
    const observe = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const resolve = vi.fn(async () => ({ ok: true as const, value: { outcome: "success" as const, confidence: 0.7, sources: ["judge" as const], recalledIds: [], usedSkillIds: [] } }));
    const outcomeJudge = vi.fn(async () => ({ outcome: "success" as const, cappedConfidence: 0.7 }));
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe, resolve } as never, clock, logger: noopLogger, outcomeJudge: outcomeJudge as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "user asked X; assistant satisfied it" },
      SCOPE,
      UNKNOWN,
    );
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ source: "judge", outcome: "success", confidence: 0.7 }));
    expect(resolve).toHaveBeenCalled();
    expect(r.outcome).toBe("success");
  });

  it("does NOT run the judge for an already-resolved (non-unknown) verdict", async () => {
    const outcomeJudge = vi.fn();
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe: vi.fn(), resolve: vi.fn() } as never, clock, logger: noopLogger, outcomeJudge: outcomeJudge as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
      SCOPE,
      { ...UNKNOWN, outcome: "success" as const },
    );
    expect(outcomeJudge).not.toHaveBeenCalled();
    expect(r.outcome).toBe("success");
  });

  it("is byte-identical (keeps unknown, no observe) when the judge is disabled or absent", async () => {
    const observe = vi.fn();
    const disabled = await maybeUpgradeWithJudge(
      { outcomeStore: { observe, resolve: vi.fn() } as never, clock, logger: noopLogger, outcomeJudge: (async () => ({ outcome: "success" as const, cappedConfidence: 0.7 })) as never, learningOutcomeJudgeEnabled: () => false, readTurnTranscript: () => "x" },
      SCOPE,
      UNKNOWN,
    );
    expect(disabled.outcome).toBe("unknown");
    const absent = await maybeUpgradeWithJudge({ outcomeStore: { observe, resolve: vi.fn() } as never, clock, logger: noopLogger }, SCOPE, UNKNOWN);
    expect(absent.outcome).toBe("unknown");
    expect(observe).not.toHaveBeenCalled();
  });

  it("keeps unknown + WARNs (non-fatal) when the judge throws", async () => {
    const warn = vi.fn();
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe: vi.fn(), resolve: vi.fn() } as never, clock, logger: { ...noopLogger, warn } as never, outcomeJudge: (async () => { throw new Error("model down"); }) as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
      SCOPE,
      UNKNOWN,
    );
    expect(r.outcome).toBe("unknown");
    expect(warn).toHaveBeenCalled();
  });

  it("an empty transcript → the judge never runs, verdict stays unknown", async () => {
    const outcomeJudge = vi.fn(async () => ({ outcome: "success" as const, cappedConfidence: 0.7 }));
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe: vi.fn(), resolve: vi.fn() } as never, clock, logger: noopLogger, outcomeJudge: outcomeJudge as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "" },
      SCOPE,
      UNKNOWN,
    );
    expect(outcomeJudge).not.toHaveBeenCalled();
    expect(r.outcome).toBe("unknown");
  });

  it("a judge abstention (unknown) → no observe, no re-resolve, verdict stays unknown", async () => {
    const observe = vi.fn();
    const resolve = vi.fn();
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe, resolve } as never, clock, logger: noopLogger, outcomeJudge: (async () => ({ outcome: "unknown" as const, cappedConfidence: 0 })) as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
      SCOPE,
      UNKNOWN,
    );
    expect(observe).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(r.outcome).toBe("unknown");
  });

  it("an observe that returns err → keep unknown, no re-resolve (no fusion over a no-op write)", async () => {
    const observe = vi.fn(async () => ({ ok: false as const, error: new Error("db locked") }));
    const resolve = vi.fn();
    const r = await maybeUpgradeWithJudge(
      { outcomeStore: { observe, resolve } as never, clock, logger: noopLogger, outcomeJudge: (async () => ({ outcome: "success" as const, cappedConfidence: 0.7 })) as never, learningOutcomeJudgeEnabled: () => true, readTurnTranscript: () => "x" },
      SCOPE,
      UNKNOWN,
    );
    expect(observe).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(r.outcome).toBe("unknown");
  });
});

// ===========================================================================
// buildOutcomeJudgeWiring — daemon construction behind the byte-identity gate
// ===========================================================================

describe("buildOutcomeJudgeWiring — daemon construction behind the byte-identity gate", () => {
  function makeContainer(over: { agents?: Record<string, unknown>; costFeatures?: boolean; secrets?: Record<string, string>; entries?: Record<string, unknown> } = {}) {
    const secrets = over.secrets ?? {};
    return {
      config: {
        agents: over.agents ?? {},
        // The master kill-switch is `memory.enabled`.
        memory: { enabled: over.costFeatures ?? true },
        providers: { entries: over.entries ?? {} },
      },
      secretManager: { get: (name: string): string | undefined => secrets[name] },
    } as never;
  }

  /** A stub LCD store returning one user + one assistant text message for any scope. */
  function makeLcdStore() {
    return {
      getMessages: vi.fn(() => [
        { role: "user", parts: [{ kind: "text", metadata: { raw: { text: "please summarize" } } }] },
        { role: "assistant", parts: [{ kind: "text", metadata: { raw: { text: "here is the summary" } } }] },
      ]),
    } as never;
  }

  it("KEYLESS-CUSTOM-NAME: a custom-NAMED keyless provider (type: ollama) BUILDS the judge keyless (not a no-op)", () => {
    // A local keyless daemon (e.g. qwen3.6:35b) exposes the bug: keyless was checked by provider NAME,
    // but KEYLESS_PROVIDER_TYPES holds TYPEs. A user-named ollama entry failed the check → no apiKey →
    // resolveOutcomeJudge returned undefined → the outcome judge was a silent no-op on a local keyless
    // daemon. The completion path keys keyless-ness off entry.type, so this must too.
    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { default: { provider: "local-ollama", model: "qwen3.6:35b", learningOutcome: { enabled: true, judge: { enabled: true } } } },
        entries: { "local-ollama": { type: "ollama", baseUrl: "http://localhost:11434", models: [{ id: "qwen3.6:35b" }] } },
        secrets: {},
      }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.outcomeJudge).toBeDefined(); // keyless-by-name would leave this undefined → the silent no-op
  });

  it("byte-identity: NO agent has the judge on → outcomeJudge + readTurnTranscript are undefined (no construction)", () => {
    const built = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true, judge: { enabled: false } } } } }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.outcomeJudge).toBeUndefined();
    expect(built.readTurnTranscript).toBeUndefined();
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(false);
  });

  it("the judge gate requires learningOutcome.enabled AND judge.enabled AND the master cost switch", () => {
    const offOutcome = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: false, judge: { enabled: true } } } } }),
      createFakeClock(NOW),
      createMockLogger(),
    );
    expect(offOutcome.learningOutcomeJudgeEnabled("a1")).toBe(false);
    const costOff = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true, judge: { enabled: true } } } }, costFeatures: false }),
      createFakeClock(NOW),
      createMockLogger(),
    );
    expect(costOff.learningOutcomeJudgeEnabled("a1")).toBe(false);
  });

  it("is DEFAULT-ON (opt-out): a present-but-partial learningOutcome with NO judge field still enables + builds the judge", () => {
    // live-2026-06-18: the daemon config-load does not materialize the nested `judge`
    // default for an explicit `{enabled:true}` learningOutcome (judge stays undefined),
    // so the gate must read undefined as ON (`!== false`). With the old `=== true` gate
    // this was false and the judge never fired by default — the regression this pins.
    const built = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true } } }, secrets: { ANTHROPIC_API_KEY: "sk-test" } }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(true);
    expect(built.outcomeJudge).toBeDefined();
    expect(built.readTurnTranscript).toBeDefined();
  });

  it("opt-out: an EXPLICIT judge.enabled:false disables it even when learningOutcome is on", () => {
    const built = buildOutcomeJudgeWiring(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true, judge: { enabled: false } } } }, secrets: { ANTHROPIC_API_KEY: "sk-test" } }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(false);
  });

  it("the judge seam is UNDEFINED when judge.enabled but the cheap-model API key is missing (Defer != Retry)", () => {
    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { a1: { provider: "anthropic", learningOutcome: { enabled: true, judge: { enabled: true } } } },
        secrets: {},
      }),
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    expect(built.outcomeJudge).toBeUndefined();
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(true);
  });

  it("the judge seam is BUILT and readTurnTranscript reads the LCD transcript when judge.enabled AND a cheap-model key resolves", () => {
    const lcd = makeLcdStore();
    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { a1: { provider: "anthropic", learningOutcome: { enabled: true, judge: { enabled: true } } } },
        secrets: { ANTHROPIC_API_KEY: "sk-test-key" },
      }),
      createFakeClock(NOW),
      createMockLogger(),
      lcd,
    );
    expect(typeof built.outcomeJudge).toBe("function");
    expect(typeof built.readTurnTranscript).toBe("function");
    const transcript = built.readTurnTranscript!({ tenantId: TENANT, agentId: "a1", sessionId: "sess-1", trajectoryId: TRACE });
    expect(lcd.getMessages).toHaveBeenCalledWith({ conversationId: "sess-1", tenantId: TENANT, agentId: "a1", sessionKey: "sess-1" });
    expect(transcript).toBe("user: please summarize\nassistant: here is the summary");
  });

  it("readTurnTranscript returns undefined for a conversation with no messages (the judge then never runs)", () => {
    const emptyLcd = { getMessages: vi.fn(() => []) } as never;
    const built = buildOutcomeJudgeWiring(
      makeContainer({
        agents: { a1: { provider: "anthropic", learningOutcome: { enabled: true, judge: { enabled: true } } } },
        secrets: { ANTHROPIC_API_KEY: "sk-test-key" },
      }),
      createFakeClock(NOW),
      createMockLogger(),
      emptyLcd,
    );
    expect(built.readTurnTranscript!({ tenantId: TENANT, agentId: "a1", sessionId: "sess-1", trajectoryId: TRACE })).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The master kill-switch `memory.enabled` MUST NOT silently invert the gate.
  // A LOOSE local slice type (e.g. `memory?: { costFeatures?: { enabled?: boolean } }`)
  // would let a config carrying ONLY `memory.enabled:false` read a missing key as
  // `undefined !== false === true` → FORCE-ENABLED (the kill-switch inverts), and
  // tsc would NOT catch it (a loose optional type tolerates the missing key). This
  // test pins the correct behavior (force-DISABLE on memory.enabled:false); the
  // local slice points at the real MemoryConfig type so tsc enforces it, and this
  // explicit guard is the belt.
  // -------------------------------------------------------------------------
  it("memory.enabled:false (the master kill-switch) force-DISABLES the judge for every agent", () => {
    const built = buildOutcomeJudgeWiring(
      // The NEW shape: memory.enabled is the master gate; NO costFeatures key exists.
      {
        config: {
          agents: { a1: { learningOutcome: { enabled: true, judge: { enabled: true } } } },
          memory: { enabled: false },
          providers: { entries: {} },
        },
        secretManager: { get: (): string | undefined => undefined },
      } as never,
      createFakeClock(NOW),
      createMockLogger(),
      makeLcdStore(),
    );
    // The master kill-switch is OFF → the judge gate must be closed for every agent.
    // (A loose slice type would misread this as force-ENABLED — the fail-open this guards against.)
    expect(built.learningOutcomeJudgeEnabled("a1")).toBe(false);
    // And byte-identity: no seam/reader is constructed when the master switch is off.
    expect(built.outcomeJudge).toBeUndefined();
    expect(built.readTurnTranscript).toBeUndefined();
  });
});
